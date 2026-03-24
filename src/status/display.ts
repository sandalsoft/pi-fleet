import type { FleetState } from '../session/state.js'
import { reconstructState } from '../session/state.js'
import { getFleetState } from '../session/runtime-store.js'
import type { EventLogReader } from '../session/event-log.js'
import { formatStatusTable, formatStatusLine } from './formatter.js'

export interface StatusContext {
	ui: {
		notify(message: string, level: 'info' | 'warning' | 'error'): void
		setWidget(key: string, lines: string[]): void
		setStatus(key: string, text: string): void
	}
}

export interface StatusDisplayOpts {
	ctx: StatusContext
	reader: EventLogReader
}

/**
 * Resolve the current FleetState from the best available source:
 * 1. In-memory runtime store (during/after execution)
 * 2. Event replay from persisted log (after resume, before re-execution)
 */
export async function resolveFleetState(reader: EventLogReader): Promise<FleetState | null> {
	// Prefer in-memory state
	const memState = getFleetState()
	if (memState) return memState

	// Fall back to event replay
	const events = await reader.replay()
	if (events.length === 0) return null

	return reconstructState(events)
}

/**
 * Handle the /fleet-status command.
 * Reads state from memory or event replay, formats as a table, and renders via setWidget.
 */
export async function handleStatus(opts: StatusDisplayOpts): Promise<void> {
	const { ctx, reader } = opts

	const state = await resolveFleetState(reader)
	if (!state) {
		ctx.ui.notify('No active or previous fleet session found.', 'info')
		return
	}

	const lines = formatStatusTable(state)
	ctx.ui.setWidget('fleet-status', lines)
}

/**
 * Update the persistent footer status line.
 * Called on each cost_update event during execution.
 */
export function updateStatusLine(ctx: StatusContext, state: FleetState): void {
	const line = formatStatusLine(state)
	ctx.ui.setStatus('fleet', line)
}
