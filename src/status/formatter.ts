import type { FleetState } from '../session/state.js'
import { truncateToWidth } from '@mariozechner/pi-tui'

/**
 * Status formatter for fleet progress display.
 *
 * Produces a compact, information-dense widget showing:
 * - Phase header with total cost
 * - Two-column agent grid with status icons, turn count, cost, and token counts
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

export interface AgentRow {
	name: string
	status: 'running' | 'completed' | 'failed' | 'queued'
	costUsd: number
	totalTokens: number
	turnCount: number
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
			turnCount: spec.turnCount,
			startedAt: spec.startedAt,
			completedAt: spec.completedAt,
		})
	}

	// Queued agents (in members list but not started)
	for (const name of state.members) {
		if (!seen.has(name)) {
			rows.push({ name, status: 'queued', costUsd: 0, totalTokens: 0, turnCount: 0, startedAt: null, completedAt: null })
		}
	}

	return rows
}

/**
 * Format a single agent cell for the 2-column grid (plain text, no ANSI).
 * Format: icon  name (padded)  ~turns  cost  tokens
 */
function formatAgentCell(agent: AgentRow, colWidth: number): string {
	const icon = statusIcon(agent.status)
	const maxName = Math.max(8, colWidth - 26)
	const name = agent.name.length > maxName
		? truncateToWidth(agent.name, maxName, '\u2026')
		: agent.name.padEnd(maxName)
	const turns = `~${agent.turnCount}`.padStart(3)
	const cost = (agent.costUsd > 0 ? formatUsd(agent.costUsd) : '-').padStart(6)
	const tokens = (agent.totalTokens > 0 ? formatTokens(agent.totalTokens) : '-').padStart(5)
	const cell = `${icon} ${name} ${turns}  ${cost}  ${tokens}`
	return cell.padEnd(colWidth)
}

/**
 * Format FleetState into string[] for setWidget rendering.
 * Two-column grid layout: agents shown side-by-side, two per row.
 * Fallback for environments without TUI component support.
 */
export function formatStatusTable(state: FleetState, _activities?: Map<string, string>, _errors?: Map<string, string>, _logPaths?: Map<string, string>): string[] {
	const lines: string[] = []
	const agents = collectAgentRows(state)
	const TOTAL_WIDTH = 80
	const colWidth = Math.floor(TOTAL_WIDTH / 2)

	// Header
	const phaseLabel = state.phase.charAt(0).toUpperCase() + state.phase.slice(1)
	const totalCost = formatUsd(state.totalCostUsd)
	const budgetStr = state.constraints ? ` / ${formatUsd(state.constraints.maxUsd)}` : ''
	const totalTokens = agents.reduce((sum, a) => sum + a.totalTokens, 0)
	const tokensStr = totalTokens > 0 ? `  ${formatTokens(totalTokens)} tok` : ''
	const rightSide = `${totalCost}${budgetStr}${tokensStr}`
	const headerLeft = `Fleet [${phaseLabel}]`
	const pad = Math.max(1, TOTAL_WIDTH - headerLeft.length - rightSide.length)
	lines.push(`  ${headerLeft}${' '.repeat(pad)}${rightSide}`)

	// Two-column agent grid
	for (let i = 0; i < agents.length; i += 2) {
		const left = formatAgentCell(agents[i], colWidth)
		const right = agents[i + 1] ? formatAgentCell(agents[i + 1], colWidth) : ''
		lines.push(`  ${left}${right}`.trimEnd())
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
