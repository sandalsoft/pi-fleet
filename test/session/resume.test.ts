import { describe, it, expect, vi } from 'vitest'
import { resume, type ResumeContext } from '../../src/session/resume.js'
import type { EventLogReader } from '../../src/session/event-log.js'
import { parseFleetEvent, type FleetEvent } from '../../src/session/events.js'

const ts = '2026-03-23T12:00:00.000Z'

function ev(raw: Record<string, unknown>): FleetEvent {
	return parseFleetEvent({ schemaVersion: 1, timestamp: ts, ...raw })!
}

function mockReader(events: FleetEvent[]): EventLogReader {
	return { replay: async () => events }
}

function mockCtx(confirmResult = true): ResumeContext {
	return {
		ui: {
			confirm: vi.fn().mockResolvedValue(confirmResult),
			notify: vi.fn(),
		},
	}
}

const sessionStart = ev({
	type: 'session_start',
	startedAt: ts,
	repoRoot: '/repo',
	baseSha: 'abc',
	constraints: { maxUsd: 5, maxMinutes: 30, taskTimeoutMs: 120000, maxConcurrency: 3 },
})

describe('resume', () => {
	it('returns not-resumed when event log is empty', async () => {
		const result = await resume(mockReader([]), mockCtx())
		expect(result.resumed).toBe(false)
		expect(result.state).toBeNull()
	})

	it('returns not-resumed when session is already complete', async () => {
		const events = [
			sessionStart,
			ev({ type: 'session_complete', totalCostUsd: 1, totalDurationMs: 60000 }),
		]
		const result = await resume(mockReader(events), mockCtx())
		expect(result.resumed).toBe(false)
	})

	it('returns not-resumed when session was aborted', async () => {
		const events = [
			sessionStart,
			ev({ type: 'session_aborted', reason: 'user abort' }),
		]
		const result = await resume(mockReader(events), mockCtx())
		expect(result.resumed).toBe(false)
	})

	it('detects incomplete session and offers resume', async () => {
		const ctx = mockCtx(true)
		const result = await resume(mockReader([sessionStart]), ctx)
		expect(result.resumed).toBe(true)
		expect(result.state).not.toBeNull()
		expect(result.state!.repoRoot).toBe('/repo')
		expect(ctx.ui.confirm).toHaveBeenCalledOnce()
	})

	it('respects user declining resume', async () => {
		const ctx = mockCtx(false)
		const result = await resume(mockReader([sessionStart]), ctx)
		expect(result.resumed).toBe(false)
		expect(result.state).toBeNull()
		expect(ctx.ui.confirm).toHaveBeenCalledOnce()
	})

	it('detects interrupted specialists (started but not completed/failed)', async () => {
		const events = [
			sessionStart,
			ev({ type: 'interview_complete', answers: {} }),
			ev({ type: 'team_selected', teamId: 't', members: ['dev', 'reviewer'] }),
			ev({ type: 'task_graph_created', taskCount: 2, waveCount: 1 }),
			ev({
				type: 'specialist_started',
				agentName: 'dev', runId: 'r1', pid: 100, worktreePath: '/w/dev', model: 'sonnet',
			}),
			ev({
				type: 'specialist_started',
				agentName: 'reviewer', runId: 'r2', pid: 101, worktreePath: '/w/reviewer', model: 'sonnet',
			}),
			ev({ type: 'specialist_completed', agentName: 'dev', runId: 'r1' }),
			// reviewer never completed
		]
		const ctx = mockCtx(true)
		const result = await resume(mockReader(events), ctx)
		expect(result.resumed).toBe(true)
		expect(result.interruptedAgents).toEqual(['reviewer'])
	})

	it('reports no interrupted agents when all finished', async () => {
		const events = [
			sessionStart,
			ev({
				type: 'specialist_started',
				agentName: 'dev', runId: 'r1', pid: 100, worktreePath: '/w', model: 'm',
			}),
			ev({ type: 'specialist_completed', agentName: 'dev', runId: 'r1' }),
		]
		const ctx = mockCtx(true)
		const result = await resume(mockReader(events), ctx)
		expect(result.interruptedAgents).toEqual([])
	})

	it('includes interrupted agent names in confirm message', async () => {
		const events = [
			sessionStart,
			ev({
				type: 'specialist_started',
				agentName: 'architect', runId: 'r1', pid: 100, worktreePath: '/w', model: 'm',
			}),
		]
		const ctx = mockCtx(false)
		await resume(mockReader(events), ctx)
		const confirmCall = (ctx.ui.confirm as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(confirmCall[1]).toContain('architect')
	})
})
