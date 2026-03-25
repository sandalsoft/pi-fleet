/**
 * Per-agent activity history with deduplication.
 * Stores a rolling buffer of recent activities for the tree widget
 * and a full history for the /fleet-log overlay.
 */

export interface ActivityEntry {
	timestamp: number
	agentName: string
	text: string
}

const MAX_PER_AGENT = 50
const NOISE_PATTERNS = ['processing tool result...']

export class ActivityStore {
	private perAgent = new Map<string, ActivityEntry[]>()
	private globalLog: ActivityEntry[] = []

	/**
	 * Append an activity for an agent. Deduplicates:
	 * - Skips if text matches a noise pattern
	 * - Skips if text is a prefix or superstring of the last entry (streaming text growth)
	 * - Skips exact duplicates
	 */
	appendActivity(agentName: string, text: string): boolean {
		// Filter noise
		if (NOISE_PATTERNS.includes(text)) return false

		const buffer = this.perAgent.get(agentName)
		if (buffer && buffer.length > 0) {
			const last = buffer[buffer.length - 1].text
			// Skip if identical
			if (text === last) return false
			// Skip if new text is just the old text growing (streaming update)
			if (text.startsWith(last) || last.startsWith(text)) return false
		}

		const entry: ActivityEntry = {
			timestamp: Date.now(),
			agentName,
			text,
		}

		// Per-agent buffer
		if (!buffer) {
			this.perAgent.set(agentName, [entry])
		} else {
			buffer.push(entry)
			if (buffer.length > MAX_PER_AGENT) {
				buffer.shift()
			}
		}

		// Global log (uncapped for overlay — session lifetime is bounded)
		this.globalLog.push(entry)

		return true
	}

	/** Get the last N activities for an agent. */
	getRecentActivities(agentName: string, count: number): ActivityEntry[] {
		const buffer = this.perAgent.get(agentName)
		if (!buffer) return []
		return buffer.slice(-count)
	}

	/** Get the latest activity for an agent (for backward compat). */
	getLatestActivity(agentName: string): string | undefined {
		const buffer = this.perAgent.get(agentName)
		if (!buffer || buffer.length === 0) return undefined
		return buffer[buffer.length - 1].text
	}

	/** Get all activities as a flat, chronologically sorted list. */
	getFullHistory(): ActivityEntry[] {
		return this.globalLog
	}

	/** Clear all history for an agent (on completion). */
	clearAgent(agentName: string): void {
		this.perAgent.delete(agentName)
	}

	/** Clear everything. */
	clear(): void {
		this.perAgent.clear()
		this.globalLog = []
	}
}
