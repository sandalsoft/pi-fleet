import type { FleetState } from './state.js'
import type { ActivityStore } from '../status/activity-store.js'

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
let _errors: Map<string, string> = new Map()

export function getFleetState(): FleetState | null {
	return _state
}

export function setFleetState(state: FleetState): void {
	_state = state
}

export function clearFleetState(): void {
	_state = null
	_errors.clear()
	_logDir = null
	_logPaths.clear()
}

export function getFleetErrors(): Map<string, string> {
	return _errors
}

export function setFleetErrors(errors: Map<string, string>): void {
	_errors = errors
}

let _activityStore: ActivityStore | null = null

export function getActivityStore(): ActivityStore | null {
	return _activityStore
}

export function setActivityStore(store: ActivityStore): void {
	_activityStore = store
}

let _logDir: string | null = null

export function getLogDir(): string | null {
	return _logDir
}

export function setLogDir(logDir: string | null): void {
	_logDir = logDir
}

let _logPaths: Map<string, string> = new Map()

export function getLogPaths(): Map<string, string> {
	return _logPaths
}

export function setLogPaths(paths: Map<string, string>): void {
	_logPaths = paths
}
