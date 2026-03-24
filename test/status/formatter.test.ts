import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatStatusTable, formatStatusLine } from '../../src/status/formatter.js'
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
	})
	state.specialists.set('reviewer', {
		agentName: 'reviewer',
		runId: 'run-002',
		pid: 1235,
		worktreePath: '/wt/rev',
		model: 'claude-sonnet-4-20250514',
		status: 'running',
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

describe('formatStatusTable', () => {
	it('returns an array of strings', () => {
		const lines = formatStatusTable(populatedState())
		expect(Array.isArray(lines)).toBe(true)
		expect(lines.length).toBeGreaterThan(0)
	})

	it('contains box-drawing borders', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		// Top-left corner
		expect(joined).toContain('\u250c')
		// Bottom-right corner
		expect(joined).toContain('\u2518')
		// Vertical separator
		expect(joined).toContain('\u2502')
	})

	it('shows header row with all columns', () => {
		const lines = formatStatusTable(populatedState())
		const headerLine = lines[1]

		expect(headerLine).toContain('Agent')
		expect(headerLine).toContain('Model')
		expect(headerLine).toContain('Status')
		expect(headerLine).toContain('Cost')
		expect(headerLine).toContain('Elapsed')
	})

	it('shows running and completed agents', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('developer')
		expect(joined).toContain('reviewer')
		expect(joined).toContain('completed')
		expect(joined).toContain('running')
	})

	it('shows queued agents that have not started', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		// architect is in members but not started
		expect(joined).toContain('architect')
		expect(joined).toContain('queued')
	})

	it('shows cost per agent', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('$1.50')
		expect(joined).toContain('$0.64')
	})

	it('shows totals row', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('Total')
		expect(joined).toContain('$2.14')
	})

	it('shows budget remaining when constraints exist', () => {
		const lines = formatStatusTable(populatedState())
		const joined = lines.join('\n')

		expect(joined).toContain('Remaining')
		expect(joined).toContain('$7.86')
	})

	it('handles empty state gracefully', () => {
		const lines = formatStatusTable(emptyFleetState())
		expect(lines.length).toBeGreaterThan(0)
		const joined = lines.join('\n')
		expect(joined).toContain('Total (0/0)')
	})
})

describe('formatStatusLine', () => {
	it('returns a single-line summary', () => {
		const line = formatStatusLine(populatedState())

		expect(line).toContain('Fleet:')
		expect(line).toContain('agents complete')
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
