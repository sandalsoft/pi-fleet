import type { FleetState } from './state.js'

/**
 * Module-level singleton store for in-memory FleetState.
 *
 * During execution, this is the source of truth. Events are the
 * persistence/audit layer. When the store is empty (e.g., after process
 * restart), consumers fall back to event replay via the reader.
 *
 * - /fleet sets it on start/resume
 * - /fleet-steer and /fleet-status read from it
 */
let _state: FleetState | null = null

export function getFleetState(): FleetState | null {
	return _state
}

export function setFleetState(state: FleetState): void {
	_state = state
}

export function clearFleetState(): void {
	_state = null
}
