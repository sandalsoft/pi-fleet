import type {
	FleetEvent,
	KnownFleetEvent,
	ConstraintsSnapshot,
} from './events.js'

// --- Fleet session phases ---
export type FleetPhase =
	| 'interview'
	| 'dispatching'
	| 'executing'
	| 'merging'
	| 'complete'
	| 'aborted'

// --- Specialist runtime record (JSON-safe, no process handles) ---
export interface SpecialistRecord {
	agentName: string
	runId: string
	pid: number
	worktreePath: string
	model: string
	status: 'running' | 'completed' | 'failed'
	startedAt: string | null
	completedAt: string | null
	hostRoutableId?: string
}

// --- Per-agent cost tracking ---
export interface AgentCost {
	agentName: string
	inputTokens: number
	outputTokens: number
	costUsd: number
}

// --- Task state for DAG tracking ---
export interface TaskState {
	taskCount: number
	waveCount: number
	completedAgents: string[]
	failedAgents: string[]
}

// --- The full in-memory fleet state ---
export interface FleetState {
	phase: FleetPhase
	startedAt: string | null
	repoRoot: string | null
	baseSha: string | null
	constraints: ConstraintsSnapshot | null
	teamId: string | null
	members: string[]
	specialists: Map<string, SpecialistRecord>
	costs: Map<string, AgentCost>
	tasks: TaskState | null
	totalCostUsd: number
	totalDurationMs: number
	sessionComplete: boolean
	sessionAborted: boolean
	abortReason: string | null
	mergeInProgress: boolean
	integrationBranch: string | null
}

/**
 * Create a blank FleetState. Used as the initial accumulator for reduce().
 */
export function emptyFleetState(): FleetState {
	return {
		phase: 'interview',
		startedAt: null,
		repoRoot: null,
		baseSha: null,
		constraints: null,
		teamId: null,
		members: [],
		specialists: new Map(),
		costs: new Map(),
		tasks: null,
		totalCostUsd: 0,
		totalDurationMs: 0,
		sessionComplete: false,
		sessionAborted: false,
		abortReason: null,
		mergeInProgress: false,
		integrationBranch: null,
	}
}

/**
 * Reduce a single event into the current FleetState.
 * Unknown events (those with `_unknown: true`) are silently skipped.
 */
export function reduceEvent(state: FleetState, event: FleetEvent): FleetState {
	// Skip unknown events
	if ('_unknown' in event && event._unknown === true) return state

	const known = event as KnownFleetEvent
	switch (known.type) {
		case 'session_start':
			return {
				...state,
				phase: 'interview',
				startedAt: known.startedAt,
				repoRoot: known.repoRoot,
				baseSha: known.baseSha,
				constraints: known.constraints,
			}

		case 'interview_complete':
			return {
				...state,
				phase: 'dispatching',
			}

		case 'team_selected':
			return {
				...state,
				teamId: known.teamId,
				members: known.members,
			}

		case 'task_graph_created':
			return {
				...state,
				phase: 'executing',
				tasks: {
					taskCount: known.taskCount,
					waveCount: known.waveCount,
					completedAgents: state.tasks?.completedAgents ?? [],
					failedAgents: state.tasks?.failedAgents ?? [],
				},
			}

		case 'specialist_started': {
			const specialists = new Map(state.specialists)
			specialists.set(known.agentName, {
				agentName: known.agentName,
				runId: known.runId,
				pid: known.pid,
				worktreePath: known.worktreePath,
				model: known.model,
				status: 'running',
				startedAt: known.timestamp,
				completedAt: null,
			})
			return { ...state, specialists }
		}

		case 'specialist_completed': {
			const specialists = new Map(state.specialists)
			const existing = specialists.get(known.agentName)
			if (existing) {
				specialists.set(known.agentName, {
					...existing,
					runId: known.runId,
					status: 'completed',
					completedAt: known.timestamp,
				})
			}
			const completedAgents = [
				...(state.tasks?.completedAgents ?? []),
				known.agentName,
			]
			return {
				...state,
				specialists,
				tasks: state.tasks
					? { ...state.tasks, completedAgents }
					: null,
			}
		}

		case 'specialist_failed': {
			const specialists = new Map(state.specialists)
			const existing = specialists.get(known.agentName)
			if (existing) {
				specialists.set(known.agentName, {
					...existing,
					runId: known.runId,
					status: 'failed',
					completedAt: known.timestamp,
				})
			}
			const failedAgents = [
				...(state.tasks?.failedAgents ?? []),
				known.agentName,
			]
			return {
				...state,
				specialists,
				tasks: state.tasks
					? { ...state.tasks, failedAgents }
					: null,
			}
		}

		case 'cost_update': {
			const costs = new Map(state.costs)
			const prev = costs.get(known.agentName) ?? {
				agentName: known.agentName,
				inputTokens: 0,
				outputTokens: 0,
				costUsd: 0,
			}
			costs.set(known.agentName, {
				agentName: known.agentName,
				inputTokens: prev.inputTokens + known.inputTokens,
				outputTokens: prev.outputTokens + known.outputTokens,
				costUsd: prev.costUsd + known.costUsd,
			})
			const totalCostUsd = Array.from(costs.values()).reduce(
				(sum, c) => sum + c.costUsd,
				0
			)
			return { ...state, costs, totalCostUsd }
		}

		case 'merge_started':
			return {
				...state,
				phase: 'merging',
				mergeInProgress: true,
				integrationBranch: known.integrationBranch,
			}

		case 'merge_completed':
			return {
				...state,
				mergeInProgress: false,
			}

		case 'merge_conflict':
			// Informational — state doesn't change structurally
			return state

		case 'consolidation_complete':
			return {
				...state,
				phase: 'complete',
				mergeInProgress: false,
			}

		case 'session_complete':
			return {
				...state,
				phase: 'complete',
				sessionComplete: true,
				totalCostUsd: known.totalCostUsd,
				totalDurationMs: known.totalDurationMs,
			}

		case 'session_aborted':
			return {
				...state,
				phase: 'aborted',
				sessionAborted: true,
				abortReason: known.reason,
			}

		// budget_warning, time_warning, worktree_created: informational, no state mutation
		default:
			return state
	}
}

/**
 * Zero all cost fields for a single agent and recalculate totalCostUsd.
 *
 * Used between streaming accumulation and final authoritative cost to
 * prevent double counting: reset streaming totals, then reduce the
 * authoritative cost_update on top.
 */
export function resetAgentCost(state: FleetState, agentName: string): FleetState {
	const costs = new Map(state.costs)
	costs.set(agentName, {
		agentName,
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
	})
	const totalCostUsd = Array.from(costs.values()).reduce(
		(sum, c) => sum + c.costUsd,
		0
	)
	return { ...state, costs, totalCostUsd }
}

/**
 * Reconstruct FleetState from a sequence of events via Array.reduce().
 */
export function reconstructState(events: FleetEvent[]): FleetState {
	return events.reduce(reduceEvent, emptyFleetState())
}
