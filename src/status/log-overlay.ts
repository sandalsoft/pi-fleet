import type { Component } from '@mariozechner/pi-tui'
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui'
import { matchesKey } from '@mariozechner/pi-tui'
import type { Theme, ThemeColor } from '@mariozechner/pi-coding-agent'
import type { ActivityEntry } from './activity-store.js'

/**
 * Scrollable overlay component showing the full fleet activity log.
 * Opened by /fleet-log via ctx.ui.custom().
 */
export class FleetLogOverlay implements Component {
	private theme: Theme
	private entries: ActivityEntry[]
	private sessionStart: number
	private scrollOffset = 0
	private onClose: () => void
	private cachedLines: string[] | null = null
	private cachedWidth: number | null = null

	constructor(theme: Theme, entries: ActivityEntry[], sessionStart: number, onClose: () => void) {
		this.theme = theme
		this.entries = entries
		this.sessionStart = sessionStart
		this.onClose = onClose
		// Start scrolled to bottom
		this.scrollOffset = Math.max(0, entries.length - 10)
	}

	handleInput(data: string): void {
		if (matchesKey(data, 'escape') || matchesKey(data, 'q')) {
			this.onClose()
			return
		}
		if (matchesKey(data, 'up') || matchesKey(data, 'k')) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1)
			this.invalidate()
		}
		if (matchesKey(data, 'down') || matchesKey(data, 'j')) {
			this.scrollOffset = Math.min(
				Math.max(0, this.entries.length - 5),
				this.scrollOffset + 1,
			)
			this.invalidate()
		}
		if (matchesKey(data, 'pageUp')) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 10)
			this.invalidate()
		}
		if (matchesKey(data, 'pageDown')) {
			this.scrollOffset = Math.min(
				Math.max(0, this.entries.length - 5),
				this.scrollOffset + 10,
			)
			this.invalidate()
		}
	}

	invalidate(): void {
		this.cachedLines = null
		this.cachedWidth = null
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines
		}

		const th = this.theme
		const lines: string[] = []
		const w = Math.max(40, width)

		// Header
		const title = th.fg('accent', 'Fleet Activity Log')
		const hint = th.fg('dim', '\u2191\u2193 scroll  ESC close')
		const headerPad = Math.max(1, w - 4 - visibleWidth(title) - visibleWidth(hint))
		lines.push(`  ${title}${' '.repeat(headerPad)}${hint}`)
		lines.push(`  ${th.fg('dim', '\u2500'.repeat(Math.min(w - 4, 80)))}`)

		if (this.entries.length === 0) {
			lines.push(`  ${th.fg('dim', 'No activity recorded yet.')}`)
			this.cachedLines = lines
			this.cachedWidth = width
			return lines
		}

		// Visible window
		const maxVisible = 20
		const start = this.scrollOffset
		const end = Math.min(start + maxVisible, this.entries.length)

		// Agent color cycling
		const agentColors: ThemeColor[] = ['accent', 'success', 'warning', 'error', 'muted']
		const agentColorMap = new Map<string, ThemeColor>()
		let colorIdx = 0

		for (let i = start; i < end; i++) {
			const entry = this.entries[i]
			const elapsed = Math.floor((entry.timestamp - this.sessionStart) / 1000)
			const min = Math.floor(elapsed / 60)
			const sec = elapsed % 60
			const timeStr = th.fg('dim', `[${min}:${String(sec).padStart(2, '0')}]`)

			if (!agentColorMap.has(entry.agentName)) {
				agentColorMap.set(entry.agentName, agentColors[colorIdx % agentColors.length])
				colorIdx++
			}
			const agentColor = agentColorMap.get(entry.agentName)!
			const agentStr = th.fg(agentColor, entry.agentName.padEnd(14))

			const text = th.fg('text', entry.text)
			lines.push(truncateToWidth(`  ${timeStr} ${agentStr} ${text}`, w))
		}

		// Scroll indicator
		if (this.entries.length > maxVisible) {
			const pos = `${start + 1}-${end} of ${this.entries.length}`
			lines.push(`  ${th.fg('dim', pos)}`)
		}

		this.cachedLines = lines
		this.cachedWidth = width
		return lines
	}

	dispose(): void {
		this.entries = []
	}
}
