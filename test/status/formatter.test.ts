import { describe, it, expect } from 'vitest'
import {
	formatStatusTable,
	formatStatusLine,
	formatTokens,
	formatUsd,
	progressBar,
	formatAgentElapsed,
	collectAgentRows,
} from '../../src/status/formatter.js'
import { emptyFleetState, type FleetState } from '../../src/session/state.js'

function populatedState(): FleetState {
	const state = emptyFleetState()
	state.phase = 'executing'
	state.startedAt = new Date(Date.now() - 12 * 60_000).toISOString() // 12 min ago
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
		model: 'claude-sonnet-4-20250514',
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
		model: 'claude-sonnet-4-20250514',
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
	state.costs.set('reviewer', {
		agentName: 'reviewer',
		inputTokens: 3000,
		outputTokens: 1000,
		costUsd: 0.64,
	})
	state.totalCostUsd = 2.14

	return state
}

describe('formatTokens', () => {
	it('returns dash for zero', () => {
		expect(formatTokens(0)).toBe('-')
	})

	it('formats small counts as-is', () => {
		expect(formatTokens(500)).toBe('500')
	})

	it('formats thousands with one decimal', () => {
		expect(formatTokens(7000)).toBe('7.0k')
	})

	it('formats large thousands without decimal', () => {
		expect(formatTokens(150_000)).toBe('150k')
	})

	it('formats millions', () => {
		expect(formatTokens(1_500_000)).toBe('1.5M')
	})
})

describe('progressBar', () => {
	it('returns all empty at 0%', () => {
		const bar = progressBar(0, 10)
		expect(bar).toBe('\u2591'.repeat(10))
	})

	it('returns all filled at 100%', () => {
		const bar = progressBar(1, 10)
		expect(bar).toBe('\u2593'.repeat(10))
	})

	it('returns half filled at 50%', () => {
		const bar = progressBar(0.5, 10)
		expect(bar).toBe('\u2593'.repeat(5) + '\u2591'.repeat(5))
	})

	it('clamps to bounds', () => {
		expect(progressBar(-0.5, 10)).toBe('\u2591'.repeat(10))
		expect(progressBar(1.5, 10)).toBe('\u2593'.repeat(10))
	})
})

describe('formatStatusTable', () => {
	it('returns an array of strings', () => {
		const lines = formatStatusTable(populatedState())
		expect(Array.isArray(lines)).toBe(true)
		expect(lines.length).toBeGreaterThan(0)
	})

	it('shows phase in header', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')
		expect(joined).toContain('Executing')
	})

	it('shows total cost and tokens in header', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')
		expect(joined).toContain('$2.14')
		// 5000+2000+3000+1000 = 11000 = "11.0k"
		expect(joined).toContain('11.0k tok')
	})

	it('shows running and completed agents with status icons', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('developer')
		expect(joined).toContain('reviewer')
		// Check mark for completed
		expect(joined).toContain('\u2713')
		// Filled circle for running
		expect(joined).toContain('\u25cf')
	})

	it('shows queued agents with open circle icon', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('architect')
		// Open circle for queued
		expect(joined).toContain('\u25cb')
	})

	it('shows cost per agent', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('$1.50')
		expect(joined).toContain('$0.64')
	})

	it('shows token counts per agent', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		// developer: 5000 + 2000 = 7000 tokens = "7.0k"
		expect(joined).toContain('7.0k')
		// reviewer: 3000 + 1000 = 4000 tokens = "4.0k"
		expect(joined).toContain('4.0k')
	})

	it('shows turn counts for agents', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		// developer has 3 turns, reviewer has 1, architect (queued) has 0
		expect(joined).toContain('~3')
		expect(joined).toContain('~1')
		expect(joined).toContain('~0')
	})

	it('renders two agents per row in a grid', () => {
		const lines = formatStatusTable(populatedState())
		// Lines containing status icons indicate agent rows
		const agentLines = lines.filter((l) => l.includes('\u2713') || l.includes('\u25cf') || l.includes('\u25cb'))
		// 3 agents → 2 grid rows
		expect(agentLines.length).toBe(2)
	})

	it('developer and reviewer appear on the same line', () => {
		const lines = formatStatusTable(populatedState())
		const sharedLine = lines.find((l) => l.includes('developer') && l.includes('reviewer'))
		expect(sharedLine).toBeDefined()
	})

	it('shows progress bars when constraints exist', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('TIME')
		expect(joined).toContain('COST')
		// Contains progress bar characters
		expect(joined).toContain('\u2593')
		expect(joined).toContain('\u2591')
	})

	it('shows budget limit in progress bar', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('$10.00')
		expect(joined).toContain('30m')
	})

	it('shows completion summary', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('1/3 complete')
	})

	it('shows failed count in summary when agents have failed', () => {
		const state = populatedState()
		state.specialists.set('reviewer', {
			...state.specialists.get('reviewer')!,
			status: 'failed',
		})

		const lines = formatStatusTable(state)
		const joined = lines.join('\n')

		expect(joined).toContain('1 failed')
	})

	it('handles empty state gracefully', () => {
		const lines = formatStatusTable(emptyFleetState())
		expect(lines.length).toBeGreaterThan(0)
		const joined = lines.join('\n')
		expect(joined).toContain('0/0 complete')
	})
})

describe('formatStatusLine', () => {
	it('returns a single-line summary', () => {
		const line = formatStatusLine(populatedState())

		expect(line).toContain('Fleet:')
		expect(line).toContain('complete')
		expect(line).toContain('$2.14')
		expect(line).toContain('$10.00')
	})

	it('includes completion ratio', () => {
		const line = formatStatusLine(populatedState())
		// 1 completed out of 3 members
		expect(line).toContain('1/3')
	})

	it('includes budget limit from constraints', () => {
		const line = formatStatusLine(populatedState())
		expect(line).toContain('/ $10.00')
	})

	it('includes time limit from constraints', () => {
		const line = formatStatusLine(populatedState())
		expect(line).toContain('/ 30m')
	})

	it('works without constraints', () => {
		const state = populatedState()
		state.constraints = null
		const line = formatStatusLine(state)

		expect(line).toContain('Fleet:')
		expect(line).not.toContain('/ $')
	})
})

describe('formatAgentElapsed', () => {
	const fixedNow = new Date('2026-03-25T12:05:00.000Z').getTime()

	it('returns dash for null startedAt', () => {
		expect(formatAgentElapsed(null, null)).toBe('-')
	})

	it('returns dash for NaN startedAt', () => {
		expect(formatAgentElapsed('not-a-date', null)).toBe('-')
	})

	it('returns dash for NaN completedAt', () => {
		expect(formatAgentElapsed('2026-03-25T12:00:00.000Z', 'bad-date')).toBe('-')
	})

	it('shows elapsed for running agent using now parameter', () => {
		const result = formatAgentElapsed('2026-03-25T12:00:00.000Z', null, fixedNow)
		expect(result).toBe('5m 0s')
	})

	it('shows duration for completed agent', () => {
		const result = formatAgentElapsed(
			'2026-03-25T12:00:00.000Z',
			'2026-03-25T12:02:30.000Z',
		)
		expect(result).toBe('2m 30s')
	})

	it('clamps negative duration to 0s', () => {
		const result = formatAgentElapsed(
			'2026-03-25T12:05:00.000Z',
			'2026-03-25T12:00:00.000Z',
		)
		expect(result).toBe('0s')
	})

	it('returns 0s for zero-length duration', () => {
		const ts = '2026-03-25T12:00:00.000Z'
		expect(formatAgentElapsed(ts, ts)).toBe('0s')
	})

	it('returns dash for empty string completedAt', () => {
		expect(formatAgentElapsed('2026-03-25T12:00:00.000Z', '')).toBe('-')
	})
})

describe('collectAgentRows', () => {
	it('returns rows for started and queued agents', () => {
		const state = populatedState()
		const rows = collectAgentRows(state)

		expect(rows.length).toBe(3)
		expect(rows[0].name).toBe('developer')
		expect(rows[0].status).toBe('completed')
		expect(rows[1].name).toBe('reviewer')
		expect(rows[1].status).toBe('running')
		expect(rows[2].name).toBe('architect')
		expect(rows[2].status).toBe('queued')
	})

	it('computes totalTokens from input+output', () => {
		const state = populatedState()
		const rows = collectAgentRows(state)

		expect(rows[0].totalTokens).toBe(7000) // 5000+2000
		expect(rows[1].totalTokens).toBe(4000) // 3000+1000
	})

	it('returns empty array for empty state', () => {
		const rows = collectAgentRows(emptyFleetState())
		expect(rows).toEqual([])
	})

	it('includes startedAt and completedAt from specialist record', () => {
		const state = populatedState()
		state.specialists.get('developer')!.startedAt = '2026-03-25T12:00:00.000Z'
		state.specialists.get('developer')!.completedAt = '2026-03-25T12:02:00.000Z'

		const rows = collectAgentRows(state)
		expect(rows[0].startedAt).toBe('2026-03-25T12:00:00.000Z')
		expect(rows[0].completedAt).toBe('2026-03-25T12:02:00.000Z')
	})

	it('includes turnCount from specialist record', () => {
		const state = populatedState()
		const rows = collectAgentRows(state)
		expect(rows[0].turnCount).toBe(3) // developer
		expect(rows[1].turnCount).toBe(1) // reviewer
		expect(rows[2].turnCount).toBe(0) // architect (queued)
	})
})

describe('formatter agent name truncation', () => {
	it('truncates long agent names with ellipsis', () => {
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

		const lines = formatStatusTable(state)
		const joined = lines.join('\n')
		expect(joined).not.toContain('very-long-agent-name-here')
		expect(joined).toContain('\u2026')
	})
})
