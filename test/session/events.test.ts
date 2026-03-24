import { describe, it, expect } from 'vitest'
import {
	parseFleetEvent,
	createFleetEvent,
	isKnownEvent,
	isEventType,
	CURRENT_SCHEMA_VERSION,
	type SessionStartEvent,
	type SpecialistStartedEvent,
	type SpecialistCompletedEvent,
	type SpecialistFailedEvent,
	type CostUpdateEvent,
} from '../../src/session/events.js'

const ts = '2026-03-23T12:00:00.000Z'

describe('parseFleetEvent — two-layer parsing', () => {
	it('returns null for structurally invalid events (missing envelope fields)', () => {
		expect(parseFleetEvent({})).toBeNull()
		expect(parseFleetEvent({ type: 'session_start' })).toBeNull()
		expect(parseFleetEvent({ schemaVersion: 1 })).toBeNull()
		expect(parseFleetEvent('not an object')).toBeNull()
		expect(parseFleetEvent(null)).toBeNull()
		expect(parseFleetEvent(42)).toBeNull()
	})

	it('parses a valid session_start event', () => {
		const raw = {
			schemaVersion: 1,
			type: 'session_start',
			timestamp: ts,
			startedAt: ts,
			repoRoot: '/repo',
			baseSha: 'abc123',
			constraints: { maxUsd: 5, maxMinutes: 30, taskTimeoutMs: 120000, maxConcurrency: 3 },
		}
		const event = parseFleetEvent(raw)
		expect(event).not.toBeNull()
		expect(event!.type).toBe('session_start')
		expect(isKnownEvent(event!)).toBe(true)
		expect((event as SessionStartEvent).startedAt).toBe(ts)
		expect((event as SessionStartEvent).repoRoot).toBe('/repo')
		expect((event as SessionStartEvent).baseSha).toBe('abc123')
		expect((event as SessionStartEvent).constraints.maxUsd).toBe(5)
	})

	it('preserves unknown event types as UnknownFleetEvent', () => {
		const raw = {
			schemaVersion: 2,
			type: 'future_event_type',
			timestamp: ts,
			someData: 'hello',
		}
		const event = parseFleetEvent(raw)
		expect(event).not.toBeNull()
		expect(event!.type).toBe('future_event_type')
		expect(isKnownEvent(event!)).toBe(false)
		expect('_unknown' in event! && event!._unknown).toBe(true)
		// Passthrough preserves extra fields
		expect((event as Record<string, unknown>).someData).toBe('hello')
	})

	it('treats known type with invalid payload as unknown (not crash)', () => {
		const raw = {
			schemaVersion: 1,
			type: 'session_start',
			timestamp: ts,
			// Missing required fields: startedAt, repoRoot, baseSha, constraints
		}
		const event = parseFleetEvent(raw)
		expect(event).not.toBeNull()
		expect('_unknown' in event! && event!._unknown).toBe(true)
	})

	it('tolerates unknown fields on known events via passthrough envelope', () => {
		const raw = {
			schemaVersion: 1,
			type: 'session_complete',
			timestamp: ts,
			totalCostUsd: 2.5,
			totalDurationMs: 180000,
			futureField: 'should not break parsing',
		}
		const event = parseFleetEvent(raw)
		expect(event).not.toBeNull()
		expect(event!.type).toBe('session_complete')
		expect(isKnownEvent(event!)).toBe(true)
	})
})

describe('specialist events carry required fields', () => {
	it('specialist_started includes agentName, runId, pid, worktreePath, model', () => {
		const raw = {
			schemaVersion: 1,
			type: 'specialist_started',
			timestamp: ts,
			agentName: 'developer',
			runId: 'run-001',
			pid: 12345,
			worktreePath: '/worktrees/developer',
			model: 'claude-sonnet-4-20250514',
		}
		const event = parseFleetEvent(raw)
		expect(event).not.toBeNull()
		expect(isKnownEvent(event!)).toBe(true)
		const started = event as SpecialistStartedEvent
		expect(started.agentName).toBe('developer')
		expect(started.runId).toBe('run-001')
		expect(started.pid).toBe(12345)
		expect(started.worktreePath).toBe('/worktrees/developer')
		expect(started.model).toBe('claude-sonnet-4-20250514')
	})

	it('specialist_completed includes agentName, runId', () => {
		const raw = {
			schemaVersion: 1,
			type: 'specialist_completed',
			timestamp: ts,
			agentName: 'developer',
			runId: 'run-001',
		}
		const event = parseFleetEvent(raw)
		expect(event).not.toBeNull()
		const completed = event as SpecialistCompletedEvent
		expect(completed.agentName).toBe('developer')
		expect(completed.runId).toBe('run-001')
	})

	it('specialist_failed includes agentName, runId', () => {
		const raw = {
			schemaVersion: 1,
			type: 'specialist_failed',
			timestamp: ts,
			agentName: 'reviewer',
			runId: 'run-002',
			error: 'timeout',
		}
		const event = parseFleetEvent(raw)
		expect(event).not.toBeNull()
		const failed = event as SpecialistFailedEvent
		expect(failed.agentName).toBe('reviewer')
		expect(failed.runId).toBe('run-002')
		expect(failed.error).toBe('timeout')
	})

	it('cost_update includes agentName', () => {
		const raw = {
			schemaVersion: 1,
			type: 'cost_update',
			timestamp: ts,
			agentName: 'developer',
			inputTokens: 1000,
			outputTokens: 500,
			costUsd: 0.05,
		}
		const event = parseFleetEvent(raw)
		expect(event).not.toBeNull()
		const cost = event as CostUpdateEvent
		expect(cost.agentName).toBe('developer')
		expect(cost.inputTokens).toBe(1000)
		expect(cost.costUsd).toBe(0.05)
	})
})

describe('createFleetEvent', () => {
	it('sets schemaVersion and timestamp automatically', () => {
		const event = createFleetEvent<SessionStartEvent>({
			type: 'session_start',
			startedAt: ts,
			repoRoot: '/repo',
			baseSha: 'abc',
			constraints: { maxUsd: 5, maxMinutes: 30, taskTimeoutMs: 120000, maxConcurrency: 2 },
		})
		expect(event.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
		expect(event.timestamp).toBeDefined()
		expect(event.type).toBe('session_start')
	})

	it('allows overriding schemaVersion and timestamp', () => {
		const event = createFleetEvent<SessionStartEvent>({
			type: 'session_start',
			schemaVersion: 99,
			timestamp: '2099-01-01T00:00:00Z',
			startedAt: ts,
			repoRoot: '/repo',
			baseSha: 'abc',
			constraints: { maxUsd: 5, maxMinutes: 30, taskTimeoutMs: 120000, maxConcurrency: 2 },
		})
		expect(event.schemaVersion).toBe(99)
		expect(event.timestamp).toBe('2099-01-01T00:00:00Z')
	})
})

describe('isEventType', () => {
	it('correctly narrows to a specific known type', () => {
		const raw = {
			schemaVersion: 1,
			type: 'session_complete',
			timestamp: ts,
			totalCostUsd: 1.5,
			totalDurationMs: 60000,
		}
		const event = parseFleetEvent(raw)!
		expect(isEventType(event, 'session_complete')).toBe(true)
		expect(isEventType(event, 'session_start')).toBe(false)
	})

	it('returns false for unknown events', () => {
		const raw = {
			schemaVersion: 1,
			type: 'future_event',
			timestamp: ts,
		}
		const event = parseFleetEvent(raw)!
		expect(isEventType(event, 'future_event' as never)).toBe(false)
	})
})

describe('JSON serialization', () => {
	it('all known event types produce valid JSON (no circular refs, no undefined)', () => {
		const events = [
			{
				schemaVersion: 1, type: 'session_start', timestamp: ts,
				startedAt: ts, repoRoot: '/r', baseSha: 'a',
				constraints: { maxUsd: 1, maxMinutes: 1, taskTimeoutMs: 1000, maxConcurrency: 1 },
			},
			{ schemaVersion: 1, type: 'interview_complete', timestamp: ts, answers: { q: 'a' } },
			{ schemaVersion: 1, type: 'team_selected', timestamp: ts, teamId: 't', members: ['a'] },
			{ schemaVersion: 1, type: 'task_graph_created', timestamp: ts, taskCount: 2, waveCount: 1 },
			{ schemaVersion: 1, type: 'worktree_created', timestamp: ts, agentName: 'a', worktreePath: '/w' },
			{
				schemaVersion: 1, type: 'specialist_started', timestamp: ts,
				agentName: 'a', runId: 'r', pid: 1, worktreePath: '/w', model: 'm',
			},
			{ schemaVersion: 1, type: 'specialist_completed', timestamp: ts, agentName: 'a', runId: 'r' },
			{ schemaVersion: 1, type: 'specialist_failed', timestamp: ts, agentName: 'a', runId: 'r' },
			{
				schemaVersion: 1, type: 'cost_update', timestamp: ts,
				agentName: 'a', inputTokens: 1, outputTokens: 1, costUsd: 0.01,
			},
			{ schemaVersion: 1, type: 'merge_started', timestamp: ts, integrationBranch: 'ib' },
			{ schemaVersion: 1, type: 'merge_completed', timestamp: ts, integrationBranch: 'ib', mergedAgents: ['a'] },
			{ schemaVersion: 1, type: 'merge_conflict', timestamp: ts, agentName: 'a', filePath: '/f' },
			{ schemaVersion: 1, type: 'consolidation_complete', timestamp: ts, finalSha: 'sha' },
			{ schemaVersion: 1, type: 'budget_warning', timestamp: ts, currentUsd: 4, limitUsd: 5 },
			{ schemaVersion: 1, type: 'time_warning', timestamp: ts, elapsedMinutes: 25, limitMinutes: 30 },
			{ schemaVersion: 1, type: 'session_complete', timestamp: ts, totalCostUsd: 3, totalDurationMs: 90000 },
			{ schemaVersion: 1, type: 'session_aborted', timestamp: ts, reason: 'budget exceeded' },
		]

		for (const raw of events) {
			const event = parseFleetEvent(raw)
			expect(event).not.toBeNull()
			// JSON.stringify must not throw, and required fields must survive round-trip
			const json = JSON.stringify(event)
			expect(json).toBeDefined()
			const roundTrip = JSON.parse(json)
			expect(roundTrip.type).toBe(raw.type)
			expect(roundTrip.schemaVersion).toBe(1)
			expect(roundTrip.timestamp).toBe(ts)
		}
	})
})
