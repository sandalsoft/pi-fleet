import type { FleetState } from '../session/state.js'
import { truncateToWidth } from '@mariozechner/pi-tui'

/**
 * Status formatter for fleet progress display.
 *
 * Produces a compact, information-dense widget showing:
 * - Phase header with total cost
 * - Two-column agent grid with status icons, cost, and token counts
 * - Time and budget progress bars
 * - Completion summary
 */

// --- Status icons ---
const ICON = {
	running: '\u25cf',   // ● (filled circle)
	completed: '\u2713', // ✓ (check mark)
	failed: '\u2717',    // ✗ (ballot X)
	queued: '\u25cb',    // ○ (open circle)
} as const

// --- Progress bar characters ---
const BAR_FILLED = '\u2593' // ▓
const BAR_EMPTY = '\u2591'  // ░

// --- Tree drawing ---
const TREE_MID = '\u251c\u2500' // ├─
const TREE_END = '\u2514\u2500' // └─

// --- Formatting helpers ---

export function formatTokens(count: number): string {
	if (count === 0) return '-'
	if (count < 1000) return `${count}`
	if (count < 100_000) return `${(count / 1000).toFixed(1)}k`
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`
	return `${(count / 1_000_000).toFixed(1)}M`
}

export function formatUsd(amount: number): string {
	return `$${amount.toFixed(2)}`
}

export function formatElapsed(ms: number): string {
	if (ms <= 0) return '0s'
	const totalSeconds = Math.floor(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	if (minutes === 0) return `${seconds}s`
	return `${minutes}m ${seconds}s`
}

function elapsedMs(startedAt: string | null): number {
	if (!startedAt) return 0
	return Math.max(0, Date.now() - new Date(startedAt).getTime())
}

/**
 * Format per-agent elapsed time from timestamps.
 *
 * Returns `-` for null startedAt or unparseable timestamps.
 * Running agents (completedAt null): elapsed = now - startedAt.
 * Completed/failed agents: elapsed = completedAt - startedAt.
 * Clamps negative durations to zero (handles clock skew).
 *
 * @param now - optional fixed timestamp for deterministic testing
 */
export function formatAgentElapsed(
	startedAt: string | null,
	completedAt: string | null,
	now?: number,
): string {
	if (!startedAt) return '-'
	const startMs = new Date(startedAt).getTime()
	if (!Number.isFinite(startMs)) return '-'

	if (completedAt !== null) {
		const endMs = new Date(completedAt).getTime()
		if (!Number.isFinite(endMs)) return '-'
		return formatElapsed(Math.max(0, endMs - startMs))
	}

	// Running: elapsed from now
	const currentMs = now ?? Date.now()
	return formatElapsed(Math.max(0, currentMs - startMs))
}

export function progressBar(ratio: number, width: number = 18): string {
	const clamped = Math.max(0, Math.min(1, ratio))
	const filled = Math.round(clamped * width)
	return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(width - filled)
}


function statusIcon(status: 'running' | 'completed' | 'failed' | 'queued'): string {
	return ICON[status] ?? ICON.queued
}

/**
 * Format a single agent as a full-width tree row:
 *   ├─ ● developer      $1.50  7.0k  reading src/config/schema.ts
 */
function formatAgentTreeRow(
	agent: AgentRow,
	isLast: boolean,
	activity: string | undefined,
	error: string | undefined,
	logPath: string | undefined,
): string {
	const branch = isLast ? TREE_END : TREE_MID
	const icon = statusIcon(agent.status)
	const name = truncateToWidth(agent.name, 14, '\u2026').padEnd(14)
	const cost = agent.costUsd > 0 ? formatUsd(agent.costUsd) : '-'
	const tokens = agent.totalTokens > 0 ? formatTokens(agent.totalTokens) : '-'
	const elapsed = formatAgentElapsed(agent.startedAt, agent.completedAt)
	const prefix = `  ${branch} ${icon} ${name} ${cost.padStart(7)} ${tokens.padStart(6)} ${elapsed.padStart(7)}`

	if (activity && agent.status === 'running') {
		return `${prefix}  ${truncateToWidth(activity, 50, '\u2026')}`
	}
	if (agent.status === 'failed') {
		const errorStr = error
			? truncateToWidth(error.split('\n')[0] ?? 'unknown error', 60, '\u2026')
			: 'failed'
		if (logPath) {
			const label = `log: ${logPath}`
			return `${prefix}  ${errorStr}  ${truncateToWidth(label, 70, '\u2026')}`
		}
		return `${prefix}  ${errorStr}`
	}
	if (agent.status === 'queued') return `${prefix}  waiting`
	return prefix
}

export interface AgentRow {
	name: string
	status: 'running' | 'completed' | 'failed' | 'queued'
	costUsd: number
	totalTokens: number
	startedAt: string | null
	completedAt: string | null
}

export function collectAgentRows(state: FleetState): AgentRow[] {
	const rows: AgentRow[] = []
	const seen = new Set<string>()

	// Started agents first (in insertion order)
	for (const [name, spec] of state.specialists) {
		seen.add(name)
		const cost = state.costs.get(name)
		rows.push({
			name,
			status: spec.status,
			costUsd: cost?.costUsd ?? 0,
			totalTokens: (cost?.inputTokens ?? 0) + (cost?.outputTokens ?? 0),
			startedAt: spec.startedAt,
			completedAt: spec.completedAt,
		})
	}

	// Queued agents (in members list but not started)
	for (const name of state.members) {
		if (!seen.has(name)) {
			rows.push({ name, status: 'queued', costUsd: 0, totalTokens: 0, startedAt: null, completedAt: null })
		}
	}

	return rows
}

/**
 * Format FleetState into string[] for setWidget rendering.
 * Tree-style layout with per-agent activity shown inline.
 * Fallback for environments without TUI component support.
 */
export function formatStatusTable(state: FleetState, activities?: Map<string, string>, errors?: Map<string, string>, logPaths?: Map<string, string>): string[] {
	const lines: string[] = []
	const agents = collectAgentRows(state)

	// Header
	const phaseLabel = state.phase.charAt(0).toUpperCase() + state.phase.slice(1)
	const totalCost = formatUsd(state.totalCostUsd)
	const budgetStr = state.constraints ? ` / ${formatUsd(state.constraints.maxUsd)}` : ''
	const totalTokens = agents.reduce((sum, a) => sum + a.totalTokens, 0)
	const tokensStr = totalTokens > 0 ? `  ${formatTokens(totalTokens)} tok` : ''
	const rightSide = `${totalCost}${budgetStr}${tokensStr}`
	lines.push(`  Fleet [${phaseLabel}]${' '.repeat(Math.max(1, 60 - phaseLabel.length - rightSide.length))}${rightSide}`)

	// Agent tree rows with inline activity and error messages
	for (let i = 0; i < agents.length; i++) {
		const agent = agents[i]
		const isLast = i === agents.length - 1
		const activity = activities?.get(agent.name)
		const displayActivity = activity ? truncateToWidth(activity, 50, '\u2026') : undefined
		const error = errors?.get(agent.name)
		const logPath = logPaths?.get(agent.name)
		lines.push(formatAgentTreeRow(agent, isLast, displayActivity, error, logPath))
	}

	// Progress bars
	const completedCount = agents.filter((a) => a.status === 'completed').length
	const failedCount = agents.filter((a) => a.status === 'failed').length
	const totalCount = agents.length
	const elapsed = elapsedMs(state.startedAt)

	if (state.constraints) {
		const timeLimitMs = state.constraints.maxMinutes * 60_000
		const timeRatio = timeLimitMs > 0 ? elapsed / timeLimitMs : 0
		const costRatio = state.totalCostUsd / Math.max(0.01, state.constraints.maxUsd)
		lines.push(`  TIME ${progressBar(timeRatio, 16)}  ${formatElapsed(elapsed)} / ${state.constraints.maxMinutes}m    COST ${progressBar(costRatio, 16)}  ${totalCost} / ${formatUsd(state.constraints.maxUsd)}`)
	}

	let summary = `  ${completedCount}/${totalCount} complete`
	if (failedCount > 0) summary += `, ${failedCount} failed`
	if (elapsed > 0 && !state.sessionComplete) summary += ` | ${formatElapsed(elapsed)}`
	if (state.sessionComplete) summary += ` | ${formatElapsed(state.totalDurationMs)} total`
	lines.push(summary)

	return lines
}

/**
 * Format a compact single-line status string for the persistent footer.
 * Example: "Fleet: 3/6 complete | $2.14 / $10.00 | 12m / 30m"
 */
export function formatStatusLine(state: FleetState): string {
	const agents = collectAgentRows(state)
	const completedCount = agents.filter((a) => a.status === 'completed').length
	const totalCount = agents.length

	const costStr = formatUsd(state.totalCostUsd)
	const budgetStr = state.constraints ? ` / ${formatUsd(state.constraints.maxUsd)}` : ''

	const elapsed = elapsedMs(state.startedAt)
	const elapsedStr = formatElapsed(elapsed)
	const limitStr = state.constraints ? ` / ${state.constraints.maxMinutes}m` : ''

	return `Fleet: ${completedCount}/${totalCount} complete | ${costStr}${budgetStr} | ${elapsedStr}${limitStr}`
}
