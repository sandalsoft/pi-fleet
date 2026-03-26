import type { Component, TUI } from '@mariozechner/pi-tui'
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui'
import type { Theme, ThemeColor } from '@mariozechner/pi-coding-agent'
import type { FleetState } from '../session/state.js'
import { formatTokens, formatUsd, formatElapsed, collectAgentRows, type AgentRow } from './formatter.js'
import type { ActivityStore } from './activity-store.js'

// --- Configurable color mapping ---

export interface FleetWidgetColors {
	header: ThemeColor
	statusRunning: ThemeColor
	statusDone: ThemeColor
	statusFailed: ThemeColor
	statusQueued: ThemeColor
	agentName: ThemeColor
	stats: ThemeColor
	activity: ThemeColor
	barFilled: ThemeColor
	barEmpty: ThemeColor
	barLabel: ThemeColor
	summary: ThemeColor
}

export const DEFAULT_COLORS: FleetWidgetColors = {
	header: 'accent',
	statusRunning: 'accent',
	statusDone: 'success',
	statusFailed: 'error',
	statusQueued: 'dim',
	agentName: 'text',
	stats: 'muted',
	activity: 'dim',
	barFilled: 'accent',
	barEmpty: 'dim',
	barLabel: 'muted',
	summary: 'muted',
}

// --- Status icons ---
const ICON_RUNNING = '\u25cf'   // ●
const ICON_DONE = '\u2713'      // ✓
const ICON_FAILED = '\u2717'    // ✗
const ICON_QUEUED = '\u25cb'    // ○

// --- Progress bar characters ---
const BAR_FILLED = '\u2593' // ▓
const BAR_EMPTY = '\u2591'  // ░

/**
 * TUI Component for rendering the fleet progress widget with theme colors.
 * Two-column grid layout: agents are shown side-by-side, two per row.
 * Each cell: icon  name  ~turns  cost  tokens
 */
export class FleetProgressComponent implements Component {
	private tui: TUI
	private theme: Theme
	private colors: FleetWidgetColors
	private state: FleetState | null = null
	private cachedLines: string[] | null = null
	private cachedWidth: number | null = null

	constructor(tui: TUI, theme: Theme, colors?: Partial<FleetWidgetColors>) {
		this.tui = tui
		this.theme = theme
		this.colors = { ...DEFAULT_COLORS, ...colors }
	}

	update(state: FleetState, _activityStore?: ActivityStore | Map<string, string>, _errors?: Map<string, string>, _logPaths?: Map<string, string>): void {
		this.state = state
		this.invalidate()
		this.tui.requestRender()
	}

	invalidate(): void {
		this.cachedLines = null
		this.cachedWidth = null
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines
		}
		const lines = this.state ? this.renderState(width) : ['  Fleet: no session']
		this.cachedLines = lines
		this.cachedWidth = width
		return lines
	}

	dispose(): void {
		this.state = null
	}

	// --- Private rendering ---

	private renderState(width: number): string[] {
		const state = this.state!
		const th = this.theme
		const c = this.colors
		const lines: string[] = []
		const agents = collectAgentRows(state)
		const layoutWidth = Math.max(40, width)

		// Header: full-width, left phase + right stats
		const phaseLabel = state.phase.charAt(0).toUpperCase() + state.phase.slice(1)
		const totalCost = formatUsd(state.totalCostUsd)
		const budgetStr = state.constraints ? ` / ${formatUsd(state.constraints.maxUsd)}` : ''
		const totalTokens = agents.reduce((sum, a) => sum + a.totalTokens, 0)
		const tokensStr = totalTokens > 0 ? `  ${formatTokens(totalTokens)} tok` : ''
		const headerLeft = th.fg(c.header, `Fleet [${phaseLabel}]`)
		const headerRight = th.fg(c.stats, `${totalCost}${budgetStr}${tokensStr}`)
		const headerPad = Math.max(1, layoutWidth - 4 - visibleWidth(headerLeft) - visibleWidth(headerRight))
		lines.push(truncateToWidth(`  ${headerLeft}${' '.repeat(headerPad)}${headerRight}`, width, ''))

		// Two-column agent grid
		const colWidth = Math.floor((layoutWidth - 2) / 2)
		for (let i = 0; i < agents.length; i += 2) {
			const left = agents[i]
			const right = agents[i + 1]
			const leftCell = this.renderAgentCell(left, colWidth)
			if (right) {
				const rightCell = this.renderAgentCell(right, colWidth)
				lines.push(truncateToWidth(`  ${leftCell}${rightCell}`, width, ''))
			} else {
				lines.push(truncateToWidth(`  ${leftCell}`, width, ''))
			}
		}

		// Progress bars — full width
		if (state.constraints) {
			const elapsedMs = this.elapsedMs(state.startedAt)
			const timeLimitMs = state.constraints.maxMinutes * 60_000
			const timeRatio = timeLimitMs > 0 ? elapsedMs / timeLimitMs : 0
			const costRatio = state.constraints.maxUsd > 0 ? state.totalCostUsd / state.constraints.maxUsd : 0

			const timeLabel = th.fg(c.barLabel, 'TIME')
			const costLabel = th.fg(c.barLabel, 'COST')
			const timeStats = th.fg(c.stats, `${formatElapsed(elapsedMs)} / ${state.constraints.maxMinutes}m`)
			const costStats = th.fg(c.stats, `${totalCost} / ${formatUsd(state.constraints.maxUsd)}`)

			// Measure fixed content to compute dynamic bar widths
			const fixedWidth = visibleWidth(timeLabel) + visibleWidth(timeStats) + visibleWidth(costLabel) + visibleWidth(costStats) + 12
			const availableForBars = layoutWidth - fixedWidth
			const minBarWidth = 8

			if (availableForBars >= minBarWidth * 2) {
				// Side-by-side layout
				const barWidth = Math.max(minBarWidth, Math.floor(availableForBars / 2))
				const timeBar = this.renderBar(timeRatio, barWidth)
				const costBar = this.renderBar(costRatio, barWidth)
				lines.push(truncateToWidth(`  ${timeLabel} ${timeBar} ${timeStats}    ${costLabel} ${costBar} ${costStats}`, width, ''))
			} else {
				// Stacked layout for narrow terminals
				const barWidth = Math.max(minBarWidth, layoutWidth - visibleWidth(timeLabel) - visibleWidth(timeStats) - 6)
				const timeBar = this.renderBar(timeRatio, barWidth)
				const costBar = this.renderBar(costRatio, barWidth)
				lines.push(truncateToWidth(`  ${timeLabel} ${timeBar} ${timeStats}`, width, ''))
				lines.push(truncateToWidth(`  ${costLabel} ${costBar} ${costStats}`, width, ''))
			}
		}

		// Summary
		const completedCount = agents.filter((a) => a.status === 'completed').length
		const failedCount = agents.filter((a) => a.status === 'failed').length
		const totalCount = agents.length
		const elapsed = this.elapsedMs(state.startedAt)

		let summary = `${completedCount}/${totalCount} complete`
		if (failedCount > 0) summary += `, ${failedCount} failed`
		if (elapsed > 0 && !state.sessionComplete) summary += ` | ${formatElapsed(elapsed)}`
		if (state.sessionComplete) summary += ` | ${formatElapsed(state.totalDurationMs)} total`

		lines.push(truncateToWidth(`  ${th.fg(c.summary, summary)}`, width, ''))

		return lines
	}

	/**
	 * Render a single agent cell for the 2-column grid.
	 * Format: icon  name (padded)  ~turns  cost  tokens
	 */
	private renderAgentCell(agent: AgentRow, colWidth: number): string {
		const th = this.theme
		const c = this.colors

		let iconColor: ThemeColor
		let icon: string
		switch (agent.status) {
			case 'running': icon = ICON_RUNNING; iconColor = c.statusRunning; break
			case 'completed': icon = ICON_DONE; iconColor = c.statusDone; break
			case 'failed': icon = ICON_FAILED; iconColor = c.statusFailed; break
			default: icon = ICON_QUEUED; iconColor = c.statusQueued; break
		}

		const coloredIcon = th.fg(iconColor, icon)
		const maxName = Math.max(8, colWidth - 26)
		const name = truncateToWidth(agent.name, maxName, '\u2026').padEnd(maxName)
		const coloredName = th.fg(c.agentName, name)

		const turns = `~${agent.turnCount}`.padStart(3)
		const cost = (agent.costUsd > 0 ? formatUsd(agent.costUsd) : '-').padStart(6)
		const tokens = (agent.totalTokens > 0 ? formatTokens(agent.totalTokens) : '-').padStart(5)
		const statsBlock = th.fg(c.stats, `${turns}  ${cost}  ${tokens}`)

		// Pad the whole cell to colWidth so the two columns align
		const rawCell = `${coloredIcon} ${coloredName} ${statsBlock}`
		return rawCell.padEnd(colWidth)
	}

	private renderBar(ratio: number, barWidth: number): string {
		const th = this.theme
		const c = this.colors
		const clamped = Math.max(0, Math.min(1, ratio))
		const filled = Math.round(clamped * barWidth)
		const empty = barWidth - filled
		return th.fg(c.barFilled, BAR_FILLED.repeat(filled)) + th.fg(c.barEmpty, BAR_EMPTY.repeat(empty))
	}

	private elapsedMs(startedAt: string | null): number {
		if (!startedAt) return 0
		return Math.max(0, Date.now() - new Date(startedAt).getTime())
	}
}
