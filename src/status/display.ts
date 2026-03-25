import type { FleetState } from '../session/state.js'
import { reconstructState } from '../session/state.js'
import { getFleetState } from '../session/runtime-store.js'
import type { EventLogReader } from '../session/event-log.js'
import { formatStatusTable, formatStatusLine } from './formatter.js'
import { FleetProgressComponent, type FleetWidgetColors } from './fleet-progress-component.js'
import type { ActivityStore } from './activity-store.js'

export interface StatusContext {
	ui: {
		notify(message: string, level: 'info' | 'warning' | 'error'): void
		setWidget(key: string, content: unknown, options?: { placement?: string }): void
		setStatus(key: string, text: string | undefined): void
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
 */
export function updateStatusLine(ctx: StatusContext, state: FleetState): void {
	const line = formatStatusLine(state)
	ctx.ui.setStatus('fleet', line)
}

// --- Singleton TUI component instance ---

let _progressComponent: FleetProgressComponent | null = null
let _componentInstalled = false

/**
 * Update the live progress widget and footer status line.
 *
 * On first call, installs a TUI component factory via setWidget.
 * On subsequent calls, updates the component instance (which triggers
 * tui.requestRender() for efficient re-rendering with colors).
 *
 * Falls back to plain string[] if the component factory isn't supported
 * (e.g., in test environments or headless mode).
 */
export function updateProgressWidget(
	ctx: StatusContext,
	state: FleetState,
	activityStore?: ActivityStore | Map<string, string>,
	colorOverrides?: Partial<FleetWidgetColors>,
	errors?: Map<string, string>,
): void {
	// Always update footer status line (plain text)
	ctx.ui.setStatus('fleet', formatStatusLine(state))

	if (_progressComponent && _componentInstalled) {
		// Fast path: component already installed, just update data
		_progressComponent.update(state, activityStore, errors)
		return
	}

	// First call: try to install TUI component factory.
	// The factory is invoked synchronously by setWidget if TUI is available.
	// If the factory runs, _progressComponent will be set. If not (headless/test),
	// we fall back to string[] rendering.
	try {
		ctx.ui.setWidget('fleet-progress', (tui: unknown, theme: unknown) => {
			_progressComponent = new FleetProgressComponent(
				tui as any,
				theme as any,
				colorOverrides,
			)
			_progressComponent.update(state, activityStore, errors)
			return _progressComponent
		}, { placement: 'aboveEditor' })
	} catch {
		// setWidget threw — environment doesn't support component factories
	}

	if (_progressComponent) {
		// Factory was invoked, component is live
		_componentInstalled = true
	} else {
		// Fallback: plain string[] rendering — convert store to simple map for formatter
		const activitiesMap = new Map<string, string>()
		if (activityStore && 'getLatestActivity' in activityStore) {
			const store = activityStore as ActivityStore
			for (const [name] of state.specialists) {
				const latest = store.getLatestActivity(name)
				if (latest) activitiesMap.set(name, latest)
			}
		} else if (activityStore instanceof Map) {
			for (const [k, v] of activityStore) activitiesMap.set(k, v)
		}
		const lines = formatStatusTable(state, activitiesMap, errors)
		ctx.ui.setWidget('fleet-progress', lines, { placement: 'aboveEditor' })
	}
}

/**
 * Remove the progress widget and footer status.
 * Call when the fleet session ends or is cancelled.
 */
export function clearProgressWidget(ctx: StatusContext): void {
	if (_progressComponent) {
		_progressComponent.dispose()
		_progressComponent = null
	}
	_componentInstalled = false
	ctx.ui.setWidget('fleet-progress', undefined)
	ctx.ui.setStatus('fleet', undefined)
}

/**
 * Reset the singleton (for testing).
 */
export function _resetProgressComponent(): void {
	_progressComponent = null
	_componentInstalled = false
}
