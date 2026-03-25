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
	CostUpdateEvent,
} from '../session/events.js'
import { setFleetState } from '../session/runtime-store.js'
import { reduceEvent, resetAgentCost } from '../session/state.js'
import type {
	TaskAssignment,
	SpecialistRuntime,
	SmokeResults,
} from './types.js'
import { buildTaskGraph, computeWaves } from './task-graph.js'
import { spawnSpecialist, readSmokeResults, extractActivity, extractStreamingUsage } from './spawner.js'
import { calculateCost } from '../resources/pricing.js'
import { analyzeFailure } from './failure-analyzer.js'
import { ActivityStore } from '../status/activity-store.js'
import { composePrompt } from './prompt-composer.js'
import { consolidateReports, type SpecialistReport } from './consolidator.js'
import { updateProgressWidget } from '../status/display.js'
import { AgentLogger } from './agent-logger.js'

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
	/** If provided, acquire worktrees from this pool instead of using repoRoot */
	acquireWorktree?: (agentName: string) => Promise<{ worktreePath: string; branch: string }>
	/** If provided, release worktree back to pool */
	releaseWorktree?: (worktreePath: string) => void
	/** Called with usage data after each specialist completes */
	onUsage?: (agentName: string, model: string, usage: import('./types.js').Usage) => void
	/** LLM model for failure analysis. If provided, failed agents get an LLM-generated diagnosis. */
	analysisModel?: import('@mariozechner/pi-ai').Model<any>
	/** If provided, per-agent JSONL/stderr/meta logs are written to this directory. */
	logDir?: string
}

export interface DispatchResult {
	state: FleetState
	summary: string
	failedAgents: string[]
	/** Branches from completed specialists that can be merged */
	completedBranches: Array<{ agentName: string; branch: string }>
	/** Error messages keyed by agent name (for failed agents). */
	errors: Map<string, string>
	/** Repo-relative log file paths keyed by agent name (for failed agents with logs). */
	logPaths: Map<string, string>
	/** Activity history store for /fleet-log. */
	activityStore: ActivityStore
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
		acquireWorktree,
		releaseWorktree,
		onUsage,
		analysisModel,
		logDir,
	} = opts
	let { state } = opts

	/** Per-agent activity history with dedup. */
	const activityStore = new ActivityStore()
	/** Per-agent error messages for failed agents. */
	const errors = new Map<string, string>()
	/** Per-agent repo-relative log file paths for failed agents. */
	const logPaths = new Map<string, string>()
	/** Per-agent loggers for persistent JSONL capture. */
	const loggers = new Map<string, AgentLogger>()

	/** Throttle: minimum ms between widget renders. */
	const THROTTLE_MS = 200
	let lastRenderTime = 0

	/** Update state and refresh the progress widget (always renders). */
	function commitState(s: FleetState): void {
		state = s
		setFleetState(state)
		lastRenderTime = Date.now()
		updateProgressWidget(ctx, state, activityStore, undefined, errors, logPaths)
	}

	/** Refresh the widget without a state change. Throttled to ~5 renders/sec. */
	function refreshWidget(): void {
		const now = Date.now()
		if (now - lastRenderTime < THROTTLE_MS) return
		lastRenderTime = now
		updateProgressWidget(ctx, state, activityStore, undefined, errors, logPaths)
	}

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
	commitState(reduceEvent(state, sessionStartEvent))

	// 2. Build task graph and compute waves
	const graph = buildTaskGraph(assignments, dependencies)
	const waves = computeWaves(graph)

	const taskGraphEvent = createFleetEvent<TaskGraphCreatedEvent>({
		type: 'task_graph_created',
		taskCount: assignments.length,
		waveCount: waves.length,
	})
	await eventLog.append(taskGraphEvent)
	commitState(reduceEvent(state, taskGraphEvent))

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

	// Periodic refresh keeps elapsed time and progress bars current
	const refreshInterval = setInterval(() => refreshWidget(), 1000)

	// 3. Execute waves
	try {
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

				// Acquire worktree from pool, or fall back to repoRoot
				let worktreePath = repoRoot
				let worktreeBranch: string | undefined
				if (acquireWorktree) {
					const wt = await acquireWorktree(assignment.agentName)
					worktreePath = wt.worktreePath
					worktreeBranch = wt.branch
				}

				// Emit specialist_started BEFORE spawning (with provisional runId)
				const runId = `${assignment.agentName}-${Date.now().toString(36)}`
				const startedEvent = createFleetEvent<SpecialistStartedEvent>({
					type: 'specialist_started',
					agentName: assignment.agentName,
					runId,
					pid: 0, // updated when process starts
					worktreePath,
					model,
				})
				await eventLog.append(startedEvent)
				commitState(reduceEvent(state, startedEvent))

				// Create per-agent logger if logDir is available
				let logger: AgentLogger | null = null
				if (logDir) {
					logger = await AgentLogger.create({
						logDir,
						agentName: assignment.agentName,
						model,
						worktreePath,
					})
					if (logger) {
						loggers.set(assignment.agentName, logger)
					}
				}

				const result = await spawnSpecialist({
					agentName: assignment.agentName,
					model,
					worktreePath,
					prompt,
					timeoutMs: team.constraints.taskTimeoutMs,
					repoRoot,
					cancelSignal,
					onStreamLine: (line) => {
						logger?.appendLine(line)
						const activity = extractActivity(line)
						if (activity) {
							const added = activityStore.appendActivity(assignment.agentName, activity)
							if (added) refreshWidget()
						}
						// Extract streaming usage for real-time cost updates
						const streamUsage = extractStreamingUsage(line)
						if (streamUsage && (streamUsage.inputTokens > 0 || streamUsage.outputTokens > 0)) {
							const { costUsd } = calculateCost(streamUsage, model)
							const costEvent = createFleetEvent<CostUpdateEvent>({
								type: 'cost_update',
								agentName: assignment.agentName,
								inputTokens: streamUsage.inputTokens,
								outputTokens: streamUsage.outputTokens,
								costUsd,
							})
							state = reduceEvent(state, costEvent)
							setFleetState(state)
							refreshWidget()
						}
					},
				})

				runtimes.set(assignment.agentName, result.runtime)

				// Write stderr and close logger
				if (logger) {
					await logger.writeStderr(result.stderr)
					const loggerStatus = cancelSignal?.aborted
						? 'aborted' as const
						: undefined
					await logger.close({
						exitCode: result.exitCode,
						usage: result.usage,
						status: loggerStatus,
					})
				}

				// Build the authoritative final cost event from the parsed result.
				// This replaces streaming-accumulated costs to prevent double counting.
				onUsage?.(assignment.agentName, model, result.usage)
				const { costUsd } = calculateCost(result.usage, model)
				const finalCostEvent = createFleetEvent<CostUpdateEvent>({
					type: 'cost_update',
					agentName: assignment.agentName,
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					costUsd,
				})

				// Emit completion or failure, then atomically reset streaming costs
				// and apply the authoritative final cost in a single commitState().
				if (result.runtime.status === 'completed') {
					const completedEvent = createFleetEvent<SpecialistCompletedEvent>({
						type: 'specialist_completed',
						agentName: assignment.agentName,
						runId: result.runtime.runId,
					})
					await eventLog.append(completedEvent)
					let s = reduceEvent(state, completedEvent)
					s = resetAgentCost(s, assignment.agentName)
					s = reduceEvent(s, finalCostEvent)
					commitState(s)
				} else {
					// Analyze the failure — use LLM if available, else raw extraction
					let diagnosis: string
					if (analysisModel) {
						activityStore.appendActivity(assignment.agentName, 'analyzing failure...')
						commitState(state)
						diagnosis = await analyzeFailure({
							agentName: assignment.agentName,
							taskBrief: assignment.brief,
							stdout: result.report,
							stderr: result.stderr,
							errorDetails: result.errorDetails,
							report: result.report,
							model: analysisModel,
						})
					} else {
						// Fallback: raw error details
						diagnosis = result.errorDetails.length > 0
							? result.errorDetails.join('\n').slice(0, 500)
							: result.stderr.trim()
								? result.stderr.trim().split('\n').slice(-5).join('\n')
								: result.report || 'Process exited with non-zero code'
					}
					errors.set(assignment.agentName, diagnosis)
					activityStore.appendActivity(assignment.agentName, diagnosis.split('\n')[0] ?? 'failed')

					// Compute repo-relative log path for the failed event (only if logger was created)
					const logPath = logger
						? `.pi/logs/${path.basename(logDir!)}/${assignment.agentName}.jsonl`
						: undefined
					if (logPath) {
						logPaths.set(assignment.agentName, logPath)
					}

					const failedEvent = createFleetEvent<SpecialistFailedEvent>({
						type: 'specialist_failed',
						agentName: assignment.agentName,
						runId: result.runtime.runId,
						error: diagnosis.split('\n')[0]?.slice(0, 200) ?? 'Unknown error',
						logPath,
					})
					await eventLog.append(failedEvent)
					let s = reduceEvent(state, failedEvent)
					s = resetAgentCost(s, assignment.agentName)
					s = reduceEvent(s, finalCostEvent)
					commitState(s)
				}

				// Release worktree back to pool
				if (releaseWorktree && worktreePath !== repoRoot) {
					releaseWorktree(worktreePath)
				}

				return {
					agentName: assignment.agentName,
					report: result.report,
					usage: result.usage,
					status: result.runtime.status as 'completed' | 'failed',
					worktreeBranch: worktreeBranch ?? undefined,
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

	} finally {
		clearInterval(refreshInterval)
		if (loggers.size > 0) {
			await Promise.allSettled(
				[...loggers.values()].map((l) => l.close({ status: 'aborted' }))
			)
		}
	}

	// 4. Consolidate
	const consolidation = consolidateReports(allReports)

	ctx.ui.setWorkingMessage('')

	// Collect branches from completed specialists
	const completedBranches = allReports
		.filter((r) => r.status === 'completed' && r.worktreeBranch)
		.map((r) => ({ agentName: r.agentName, branch: r.worktreeBranch! }))

	return {
		state,
		summary: consolidation.summary,
		failedAgents: consolidation.failedAgents,
		completedBranches,
		errors,
		logPaths,
		activityStore,
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
