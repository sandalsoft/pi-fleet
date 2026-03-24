/**
 * Agent-chain pipeline runner.
 *
 * Executes chain steps sequentially, substituting $INPUT between steps.
 * Reuses a single worktree across all steps (unlike dispatcher's parallel mode).
 * Emits specialist_started/completed/failed events per step.
 * Respects the same budget/time limits as dispatcher mode.
 */

import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import type { Chain, AgentDefinition } from '../config/schema.js'
import type { EventLogWriter } from '../session/event-log.js'
import type { FleetState } from '../session/state.js'
import { createFleetEvent } from '../session/events.js'
import type {
	SessionStartEvent,
	SpecialistStartedEvent,
	SpecialistCompletedEvent,
	SpecialistFailedEvent,
	SessionCompleteEvent,
	SessionAbortedEvent,
} from '../session/events.js'
import { setFleetState } from '../session/runtime-store.js'
import { reduceEvent } from '../session/state.js'
import { spawnSpecialist } from '../dispatch/spawner.js'
import type { Usage } from '../dispatch/types.js'
import { addUsage, emptyUsage } from '../dispatch/types.js'
import { buildStepPrompt } from './variable.js'
import { composePrompt } from '../dispatch/prompt-composer.js'

export interface ChainRunnerOpts {
	pi: ExtensionAPI
	ctx: ExtensionCommandContext
	chain: Chain
	agents: AgentDefinition[]
	repoRoot: string
	worktreePath: string
	eventLog: EventLogWriter
	state: FleetState
	/** The user's original task description (first step's $INPUT). */
	taskDescription: string
	/** Budget limit in USD. */
	maxUsd: number
	/** Time limit in minutes. */
	maxMinutes: number
	/** Per-step timeout in milliseconds. */
	taskTimeoutMs?: number
	cancelSignal?: AbortSignal
	/** Max input chars for $INPUT truncation (default 200,000). */
	maxInputChars?: number
}

export interface ChainRunResult {
	state: FleetState
	/** The final step's output. */
	finalOutput: string
	/** Total accumulated usage across all steps. */
	totalUsage: Usage
	/** Step index where the chain stopped (equals steps.length on success). */
	completedSteps: number
	/** If the chain was aborted, the reason. */
	abortReason: string | null
}

/**
 * Execute an agent-chain pipeline sequentially.
 *
 * Each step spawns a pi subprocess. The output from step N becomes
 * the $INPUT for step N+1. The first step receives the user's original
 * task description as its input.
 */
export async function runChain(opts: ChainRunnerOpts): Promise<ChainRunResult> {
	const {
		pi,
		ctx,
		chain,
		agents,
		repoRoot,
		worktreePath,
		eventLog,
		taskDescription,
		maxUsd,
		maxMinutes,
		taskTimeoutMs = 120_000,
		cancelSignal,
		maxInputChars,
	} = opts
	let { state } = opts

	// Build agent lookup
	const agentMap = new Map<string, AgentDefinition>()
	for (const agent of agents) {
		agentMap.set(agent.id, agent)
		agentMap.set(agent.frontmatter.name, agent)
	}

	// Record base commit
	const headResult = await pi.exec('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])
	const baseSha = headResult.stdout.trim()

	// Emit session_start
	const sessionStartEvent = createFleetEvent<SessionStartEvent>({
		type: 'session_start',
		startedAt: new Date().toISOString(),
		repoRoot,
		baseSha,
		constraints: {
			maxUsd,
			maxMinutes,
			taskTimeoutMs,
			maxConcurrency: 1,
		},
	})
	await eventLog.append(sessionStartEvent)
	state = reduceEvent(state, sessionStartEvent)
	setFleetState(state)

	const startTime = Date.now()
	let currentInput = taskDescription
	let totalUsage = emptyUsage()
	let completedSteps = 0
	let abortReason: string | null = null

	for (let i = 0; i < chain.steps.length; i++) {
		const step = chain.steps[i]
		const stepLabel = `Step ${i + 1}/${chain.steps.length}`

		// Check budget (accumulated cost vs limit)
		if (maxUsd > 0 && totalUsage.cost > maxUsd) {
			abortReason = `Budget exceeded: $${totalUsage.cost.toFixed(4)} > $${maxUsd.toFixed(2)} limit`
			break
		}

		// Check time
		const elapsedMinutes = (Date.now() - startTime) / 60_000
		if (maxMinutes > 0 && elapsedMinutes > maxMinutes) {
			abortReason = `Time limit exceeded: ${elapsedMinutes.toFixed(1)}min > ${maxMinutes}min limit`
			break
		}

		// Check cancellation
		if (cancelSignal?.aborted) {
			abortReason = 'Chain cancelled by user'
			break
		}

		// Resolve agent
		const agent = agentMap.get(step.agent)
		if (!agent) {
			abortReason = `${stepLabel}: agent definition not found: ${step.agent}`
			await emitStepFailed(eventLog, state, step.agent, abortReason)
			state = reduceEvent(
				state,
				createFleetEvent<SpecialistFailedEvent>({
					type: 'specialist_failed',
					agentName: step.agent,
					runId: '',
					error: abortReason,
				})
			)
			setFleetState(state)
			break
		}

		// Build prompt with $INPUT substitution
		const { prompt: stepPrompt, truncated } = buildStepPrompt(
			step.prompt,
			currentInput,
			maxInputChars
		)

		if (truncated) {
			ctx.ui.notify(
				`${stepLabel}: previous step output was truncated (too large for context)`,
				'warning'
			)
		}

		// Compose the full prompt including agent identity, CLAUDE.md, scratchpad
		const scratchpadDir = `${repoRoot}/.pi/scratchpads`
		const fullPrompt = await composePrompt({
			agent,
			taskBrief: stepPrompt,
			repoRoot,
			scratchpadDir,
		})

		const model = agent.frontmatter.model

		ctx.ui.setWorkingMessage(`${stepLabel}: running ${agent.frontmatter.name}...`)

		// Emit specialist_started
		const startedEvent = createFleetEvent<SpecialistStartedEvent>({
			type: 'specialist_started',
			agentName: agent.id,
			runId: '', // will be filled by spawnSpecialist
			pid: 0,
			worktreePath,
			model,
		})
		await eventLog.append(startedEvent)
		state = reduceEvent(state, startedEvent)
		setFleetState(state)

		// Spawn the specialist
		try {
			const result = await spawnSpecialist({
				agentName: agent.id,
				model,
				worktreePath,
				prompt: fullPrompt,
				timeoutMs: taskTimeoutMs,
				repoRoot,
				cancelSignal,
			})

			totalUsage = addUsage(totalUsage, result.usage)

			if (result.runtime.status === 'completed') {
				const completedEvent = createFleetEvent<SpecialistCompletedEvent>({
					type: 'specialist_completed',
					agentName: agent.id,
					runId: result.runtime.runId,
				})
				await eventLog.append(completedEvent)
				state = reduceEvent(state, completedEvent)
				setFleetState(state)

				// The output becomes the next step's input
				currentInput = result.report
				completedSteps++
			} else {
				abortReason = `${stepLabel} (${agent.frontmatter.name}) failed: process exited with non-zero code`
				const failedEvent = createFleetEvent<SpecialistFailedEvent>({
					type: 'specialist_failed',
					agentName: agent.id,
					runId: result.runtime.runId,
					error: abortReason,
				})
				await eventLog.append(failedEvent)
				state = reduceEvent(state, failedEvent)
				setFleetState(state)
				break
			}
		} catch (err) {
			abortReason = `${stepLabel} (${agent.frontmatter.name}) threw: ${err instanceof Error ? err.message : String(err)}`
			const failedEvent = createFleetEvent<SpecialistFailedEvent>({
				type: 'specialist_failed',
				agentName: agent.id,
				runId: '',
				error: abortReason,
			})
			await eventLog.append(failedEvent)
			state = reduceEvent(state, failedEvent)
			setFleetState(state)
			break
		}
	}

	// Emit terminal event
	const totalDurationMs = Date.now() - startTime

	if (abortReason) {
		const abortEvent = createFleetEvent<SessionAbortedEvent>({
			type: 'session_aborted',
			reason: abortReason,
		})
		await eventLog.append(abortEvent)
		state = reduceEvent(state, abortEvent)
	} else {
		const completeEvent = createFleetEvent<SessionCompleteEvent>({
			type: 'session_complete',
			totalCostUsd: totalUsage.cost,
			totalDurationMs,
		})
		await eventLog.append(completeEvent)
		state = reduceEvent(state, completeEvent)
	}

	setFleetState(state)
	ctx.ui.setWorkingMessage('')

	return {
		state,
		finalOutput: currentInput,
		totalUsage,
		completedSteps,
		abortReason,
	}
}

/**
 * Helper to emit a specialist_failed event when agent lookup fails.
 */
async function emitStepFailed(
	eventLog: EventLogWriter,
	_state: FleetState,
	agentName: string,
	error: string
): Promise<void> {
	const failedEvent = createFleetEvent<SpecialistFailedEvent>({
		type: 'specialist_failed',
		agentName,
		runId: '',
		error,
	})
	await eventLog.append(failedEvent)
}
