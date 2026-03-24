import type { FleetState } from '../session/state.js'

/**
 * Unicode box-drawing table renderer for fleet status.
 * Produces plain text (no ANSI escapes) suitable for ctx.ui.setWidget.
 */

interface ColumnDef {
	header: string
	width: number
	align: 'left' | 'right'
}

const COLUMNS: ColumnDef[] = [
	{ header: 'Agent', width: 18, align: 'left' },
	{ header: 'Model', width: 22, align: 'left' },
	{ header: 'Status', width: 11, align: 'left' },
	{ header: 'Cost', width: 10, align: 'right' },
	{ header: 'Elapsed', width: 10, align: 'right' },
]

function pad(text: string, width: number, align: 'left' | 'right'): string {
	const truncated = text.length > width ? text.slice(0, width - 1) + '\u2026' : text
	return align === 'right' ? truncated.padStart(width) : truncated.padEnd(width)
}

function formatUsd(amount: number): string {
	return `$${amount.toFixed(2)}`
}

function formatElapsed(ms: number): string {
	if (ms <= 0) return '-'
	const totalSeconds = Math.floor(ms / 1000)
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	if (minutes === 0) return `${seconds}s`
	return `${minutes}m ${seconds}s`
}

function formatElapsedFromTimestamp(startedAt: string | null): string {
	if (!startedAt) return '-'
	const elapsed = Date.now() - new Date(startedAt).getTime()
	return formatElapsed(elapsed)
}

// Box-drawing characters
const BOX = {
	topLeft: '\u250c',
	topRight: '\u2510',
	bottomLeft: '\u2514',
	bottomRight: '\u2518',
	horizontal: '\u2500',
	vertical: '\u2502',
	teeDown: '\u252c',
	teeUp: '\u2534',
	teeRight: '\u251c',
	teeLeft: '\u2524',
	cross: '\u253c',
}

function horizontalLine(left: string, mid: string, right: string): string {
	return left + COLUMNS.map((c) => BOX.horizontal.repeat(c.width + 2)).join(mid) + right
}

function dataRow(cells: string[]): string {
	return (
		BOX.vertical +
		cells.map((cell, i) => ` ${pad(cell, COLUMNS[i].width, COLUMNS[i].align)} `).join(BOX.vertical) +
		BOX.vertical
	)
}

/**
 * Format FleetState into string[] for setWidget rendering.
 * Compact table with Unicode box-drawing borders.
 */
export function formatStatusTable(state: FleetState): string[] {
	const lines: string[] = []

	// Top border
	lines.push(horizontalLine(BOX.topLeft, BOX.teeDown, BOX.topRight))

	// Header row
	lines.push(dataRow(COLUMNS.map((c) => c.header)))

	// Header separator
	lines.push(horizontalLine(BOX.teeRight, BOX.cross, BOX.teeLeft))

	// Agent rows
	const agents = Array.from(state.specialists.values())
	// Also show queued members that haven't started yet
	const startedNames = new Set(agents.map((a) => a.agentName))
	const queuedMembers = state.members.filter((m) => !startedNames.has(m))

	for (const agent of agents) {
		const cost = state.costs.get(agent.agentName)
		const costStr = cost ? formatUsd(cost.costUsd) : '$0.00'
		const elapsed = agent.status === 'running' ? formatElapsedFromTimestamp(state.startedAt) : '-'

		lines.push(
			dataRow([agent.agentName, agent.model, agent.status, costStr, elapsed])
		)
	}

	for (const name of queuedMembers) {
		lines.push(dataRow([name, '-', 'queued', '$0.00', '-']))
	}

	// Totals separator
	if (agents.length > 0 || queuedMembers.length > 0) {
		lines.push(horizontalLine(BOX.teeRight, BOX.cross, BOX.teeLeft))
	}

	// Totals row
	const totalAgents = agents.length + queuedMembers.length
	const completedCount = agents.filter((a) => a.status === 'completed').length
	const totalCost = formatUsd(state.totalCostUsd)
	const totalElapsed = state.sessionComplete
		? formatElapsed(state.totalDurationMs)
		: formatElapsedFromTimestamp(state.startedAt)

	lines.push(
		dataRow([`Total (${completedCount}/${totalAgents})`, '', state.phase, totalCost, totalElapsed])
	)

	// Budget/time remaining
	if (state.constraints) {
		const budgetRemaining = Math.max(0, state.constraints.maxUsd - state.totalCostUsd)
		const elapsedMs = state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0
		const timeRemainingMs = Math.max(0, state.constraints.maxMinutes * 60_000 - elapsedMs)
		const timeRemaining = formatElapsed(timeRemainingMs)

		lines.push(
			dataRow(['Remaining', '', '', formatUsd(budgetRemaining), timeRemaining])
		)
	}

	// Bottom border
	lines.push(horizontalLine(BOX.bottomLeft, BOX.teeUp, BOX.bottomRight))

	return lines
}

/**
 * Format a compact single-line status string for the persistent footer.
 * Example: "Fleet: 3/6 agents complete | $2.14 / $10.00 | 12m / 30m"
 */
export function formatStatusLine(state: FleetState): string {
	const agents = Array.from(state.specialists.values())
	const completedCount = agents.filter((a) => a.status === 'completed').length
	const totalCount = Math.max(agents.length, state.members.length)

	const costStr = formatUsd(state.totalCostUsd)
	const budgetStr = state.constraints ? ` / ${formatUsd(state.constraints.maxUsd)}` : ''

	const elapsedMs = state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0
	const elapsedStr = formatElapsed(elapsedMs)
	const limitStr = state.constraints ? ` / ${state.constraints.maxMinutes}m` : ''

	return `Fleet: ${completedCount}/${totalCount} agents complete | ${costStr}${budgetStr} | ${elapsedStr}${limitStr}`
}
