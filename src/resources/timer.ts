/**
 * Session timer for tracking elapsed time and per-agent durations.
 *
 * All time values are in milliseconds internally.
 * Minutes are used only at the API boundary to match teams.yaml config.
 */

export interface SessionTimer {
	/** Session start timestamp (ms since epoch) */
	readonly startedAt: number

	/** Elapsed time in milliseconds */
	elapsedMs(): number

	/** Elapsed time in minutes */
	elapsedMinutes(): number

	/** Minutes remaining before the limit. Returns 0 if limit exceeded. */
	minutesRemaining(limitMinutes: number): number

	/** Ratio of elapsed to limit (0.0 to 1.0+). Returns 0 if limit is 0. */
	elapsedRatio(limitMinutes: number): number
}

export interface AgentTimer {
	readonly agentName: string
	readonly startedAt: number
	stoppedAt: number | null

	/** Duration in ms. If still running, measures from start to now. */
	durationMs(): number
}

/**
 * Create a session timer anchored to the given start time.
 * Defaults to Date.now() if no start time provided.
 */
export function createSessionTimer(startedAt?: number): SessionTimer {
	const start = startedAt ?? Date.now()

	return {
		startedAt: start,

		elapsedMs(): number {
			return Date.now() - start
		},

		elapsedMinutes(): number {
			return (Date.now() - start) / 60_000
		},

		minutesRemaining(limitMinutes: number): number {
			const remaining = limitMinutes - this.elapsedMinutes()
			return Math.max(0, remaining)
		},

		elapsedRatio(limitMinutes: number): number {
			if (limitMinutes <= 0) return 0
			return this.elapsedMinutes() / limitMinutes
		},
	}
}

/**
 * Create a per-agent timer. Call stop() when the agent finishes.
 */
export function createAgentTimer(agentName: string, startedAt?: number): AgentTimer {
	const start = startedAt ?? Date.now()

	return {
		agentName,
		startedAt: start,
		stoppedAt: null,

		durationMs(): number {
			const end = this.stoppedAt ?? Date.now()
			return end - start
		},
	}
}
