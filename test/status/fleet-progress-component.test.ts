import { describe, it, expect, vi } from 'vitest'
import { FleetProgressComponent, DEFAULT_COLORS } from '../../src/status/fleet-progress-component.js'
import { emptyFleetState, type FleetState } from '../../src/session/state.js'
import type { TUI } from '@mariozechner/pi-tui'
import { visibleWidth } from '@mariozechner/pi-tui'

// Bracket-marker theme mock — for verifying color mapping
function mockTheme() {
	return {
		fg: (color: string, text: string) => `[fg:${color}]${text}[/fg]`,
		bg: (color: string, text: string) => `[bg:${color}]${text}[/bg]`,
		bold: (text: string) => `[bold]${text}[/bold]`,
		italic: (text: string) => `[italic]${text}[/italic]`,
	} as any
}

// Identity theme mock — for width/layout tests where visibleWidth() must be accurate
function identityTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	} as any
}

function mockTui() {
	return {
		requestRender: vi.fn(),
	} as unknown as TUI
}

function populatedState(): FleetState {
	const state = emptyFleetState()
	state.phase = 'executing'
	state.startedAt = new Date(Date.now() - 5 * 60_000).toISOString()
	state.members = ['developer', 'reviewer', 'architect']
	state.constraints = {
		maxUsd: 10,
		maxMinutes: 30,
		taskTimeoutMs: 120_000,
		maxConcurrency: 3,
	}
	state.specialists.set('developer', {
		agentName: 'developer',
		runId: 'run-001',
		pid: 1234,
		worktreePath: '/wt/dev',
		model: 'sonnet',
		status: 'completed',
		startedAt: null,
		completedAt: null,
		turnCount: 3,
	})
	state.specialists.set('reviewer', {
		agentName: 'reviewer',
		runId: 'run-002',
		pid: 1235,
		worktreePath: '/wt/rev',
		model: 'sonnet',
		status: 'running',
		startedAt: null,
		completedAt: null,
		turnCount: 1,
	})
	state.costs.set('developer', {
		agentName: 'developer',
		inputTokens: 5000,
		outputTokens: 2000,
		costUsd: 1.50,
	})
	state.totalCostUsd = 1.50
	return state
}

describe('FleetProgressComponent', () => {
	it('renders lines with theme color markers', () => {
		const tui = mockTui()
		const theme = mockTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(200)
		const joined = lines.join('\n')

		// Header uses accent color
		expect(joined).toContain('[fg:accent]Fleet [Executing][/fg]')
		// Completed agent uses success color
		expect(joined).toContain('[fg:success]\u2713[/fg]')
		// Running agent uses accent color
		expect(joined).toContain('[fg:accent]\u25cf[/fg]')
		// Queued agent uses dim color
		expect(joined).toContain('[fg:dim]\u25cb[/fg]')
	})

	it('shows agent names and costs', () => {
		const tui = mockTui()
		const theme = mockTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(200)
		const joined = lines.join('\n')

		expect(joined).toContain('developer')
		expect(joined).toContain('reviewer')
		expect(joined).toContain('architect')
		expect(joined).toContain('$1.50')
	})

	it('shows turn counts for agents', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(200)
		const joined = lines.join('\n')

		// developer has 3 turns, reviewer has 1 turn, architect (queued) has 0
		expect(joined).toContain('~3')
		expect(joined).toContain('~1')
		expect(joined).toContain('~0')
	})

	it('renders two agents per row in a grid', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(200)
		// With 3 agents (developer, reviewer, architect):
		// Row 1: developer + reviewer on the same line
		// Row 2: architect alone
		const agentLines = lines.filter((l) => {
			return l.includes('\u2713') || l.includes('\u25cf') || l.includes('\u25cb')
		})
		// 3 agents → 2 grid rows
		expect(agentLines.length).toBe(2)
	})

	it('developer and reviewer appear on the same line', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(200)
		const sharedLine = lines.find((l) => l.includes('developer') && l.includes('reviewer'))
		expect(sharedLine).toBeDefined()
	})

	it('shows progress bars with colored segments', () => {
		const tui = mockTui()
		const theme = mockTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(200)
		const joined = lines.join('\n')

		expect(joined).toContain('TIME')
		expect(joined).toContain('COST')
		// Filled bar uses accent
		expect(joined).toContain('[fg:accent]\u2593')
		// Empty bar uses dim
		expect(joined).toContain('[fg:dim]\u2591')
	})

	it('shows summary line', () => {
		const tui = mockTui()
		const theme = mockTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(200)
		const joined = lines.join('\n')

		expect(joined).toContain('1/3 complete')
	})

	it('caches render output', () => {
		const tui = mockTui()
		const theme = mockTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines1 = comp.render(200)
		const lines2 = comp.render(200)
		expect(lines1).toBe(lines2) // Same reference (cached)
	})

	it('invalidates cache on update', () => {
		const tui = mockTui()
		const theme = mockTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines1 = comp.render(200)
		comp.update(populatedState())
		const lines2 = comp.render(200)
		expect(lines1).not.toBe(lines2) // Different reference (re-rendered)
	})

	it('calls tui.requestRender on update', () => {
		const tui = mockTui()
		const theme = mockTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		expect(tui.requestRender).toHaveBeenCalled()
	})

	it('accepts custom colors', () => {
		const tui = mockTui()
		const theme = mockTheme()
		const comp = new FleetProgressComponent(tui, theme, { header: 'warning' })
		comp.update(populatedState())

		const lines = comp.render(200)
		const joined = lines.join('\n')

		expect(joined).toContain('[fg:warning]Fleet [Executing][/fg]')
	})

	it('handles empty state', () => {
		const tui = mockTui()
		const theme = mockTheme()
		const comp = new FleetProgressComponent(tui, theme)

		const lines = comp.render(200)
		expect(lines).toEqual(['  Fleet: no session'])
	})

	it('shows ~0 turn count for queued agents', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(200)
		const joined = lines.join('\n')

		// architect is queued — should show ~0
		expect(joined).toContain('~0')
	})
})

describe('FleetProgressComponent width handling', () => {
	it('no line exceeds width at w=40', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(40)
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40)
		}
	})

	it('no line exceeds width at w=120', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(120)
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120)
		}
	})

	it('handles width < 40 without exceeding actual width', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		const lines = comp.render(30)
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(30)
		}
	})

	it('truncates long agent names with ellipsis', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)

		const state = emptyFleetState()
		state.phase = 'executing'
		state.members = ['very-long-agent-name-here']
		state.specialists.set('very-long-agent-name-here', {
			agentName: 'very-long-agent-name-here',
			runId: 'run-001',
			pid: 1234,
			worktreePath: '/wt/dev',
			model: 'sonnet',
			status: 'running',
			startedAt: null,
			completedAt: null,
			turnCount: 0,
		})
		comp.update(state)

		const lines = comp.render(80)
		const joined = lines.join('\n')
		// Name should be truncated with ellipsis, not show full name
		expect(joined).not.toContain('very-long-agent-name-here')
		expect(joined).toContain('\u2026') // ellipsis present
	})

	it('stacks progress bars when terminal is narrow', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)
		comp.update(populatedState())

		// At width 40, bars should stack (2 lines instead of 1)
		const narrowLines = comp.render(40)
		comp.invalidate()
		const wideLines = comp.render(200)

		// Narrow should have more lines due to stacked bars
		expect(narrowLines.length).toBeGreaterThanOrEqual(wideLines.length)
	})

	it('omits bar lines when no constraints', () => {
		const tui = mockTui()
		const theme = identityTheme()
		const comp = new FleetProgressComponent(tui, theme)

		const state = populatedState()
		state.constraints = null
		comp.update(state)

		const lines = comp.render(80)
		const hasTime = lines.some(l => l.includes('TIME'))
		expect(hasTime).toBe(false)
	})
})
