import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
	resolveFleetState,
	handleStatus,
	updateStatusLine,
	type StatusContext,
} from '../../src/status/display.js'
import {
	emptyFleetState,
	reconstructState,
	type FleetState,
} from '../../src/session/state.js'
import { setFleetState, clearFleetState } from '../../src/session/runtime-store.js'
import { parseFleetEvent, type FleetEvent } from '../../src/session/events.js'
import type { EventLogReader } from '../../src/session/event-log.js'

const ts = '2026-03-23T12:00:00.000Z'

function ev(raw: Record<string, unknown>): FleetEvent {
	return parseFleetEvent({ schemaVersion: 1, timestamp: ts, ...raw })!
}

function mockReader(events: FleetEvent[]): EventLogReader {
	return {
		async replay() {
			return events
		},
	}
}

function mockCtx(): StatusContext {
	return {
		ui: {
			notify: vi.fn(),
			setWidget: vi.fn(),
			setStatus: vi.fn(),
		},
	}
}

describe('resolveFleetState', () => {
	afterEach(() => {
		clearFleetState()
	})

	it('returns in-memory state when available', async () => {
		const memState = emptyFleetState()
		memState.phase = 'executing'
		setFleetState(memState)

		const result = await resolveFleetState(mockReader([]))
		expect(result).toBe(memState)
		expect(result!.phase).toBe('executing')
	})

	it('falls back to event replay when no in-memory state', async () => {
		const events = [
			ev({
				type: 'session_start',
				startedAt: ts,
				repoRoot: '/repo',
				baseSha: 'abc',
				constraints: { maxUsd: 5, maxMinutes: 30, taskTimeoutMs: 120000, maxConcurrency: 3 },
			}),
			ev({
				type: 'specialist_started',
				agentName: 'developer',
				runId: 'run-001',
				pid: 1234,
				worktreePath: '/wt/dev',
				model: 'claude-sonnet-4-20250514',
			}),
		]

		const result = await resolveFleetState(mockReader(events))
		expect(result).not.toBeNull()
		expect(result!.specialists.size).toBe(1)
		expect(result!.specialists.get('developer')!.status).toBe('running')
	})

	it('returns null when no state and no events', async () => {
		const result = await resolveFleetState(mockReader([]))
		expect(result).toBeNull()
	})

	it('prefers in-memory state over event replay', async () => {
		const memState = emptyFleetState()
		memState.phase = 'merging'
		setFleetState(memState)

		const events = [
			ev({
				type: 'session_start',
				startedAt: ts,
				repoRoot: '/repo',
				baseSha: 'abc',
				constraints: { maxUsd: 5, maxMinutes: 30, taskTimeoutMs: 120000, maxConcurrency: 3 },
			}),
		]

		const result = await resolveFleetState(mockReader(events))
		// Should get the in-memory state, not the replayed one
		expect(result!.phase).toBe('merging')
	})
})

describe('handleStatus', () => {
	afterEach(() => {
		clearFleetState()
	})

	it('renders status table via setWidget when state exists', async () => {
		const state = emptyFleetState()
		state.phase = 'executing'
		state.members = ['developer']
		state.specialists.set('developer', {
			agentName: 'developer',
			runId: 'run-001',
			pid: 1234,
			worktreePath: '/wt/dev',
			model: 'claude-sonnet-4-20250514',
			status: 'running',
		})
		setFleetState(state)

		const ctx = mockCtx()
		await handleStatus({ ctx, reader: mockReader([]) })

		expect(ctx.ui.setWidget).toHaveBeenCalledWith('fleet-status', expect.any(Array))
		const lines = (ctx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[]
		expect(lines.join('\n')).toContain('developer')
	})

	it('notifies when no session found', async () => {
		const ctx = mockCtx()
		await handleStatus({ ctx, reader: mockReader([]) })

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('No active or previous fleet session'),
			'info'
		)
		expect(ctx.ui.setWidget).not.toHaveBeenCalled()
	})

	it('works from event replay when no in-memory state', async () => {
		const events = [
			ev({
				type: 'session_start',
				startedAt: ts,
				repoRoot: '/repo',
				baseSha: 'abc',
				constraints: { maxUsd: 10, maxMinutes: 30, taskTimeoutMs: 120000, maxConcurrency: 3 },
			}),
			ev({
				type: 'specialist_started',
				agentName: 'architect',
				runId: 'run-001',
				pid: 5555,
				worktreePath: '/wt/arch',
				model: 'claude-opus-4-20250514',
			}),
			ev({
				type: 'cost_update',
				agentName: 'architect',
				inputTokens: 1000,
				outputTokens: 500,
				costUsd: 0.42,
			}),
		]

		const ctx = mockCtx()
		await handleStatus({ ctx, reader: mockReader(events) })

		expect(ctx.ui.setWidget).toHaveBeenCalledWith('fleet-status', expect.any(Array))
		const lines = (ctx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[]
		const joined = lines.join('\n')
		expect(joined).toContain('architect')
		expect(joined).toContain('$0.42')
	})
})

describe('updateStatusLine', () => {
	it('calls setStatus with a formatted status line', () => {
		const state = emptyFleetState()
		state.phase = 'executing'
		state.startedAt = new Date(Date.now() - 60_000).toISOString()
		state.members = ['developer', 'reviewer']
		state.specialists.set('developer', {
			agentName: 'developer',
			runId: 'run-001',
			pid: 1234,
			worktreePath: '/wt/dev',
			model: 'claude-sonnet-4-20250514',
			status: 'completed',
		})
		state.totalCostUsd = 1.23
		state.constraints = {
			maxUsd: 10,
			maxMinutes: 30,
			taskTimeoutMs: 120000,
			maxConcurrency: 3,
		}

		const ctx = mockCtx()
		updateStatusLine(ctx, state)

		expect(ctx.ui.setStatus).toHaveBeenCalledWith('fleet', expect.stringContaining('Fleet:'))
		const statusText = (ctx.ui.setStatus as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
		expect(statusText).toContain('1/2')
		expect(statusText).toContain('$1.23')
		expect(statusText).toContain('$10.00')
	})
})
