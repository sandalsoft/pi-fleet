import {
	type FleetEvent,
	type SpecialistStartedEvent,
	type SpecialistCompletedEvent,
	type SpecialistFailedEvent,
	isEventType,
} from './events.js'
import type { EventLogReader } from './event-log.js'
import type { FleetState } from './state.js'
import { reconstructState } from './state.js'

export interface ResumeContext {
	ui: {
		confirm(title: string, message: string): Promise<boolean>
		notify(message: string, level: 'info' | 'warning' | 'error'): void
	}
}

export interface ResumeResult {
	resumed: boolean
	state: FleetState | null
	interruptedAgents: string[]
}

/**
 * Detect whether the event log contains an incomplete fleet session
 * and offer the user a chance to resume it.
 *
 * An incomplete session is one that has a session_start event but no
 * session_complete or session_aborted event. Interrupted specialists
 * are those that have a specialist_started event without a corresponding
 * specialist_completed or specialist_failed.
 *
 * Command wiring: the /fleet command handler (extension.ts) must parse
 * --resume from args and call resume() before starting the interview/
 * dispatch flow. If no incomplete session exists or the user declines,
 * fall through to the normal flow.
 */
export async function resume(
	reader: EventLogReader,
	ctx: ResumeContext
): Promise<ResumeResult> {
	const events = await reader.replay()

	if (events.length === 0) {
		return { resumed: false, state: null, interruptedAgents: [] }
	}

	// Check for incomplete session
	const hasStart = events.some((e) => e.type === 'session_start')
	const hasEnd = events.some(
		(e) => e.type === 'session_complete' || e.type === 'session_aborted'
	)

	if (!hasStart || hasEnd) {
		return { resumed: false, state: null, interruptedAgents: [] }
	}

	// Incomplete session found — reconstruct state
	const state = reconstructState(events)
	const interruptedAgents = detectInterruptedAgents(events)

	const agentList =
		interruptedAgents.length > 0
			? `Interrupted agents: ${interruptedAgents.join(', ')}`
			: 'No agents were mid-execution'

	const confirmed = await ctx.ui.confirm(
		'Incomplete fleet session detected',
		`A previous fleet session was interrupted before completion. ${agentList}. Resume from where it left off?`
	)

	if (!confirmed) {
		return { resumed: false, state: null, interruptedAgents }
	}

	ctx.ui.notify(
		`Resumed fleet session. Phase: ${state.phase}. ${interruptedAgents.length} interrupted agent(s).`,
		'info'
	)

	return { resumed: true, state, interruptedAgents }
}

/**
 * Find agents that were started but never completed or failed.
 * These are the ones that were likely mid-execution when the session
 * was interrupted.
 */
function detectInterruptedAgents(events: FleetEvent[]): string[] {
	const started = new Set<string>()
	const finished = new Set<string>()

	for (const event of events) {
		if (isEventType<SpecialistStartedEvent>(event, 'specialist_started')) {
			started.add(event.agentName)
		}
		if (isEventType<SpecialistCompletedEvent>(event, 'specialist_completed')) {
			finished.add(event.agentName)
		}
		if (isEventType<SpecialistFailedEvent>(event, 'specialist_failed')) {
			finished.add(event.agentName)
		}
	}

	return Array.from(started).filter((name) => !finished.has(name))
}
