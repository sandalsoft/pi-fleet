import { z } from 'zod'

// --- Schema version ---
export const CURRENT_SCHEMA_VERSION = 1

// --- Layer 1: Envelope (accepts ALL events, including unknown future types) ---
export const FleetEventEnvelopeSchema = z
	.object({
		schemaVersion: z.number(),
		type: z.string(),
		timestamp: z.string(),
	})
	.passthrough()

export type FleetEventEnvelope = z.infer<typeof FleetEventEnvelopeSchema>

// --- Constraints snapshot (mirrors config but is self-contained in events) ---
export const ConstraintsSnapshotSchema = z.object({
	maxUsd: z.number(),
	maxMinutes: z.number(),
	taskTimeoutMs: z.number(),
	maxConcurrency: z.number(),
})

export type ConstraintsSnapshot = z.infer<typeof ConstraintsSnapshotSchema>

// --- Layer 2: Per-type payload schemas ---

const SessionStartPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('session_start'),
	timestamp: z.string(),
	startedAt: z.string(),
	repoRoot: z.string(),
	baseSha: z.string(),
	constraints: ConstraintsSnapshotSchema,
})

const InterviewCompletePayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('interview_complete'),
	timestamp: z.string(),
	answers: z.record(z.unknown()),
})

const TeamSelectedPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('team_selected'),
	timestamp: z.string(),
	teamId: z.string(),
	members: z.array(z.string()),
})

const TaskGraphCreatedPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('task_graph_created'),
	timestamp: z.string(),
	taskCount: z.number(),
	waveCount: z.number(),
})

const WorktreeCreatedPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('worktree_created'),
	timestamp: z.string(),
	agentName: z.string(),
	worktreePath: z.string(),
})

const SpecialistStartedPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('specialist_started'),
	timestamp: z.string(),
	agentName: z.string(),
	runId: z.string(),
	pid: z.number(),
	worktreePath: z.string(),
	model: z.string(),
})

const SpecialistCompletedPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('specialist_completed'),
	timestamp: z.string(),
	agentName: z.string(),
	runId: z.string(),
})

const SpecialistFailedPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('specialist_failed'),
	timestamp: z.string(),
	agentName: z.string(),
	runId: z.string(),
	error: z.string().optional(),
})

const CostUpdatePayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('cost_update'),
	timestamp: z.string(),
	agentName: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	costUsd: z.number(),
})

const MergeStartedPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('merge_started'),
	timestamp: z.string(),
	integrationBranch: z.string(),
})

const MergeCompletedPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('merge_completed'),
	timestamp: z.string(),
	integrationBranch: z.string(),
	mergedAgents: z.array(z.string()),
})

const MergeConflictPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('merge_conflict'),
	timestamp: z.string(),
	agentName: z.string(),
	filePath: z.string(),
	resolution: z.string().optional(),
})

const ConsolidationCompletePayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('consolidation_complete'),
	timestamp: z.string(),
	finalSha: z.string(),
})

const BudgetWarningPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('budget_warning'),
	timestamp: z.string(),
	currentUsd: z.number(),
	limitUsd: z.number(),
})

const TimeWarningPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('time_warning'),
	timestamp: z.string(),
	elapsedMinutes: z.number(),
	limitMinutes: z.number(),
})

const SessionCompletePayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('session_complete'),
	timestamp: z.string(),
	totalCostUsd: z.number(),
	totalDurationMs: z.number(),
})

const SessionAbortedPayload = z.object({
	schemaVersion: z.number(),
	type: z.literal('session_aborted'),
	timestamp: z.string(),
	reason: z.string(),
})

// --- Known event type map ---
export const knownEventSchemas: Record<string, z.ZodType> = {
	session_start: SessionStartPayload,
	interview_complete: InterviewCompletePayload,
	team_selected: TeamSelectedPayload,
	task_graph_created: TaskGraphCreatedPayload,
	worktree_created: WorktreeCreatedPayload,
	specialist_started: SpecialistStartedPayload,
	specialist_completed: SpecialistCompletedPayload,
	specialist_failed: SpecialistFailedPayload,
	cost_update: CostUpdatePayload,
	merge_started: MergeStartedPayload,
	merge_completed: MergeCompletedPayload,
	merge_conflict: MergeConflictPayload,
	consolidation_complete: ConsolidationCompletePayload,
	budget_warning: BudgetWarningPayload,
	time_warning: TimeWarningPayload,
	session_complete: SessionCompletePayload,
	session_aborted: SessionAbortedPayload,
}

// --- Derived types ---
export type SessionStartEvent = z.infer<typeof SessionStartPayload>
export type InterviewCompleteEvent = z.infer<typeof InterviewCompletePayload>
export type TeamSelectedEvent = z.infer<typeof TeamSelectedPayload>
export type TaskGraphCreatedEvent = z.infer<typeof TaskGraphCreatedPayload>
export type WorktreeCreatedEvent = z.infer<typeof WorktreeCreatedPayload>
export type SpecialistStartedEvent = z.infer<typeof SpecialistStartedPayload>
export type SpecialistCompletedEvent = z.infer<typeof SpecialistCompletedPayload>
export type SpecialistFailedEvent = z.infer<typeof SpecialistFailedPayload>
export type CostUpdateEvent = z.infer<typeof CostUpdatePayload>
export type MergeStartedEvent = z.infer<typeof MergeStartedPayload>
export type MergeCompletedEvent = z.infer<typeof MergeCompletedPayload>
export type MergeConflictEvent = z.infer<typeof MergeConflictPayload>
export type ConsolidationCompleteEvent = z.infer<typeof ConsolidationCompletePayload>
export type BudgetWarningEvent = z.infer<typeof BudgetWarningPayload>
export type TimeWarningEvent = z.infer<typeof TimeWarningPayload>
export type SessionCompleteEvent = z.infer<typeof SessionCompletePayload>
export type SessionAbortedEvent = z.infer<typeof SessionAbortedPayload>

export interface UnknownFleetEvent extends FleetEventEnvelope {
	_unknown: true
}

export type KnownFleetEvent =
	| SessionStartEvent
	| InterviewCompleteEvent
	| TeamSelectedEvent
	| TaskGraphCreatedEvent
	| WorktreeCreatedEvent
	| SpecialistStartedEvent
	| SpecialistCompletedEvent
	| SpecialistFailedEvent
	| CostUpdateEvent
	| MergeStartedEvent
	| MergeCompletedEvent
	| MergeConflictEvent
	| ConsolidationCompleteEvent
	| BudgetWarningEvent
	| TimeWarningEvent
	| SessionCompleteEvent
	| SessionAbortedEvent

export type FleetEvent = KnownFleetEvent | UnknownFleetEvent

// --- Two-layer parser ---

/**
 * Parse a raw object into a FleetEvent using two-layer parsing.
 * Layer 1: validate envelope (schemaVersion, type, timestamp).
 * Layer 2: if type is known, validate with per-type schema.
 * Unknown types are preserved as UnknownFleetEvent, never rejected.
 * Returns null only for structurally invalid events (missing envelope fields).
 */
export function parseFleetEvent(raw: unknown): FleetEvent | null {
	// Layer 1: envelope
	const envelope = FleetEventEnvelopeSchema.safeParse(raw)
	if (!envelope.success) return null

	const { type } = envelope.data

	// Layer 2: known type schemas
	const schema = knownEventSchemas[type]
	if (!schema) {
		return { ...envelope.data, _unknown: true } as UnknownFleetEvent
	}

	const parsed = schema.safeParse(raw)
	if (!parsed.success) {
		// Known type but payload didn't match — treat as unknown rather than crashing
		return { ...envelope.data, _unknown: true } as UnknownFleetEvent
	}

	return parsed.data as KnownFleetEvent
}

/**
 * Create a fleet event with current timestamp and schema version.
 */
export function createFleetEvent<T extends KnownFleetEvent>(
	payload: Omit<T, 'schemaVersion' | 'timestamp'> & {
		schemaVersion?: number
		timestamp?: string
	}
): T {
	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		timestamp: new Date().toISOString(),
		...payload,
	} as T
}

/**
 * Type guard: check if a FleetEvent is a known event (not unknown).
 */
export function isKnownEvent(event: FleetEvent): event is KnownFleetEvent {
	return !('_unknown' in event && event._unknown === true)
}

/**
 * Type guard for a specific event type.
 */
export function isEventType<T extends KnownFleetEvent>(
	event: FleetEvent,
	type: T['type']
): event is T {
	return event.type === type && isKnownEvent(event)
}
