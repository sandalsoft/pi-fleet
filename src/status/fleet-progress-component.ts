import type { Component, TUI } from '@mariozechner/pi-tui'
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui'
import type { Theme, ThemeColor } from '@mariozechner/pi-coding-agent'
import type { FleetState } from '../session/state.js'
import { formatTokens, formatUsd, formatAgentElapsed, formatElapsed, collectAgentRows, type AgentRow } from './formatter.js'
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
	tree: ThemeColor
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
	tree: 'dim',
}

// --- Status icons ---
const ICON_RUNNING = '\u25cf'   // ●
const ICON_DONE = '\u2713'      // ✓
const ICON_FAILED = '\u2717'    // ✗
const ICON_QUEUED = '\u25cb'    // ○

// --- Tree drawing ---
const TREE_MID = '\u251c\u2500' // ├─
const TREE_END = '\u2514\u2500' // └─

// --- Progress bar characters ---
const BAR_FILLED = '\u2593' // ▓
const BAR_EMPTY = '\u2591'  // ░

/**
 * TUI Component for rendering the fleet progress widget with theme colors.
 * Tree-style layout with per-agent activity shown inline.
 */
export class FleetProgressComponent implements Component {
	private tui: TUI
	private theme: Theme
	private colors: FleetWidgetColors
	private state: FleetState | null = null
	private activityStore: ActivityStore | null = null
	private errors: Map<string, string> = new Map()
	private logPaths: Map<string, string> = new Map()
	private cachedLines: string[] | null = null
	private cachedWidth: number | null = null

	constructor(tui: TUI, theme: Theme, colors?: Partial<FleetWidgetColors>) {
		this.tui = tui
		this.theme = theme
		this.colors = { ...DEFAULT_COLORS, ...colors }
	}

	update(state: FleetState, activityStore?: ActivityStore | Map<string, string>, errors?: Map<string, string>, logPaths?: Map<string, string>): void {
		this.state = state
		if (activityStore && 'getRecentActivities' in activityStore) {
			this.activityStore = activityStore as ActivityStore
		}
		if (errors) this.errors = errors
		if (logPaths) this.logPaths = logPaths
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
		this.activityStore = null
	}

	// --- Private rendering ---

	private renderState(width: number): string[] {
		const state = this.state!
		const th = this.theme
		const c = this.colors
		const lines: string[] = []
		const agents = collectAgentRows(state)
		// layoutWidth for column positioning; width for output truncation
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

		// Dynamic overhead: header(1) + summary(1) + bar lines (0/1/2)
		let overheadLines = 2 // header + summary
		if (state.constraints) {
			// Determine bar layout: side-by-side vs stacked
			const timeLabel = th.fg(c.barLabel, 'TIME')
			const costLabel = th.fg(c.barLabel, 'COST')
			const elapsedMs = this.elapsedMs(state.startedAt)
			const timeStats = th.fg(c.stats, `${formatElapsed(elapsedMs)} / ${state.constraints.maxMinutes}m`)
			const costStats = th.fg(c.stats, `${totalCost} / ${formatUsd(state.constraints.maxUsd)}`)

			// Measure what fixed content consumes (labels + stats + spacing)
			const fixedWidth = visibleWidth(timeLabel) + visibleWidth(timeStats) + visibleWidth(costLabel) + visibleWidth(costStats) + 12 // spaces/padding
			const availableForBars = layoutWidth - fixedWidth
			const minBarWidth = 8

			if (availableForBars >= minBarWidth * 2) {
				overheadLines = 3 // side-by-side (1 bar line)
			} else {
				overheadLines = 4 // stacked (2 bar lines)
			}
		}

		// Dynamic height budget: cap total widget at ~18 lines
		const MAX_WIDGET_LINES = 18
		const maxSubItems = Math.max(1, Math.floor((MAX_WIDGET_LINES - agents.length - overheadLines) / Math.max(1, agents.length)))

		// Agent tree with sub-items showing recent activity
		for (let i = 0; i < agents.length; i++) {
			const agent = agents[i]
			const isLast = i === agents.length - 1
			const treeBranch = th.fg(c.tree, isLast ? TREE_END : TREE_MID)
			const treeVert = isLast ? '   ' : th.fg(c.tree, '\u2502  ') // │  or spaces

			// Agent header row
			lines.push(truncateToWidth(this.renderAgentRow(agent, layoutWidth, treeBranch), width, ''))

			// Sub-tree: recent activities or error
			const subItems = this.getAgentSubItems(agent, maxSubItems)
			for (let j = 0; j < subItems.length; j++) {
				const subIsLast = j === subItems.length - 1
				const subBranch = th.fg(c.tree, subIsLast ? TREE_END : TREE_MID)
				const subLine = `  ${treeVert}${subBranch} ${subItems[j]}`
				lines.push(truncateToWidth(subLine, width, ''))
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

	private renderAgentRow(agent: AgentRow, _width: number, treeBranch: string): string {
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
		const name = truncateToWidth(agent.name, 14, '\u2026')
		const coloredName = th.fg(c.agentName, name.padEnd(14))

		const cost = agent.costUsd > 0 ? formatUsd(agent.costUsd) : '-'
		const tokens = agent.totalTokens > 0 ? formatTokens(agent.totalTokens) : '-'
		const elapsed = formatAgentElapsed(agent.startedAt, agent.completedAt)
		const statsBlock = th.fg(c.stats, `${cost.padStart(7)} ${tokens.padStart(6)} ${elapsed.padStart(7)}`)

		return `  ${treeBranch} ${coloredIcon} ${coloredName} ${statsBlock}`
	}

	/**
	 * Get sub-tree items for an agent: recent activities, error, or status.
	 * Returns themed strings ready to render.
	 */
	private getAgentSubItems(agent: AgentRow, maxItems: number): string[] {
		const th = this.theme
		const c = this.colors

		// Failed: show error + log path
		if (agent.status === 'failed') {
			const items: string[] = []
			const error = this.errors.get(agent.name)
			if (error) {
				const firstLine = error.split('\n')[0] ?? 'unknown error'
				items.push(th.fg(c.statusFailed, truncateToWidth(firstLine, 70, '\u2026')))
			} else {
				items.push(th.fg(c.statusFailed, 'failed'))
			}
			const logPath = this.logPaths.get(agent.name)
			if (logPath) {
				const label = `log: ${logPath}`
				items.push(th.fg(c.activity, truncateToWidth(label, 70, '\u2026')))
			}
			return items
		}

		// Queued: just show waiting
		if (agent.status === 'queued') {
			return [th.fg(c.statusQueued, 'waiting')]
		}

		// Running/completed: show recent activities from store
		if (this.activityStore) {
			const recent = this.activityStore.getRecentActivities(agent.name, maxItems)
			if (recent.length > 0) {
				return recent.map((entry) => {
					return th.fg(c.activity, truncateToWidth(entry.text, 70, '\u2026'))
				})
			}
		}

		// No activities recorded
		if (agent.status === 'completed') {
			return [th.fg(c.statusDone, 'done')]
		}
		return [th.fg(c.activity, 'starting...')]
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
