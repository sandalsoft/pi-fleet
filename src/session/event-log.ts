import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import {
	type FleetEvent,
	type KnownFleetEvent,
	parseFleetEvent,
} from './events.js'

const CUSTOM_TYPE = 'fleet-event'

export interface EventLogWriter {
	append(event: KnownFleetEvent): Promise<void>
}

export interface EventLogReader {
	replay(): Promise<FleetEvent[]>
}

/**
 * Thin wrapper around pi.appendEntry() for persisting fleet events.
 * Writes are fire-and-forget from the caller's perspective — pi handles
 * the underlying JSONL storage.
 */
export function createEventLogWriter(pi: ExtensionAPI): EventLogWriter {
	return {
		async append(event: KnownFleetEvent): Promise<void> {
			await pi.appendEntry(CUSTOM_TYPE, event)
		},
	}
}

/**
 * Replay all fleet events from the session log.
 * Uses two-layer parsing: structurally invalid entries are skipped with a
 * console warning (corruption tolerance). Unknown event types are preserved
 * as UnknownFleetEvent for forward compatibility.
 */
export function createEventLogReader(
	getEntries: () => Promise<Array<{ customType?: string; data?: unknown }>>
): EventLogReader {
	return {
		async replay(): Promise<FleetEvent[]> {
			const entries = await getEntries()
			const events: FleetEvent[] = []

			for (const entry of entries) {
				if (entry.customType !== CUSTOM_TYPE) continue

				try {
					const parsed = parseFleetEvent(entry.data)
					if (parsed) {
						events.push(parsed)
					} else {
						console.warn(
							'[pi-fleet] Skipping unparseable fleet event:',
							JSON.stringify(entry.data).slice(0, 200)
						)
					}
				} catch (err) {
					console.warn(
						'[pi-fleet] Skipping corrupted fleet event entry:',
						err instanceof Error ? err.message : String(err)
					)
				}
			}

			return events
		},
	}
}
