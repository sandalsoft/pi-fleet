import fs from 'node:fs/promises'
import path from 'node:path'
import pLimit from 'p-limit'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import type { Team } from '../config/schema.js'
import type { AgentDefinition } from '../config/schema.js'
import type { EventLogWriter } from '../session/event-log.js'
import type { FleetState } from '../session/state.js'
import { createFleetEvent } from '../session/events.js'
import type {
	SessionStartEvent,
	TaskGraphCreatedEvent,
	SpecialistStartedEvent,
	SpecialistCompletedEvent,
	SpecialistFailedEvent,
} from '../session/events.js'
import { setFleetState } from '../session/runtime-store.js'
import { reduceEvent } from '../session/state.js'
import type {
	TaskAssignment,
	SpecialistRuntime,
	SmokeResults,
} from './types.js'
import { buildTaskGraph, computeWaves } from './task-graph.js'
import { spawnSpecialist, readSmokeResults } from './spawner.js'
import { composePrompt } from './prompt-composer.js'
import { consolidateReports, type SpecialistReport } from './consolidator.js'

export interface DispatcherOpts {
	pi: ExtensionAPI
	ctx: ExtensionCommandContext
	team: Team
	agents: AgentDefinition[]
	assignments: TaskAssignment[]
	dependencies: Record<string, string[]>
	repoRoot: string
	eventLog: EventLogWriter
	state: FleetState
	cancelSignal?: AbortSignal
}

export interface DispatchResult {
	state: FleetState
	summary: string
	failedAgents: string[]
}

/**
 * Main dispatcher orchestration loop.
 *
 * 1. Record base commit SHA
 * 2. Build task graph and compute execution waves
 * 3. For each wave: spawn specialists in parallel (bounded by maxConcurrency),
 *    track SpecialistRuntime entries in FleetState, wait for completion
 * 4. Handle failures (non-blocking)
 * 5. Consolidate results
 */
export async function dispatch(opts: DispatcherOpts): Promise<DispatchResult> {
	const {
		pi,
		ctx,
		team,
		agents,
		assignments,
		dependencies,
		repoRoot,
		eventLog,
		cancelSignal,
	} = opts
	let { state } = opts

	// 1. Record base commit SHA
	const headResult = await pi.exec('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])
	const baseSha = headResult.stdout.trim()

	// Emit session_start
	const sessionStartEvent = createFleetEvent<SessionStartEvent>({
		type: 'session_start',
		startedAt: new Date().toISOString(),
		repoRoot,
		baseSha,
		constraints: team.constraints,
	})
	await eventLog.append(sessionStartEvent)
	state = reduceEvent(state, sessionStartEvent)
	setFleetState(state)

	// 2. Build task graph and compute waves
	const graph = buildTaskGraph(assignments, dependencies)
	const waves = computeWaves(graph)

	const taskGraphEvent = createFleetEvent<TaskGraphCreatedEvent>({
		type: 'task_graph_created',
		taskCount: assignments.length,
		waveCount: waves.length,
	})
	await eventLog.append(taskGraphEvent)
	state = reduceEvent(state, taskGraphEvent)
	setFleetState(state)

	ctx.ui.setWorkingMessage(
		`Executing ${waves.length} wave(s) with ${assignments.length} task(s)...`
	)

	// Read smoke results once for scratchpad routing
	const smokeResults = await readSmokeResults(repoRoot)
	const scratchpadDir = resolveScratchpadDir(repoRoot, smokeResults)
	await ensureScratchpadDir(scratchpadDir)

	// Agent lookup by name
	const agentMap = new Map<string, AgentDefinition>()
	for (const agent of agents) {
		agentMap.set(agent.frontmatter.name, agent)
		agentMap.set(agent.id, agent)
	}

	const allReports: SpecialistReport[] = []
	const runtimes = new Map<string, SpecialistRuntime>()
	const limit = pLimit(team.constraints.maxConcurrency)

	// 3. Execute waves
	for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
		const wave = waves[waveIdx]
		ctx.ui.setWorkingMessage(
			`Wave ${waveIdx + 1}/${waves.length}: launching ${wave.length} agent(s)...`
		)

		const wavePromises = wave.map((assignment) =>
			limit(async () => {
				const agent = agentMap.get(assignment.agentName)
				if (!agent) {
					throw new Error(`Agent definition not found: ${assignment.agentName}`)
				}

				const model = assignment.model ?? agent.frontmatter.model
				const prompt = await composePrompt({
					agent,
					taskBrief: assignment.brief,
					repoRoot,
					scratchpadDir,
				})

				// We need a worktree path — for now, use the repoRoot.
				// The /fleet handler in extension.ts will wire up the pool.
				// The dispatcher accepts pre-set worktreePath from the assignment
				// or falls back to repoRoot for testing purposes.
				const worktreePath = assignment.expectedPaths.length > 0
					? repoRoot
					: repoRoot

				const result = await spawnSpecialist({
					agentName: assignment.agentName,
					model,
					worktreePath,
					prompt,
					timeoutMs: team.constraints.taskTimeoutMs,
					repoRoot,
					cancelSignal,
				})

				runtimes.set(assignment.agentName, result.runtime)

				// Emit specialist_started
				const startedEvent = createFleetEvent<SpecialistStartedEvent>({
					type: 'specialist_started',
					agentName: assignment.agentName,
					runId: result.runtime.runId,
					pid: result.runtime.pid,
					worktreePath: result.runtime.worktreePath,
					model,
				})
				await eventLog.append(startedEvent)
				state = reduceEvent(state, startedEvent)
				setFleetState(state)

				// Emit completion or failure
				if (result.runtime.status === 'completed') {
					const completedEvent = createFleetEvent<SpecialistCompletedEvent>({
						type: 'specialist_completed',
						agentName: assignment.agentName,
						runId: result.runtime.runId,
					})
					await eventLog.append(completedEvent)
					state = reduceEvent(state, completedEvent)
				} else {
					const failedEvent = createFleetEvent<SpecialistFailedEvent>({
						type: 'specialist_failed',
						agentName: assignment.agentName,
						runId: result.runtime.runId,
						error: `Process exited with non-zero code`,
					})
					await eventLog.append(failedEvent)
					state = reduceEvent(state, failedEvent)
				}
				setFleetState(state)

				return {
					agentName: assignment.agentName,
					report: result.report,
					usage: result.usage,
					status: result.runtime.status as 'completed' | 'failed',
				} satisfies SpecialistReport
			})
		)

		const waveReports = await Promise.allSettled(wavePromises)

		for (const result of waveReports) {
			if (result.status === 'fulfilled') {
				allReports.push(result.value)
			} else {
				// Unhandled spawn error — non-blocking, log and continue
				console.warn('[pi-fleet] Specialist spawn error:', result.reason)
			}
		}
	}

	// 4. Consolidate
	const consolidation = consolidateReports(allReports)

	ctx.ui.setWorkingMessage('')

	return {
		state,
		summary: consolidation.summary,
		failedAgents: consolidation.failedAgents,
	}
}

/**
 * Determine the scratchpad directory based on smoke results.
 * If cross-dir writes are allowed (default), use the main repo's scratchpads.
 */
function resolveScratchpadDir(
	repoRoot: string,
	smokeResults: SmokeResults | null
): string {
	const canWriteCrossDir = smokeResults?.canWriteToRepoScratchpadFromSiblingCwd !== false
	if (canWriteCrossDir) {
		return path.join(repoRoot, '.pi', 'scratchpads')
	}
	// Fallback: worktree-local scratchpads (handled per-spawn)
	return path.join(repoRoot, '.pi', 'scratchpads')
}

async function ensureScratchpadDir(dir: string): Promise<void> {
	try {
		await fs.mkdir(dir, { recursive: true })
	} catch {
		// Non-fatal: scratchpad dir creation may fail in some environments
	}
}
