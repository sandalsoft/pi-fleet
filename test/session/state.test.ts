import { describe, it, expect } from 'vitest'
import {
	emptyFleetState,
	reconstructState,
	reduceEvent,
	resetAgentCost,
	type FleetState,
} from '../../src/session/state.js'
import {
	parseFleetEvent,
	type FleetEvent,
	type UnknownFleetEvent,
} from '../../src/session/events.js'

const ts = '2026-03-23T12:00:00.000Z'

function ev(raw: Record<string, unknown>): FleetEvent {
	return parseFleetEvent({ schemaVersion: 1, timestamp: ts, ...raw })!
}

describe('emptyFleetState', () => {
	it('returns a blank state with interview phase', () => {
		const state = emptyFleetState()
		expect(state.phase).toBe('interview')
		expect(state.startedAt).toBeNull()
		expect(state.specialists.size).toBe(0)
		expect(state.costs.size).toBe(0)
		expect(state.sessionComplete).toBe(false)
	})
})

describe('reconstructState from event sequences', () => {
	const sessionStart = ev({
		type: 'session_start',
		startedAt: ts,
		repoRoot: '/repo',
		baseSha: 'abc123',
		constraints: { maxUsd: 5, maxMinutes: 30, taskTimeoutMs: 120000, maxConcurrency: 3 },
	})

	const interviewComplete = ev({
		type: 'interview_complete',
		answers: { q1: 'build an API' },
	})

	const teamSelected = ev({
		type: 'team_selected',
		teamId: 'dev-squad',
		members: ['architect', 'developer', 'reviewer'],
	})

	const taskGraphCreated = ev({
		type: 'task_graph_created',
		taskCount: 4,
		waveCount: 2,
	})

	const specialistStarted = ev({
		type: 'specialist_started',
		agentName: 'developer',
		runId: 'run-001',
		pid: 12345,
		worktreePath: '/worktrees/developer',
		model: 'claude-sonnet-4-20250514',
	})

	const specialistCompleted = ev({
		type: 'specialist_completed',
		agentName: 'developer',
		runId: 'run-001',
	})

	it('session_start sets repoRoot, baseSha, constraints', () => {
		const state = reconstructState([sessionStart])
		expect(state.phase).toBe('interview')
		expect(state.repoRoot).toBe('/repo')
		expect(state.baseSha).toBe('abc123')
		expect(state.constraints).toEqual({
			maxUsd: 5,
			maxMinutes: 30,
			taskTimeoutMs: 120000,
			maxConcurrency: 3,
		})
		expect(state.startedAt).toBe(ts)
	})

	it('interview_complete transitions phase to dispatching', () => {
		const state = reconstructState([sessionStart, interviewComplete])
		expect(state.phase).toBe('dispatching')
	})

	it('team_selected records teamId and members', () => {
		const state = reconstructState([sessionStart, interviewComplete, teamSelected])
		expect(state.teamId).toBe('dev-squad')
		expect(state.members).toEqual(['architect', 'developer', 'reviewer'])
	})

	it('task_graph_created transitions to executing with task counts', () => {
		const state = reconstructState([
			sessionStart, interviewComplete, teamSelected, taskGraphCreated,
		])
		expect(state.phase).toBe('executing')
		expect(state.tasks).toEqual({
			taskCount: 4,
			waveCount: 2,
			completedAgents: [],
			failedAgents: [],
		})
	})

	it('specialist_started populates specialist runtime info', () => {
		const state = reconstructState([
			sessionStart, interviewComplete, teamSelected, taskGraphCreated, specialistStarted,
		])
		expect(state.specialists.size).toBe(1)
		const dev = state.specialists.get('developer')!
		expect(dev.agentName).toBe('developer')
		expect(dev.runId).toBe('run-001')
		expect(dev.pid).toBe(12345)
		expect(dev.worktreePath).toBe('/worktrees/developer')
		expect(dev.model).toBe('claude-sonnet-4-20250514')
		expect(dev.status).toBe('running')
		expect(dev.startedAt).toBe(ts)
		expect(dev.completedAt).toBeNull()
	})

	it('specialist_completed updates status and tracks completion', () => {
		const state = reconstructState([
			sessionStart, interviewComplete, teamSelected, taskGraphCreated,
			specialistStarted, specialistCompleted,
		])
		const dev = state.specialists.get('developer')!
		expect(dev.status).toBe('completed')
		expect(dev.completedAt).toBe(ts)
		expect(dev.startedAt).toBe(ts)
		expect(state.tasks!.completedAgents).toContain('developer')
	})

	it('specialist_failed updates status and tracks failure', () => {
		const events = [
			sessionStart, interviewComplete, teamSelected, taskGraphCreated,
			specialistStarted,
			ev({
				type: 'specialist_failed',
				agentName: 'developer',
				runId: 'run-001',
				error: 'timeout',
			}),
		]
		const state = reconstructState(events)
		const dev = state.specialists.get('developer')!
		expect(dev.status).toBe('failed')
		expect(dev.completedAt).toBe(ts)
		expect(state.tasks!.failedAgents).toContain('developer')
	})

	it('cost_update accumulates per-agent costs', () => {
		const events = [
			sessionStart,
			ev({ type: 'cost_update', agentName: 'developer', inputTokens: 1000, outputTokens: 500, costUsd: 0.05 }),
			ev({ type: 'cost_update', agentName: 'developer', inputTokens: 2000, outputTokens: 800, costUsd: 0.08 }),
			ev({ type: 'cost_update', agentName: 'reviewer', inputTokens: 500, outputTokens: 200, costUsd: 0.02 }),
		]
		const state = reconstructState(events)
		const devCost = state.costs.get('developer')!
		expect(devCost.inputTokens).toBe(3000)
		expect(devCost.outputTokens).toBe(1300)
		expect(devCost.costUsd).toBeCloseTo(0.13)
		expect(state.costs.get('reviewer')!.costUsd).toBeCloseTo(0.02)
		expect(state.totalCostUsd).toBeCloseTo(0.15)
	})

	it('merge flow transitions phase correctly', () => {
		const events = [
			sessionStart,
			ev({ type: 'merge_started', integrationBranch: 'fleet/integration-123' }),
		]
		let state = reconstructState(events)
		expect(state.phase).toBe('merging')
		expect(state.mergeInProgress).toBe(true)
		expect(state.integrationBranch).toBe('fleet/integration-123')

		state = reconstructState([
			...events,
			ev({ type: 'merge_completed', integrationBranch: 'fleet/integration-123', mergedAgents: ['dev'] }),
		])
		expect(state.mergeInProgress).toBe(false)
	})

	it('session_complete marks session as complete with totals', () => {
		const events = [
			sessionStart,
			ev({ type: 'session_complete', totalCostUsd: 3.5, totalDurationMs: 180000 }),
		]
		const state = reconstructState(events)
		expect(state.phase).toBe('complete')
		expect(state.sessionComplete).toBe(true)
		expect(state.totalCostUsd).toBe(3.5)
		expect(state.totalDurationMs).toBe(180000)
	})

	it('session_aborted marks session with reason', () => {
		const events = [
			sessionStart,
			ev({ type: 'session_aborted', reason: 'budget exceeded' }),
		]
		const state = reconstructState(events)
		expect(state.phase).toBe('aborted')
		expect(state.sessionAborted).toBe(true)
		expect(state.abortReason).toBe('budget exceeded')
	})

	it('unknown events are silently skipped by reducer', () => {
		const unknown: UnknownFleetEvent = {
			schemaVersion: 2,
			type: 'future_event',
			timestamp: ts,
			_unknown: true,
		}
		const state = reduceEvent(emptyFleetState(), unknown)
		// State unchanged from empty
		expect(state.phase).toBe('interview')
	})

	it('SpecialistRuntime fields survive round-trip through persist/replay', () => {
		// Simulate: create event -> JSON.stringify (persist) -> JSON.parse (replay) -> parse -> reconstruct
		const rawStarted = {
			schemaVersion: 1,
			type: 'specialist_started',
			timestamp: ts,
			agentName: 'architect',
			runId: 'run-xyz',
			pid: 99999,
			worktreePath: '/tmp/worktrees/architect',
			model: 'claude-opus-4-20250514',
		}

		// Persist simulation
		const serialized = JSON.stringify(rawStarted)
		const deserialized = JSON.parse(serialized)
		const event = parseFleetEvent(deserialized)!

		const state = reconstructState([
			ev({ type: 'session_start', startedAt: ts, repoRoot: '/r', baseSha: 'a', constraints: { maxUsd: 1, maxMinutes: 1, taskTimeoutMs: 1000, maxConcurrency: 1 } }),
			event,
		])

		const spec = state.specialists.get('architect')!
		expect(spec.agentName).toBe('architect')
		expect(spec.runId).toBe('run-xyz')
		expect(spec.pid).toBe(99999)
		expect(spec.worktreePath).toBe('/tmp/worktrees/architect')
		expect(spec.model).toBe('claude-opus-4-20250514')
		expect(spec.status).toBe('running')
	})
})

describe('resetAgentCost', () => {
	it('zeros all cost fields for a single agent', () => {
		let state = emptyFleetState()
		state = reduceEvent(state, ev({
			type: 'cost_update', agentName: 'dev', inputTokens: 1000, outputTokens: 500, costUsd: 0.05,
		}))
		expect(state.costs.get('dev')!.inputTokens).toBe(1000)

		const reset = resetAgentCost(state, 'dev')
		const cost = reset.costs.get('dev')!
		expect(cost.inputTokens).toBe(0)
		expect(cost.outputTokens).toBe(0)
		expect(cost.costUsd).toBe(0)
	})

	it('recalculates totalCostUsd after reset', () => {
		let state = emptyFleetState()
		state = reduceEvent(state, ev({
			type: 'cost_update', agentName: 'dev', inputTokens: 1000, outputTokens: 500, costUsd: 0.05,
		}))
		state = reduceEvent(state, ev({
			type: 'cost_update', agentName: 'reviewer', inputTokens: 500, outputTokens: 200, costUsd: 0.02,
		}))
		expect(state.totalCostUsd).toBeCloseTo(0.07)

		const reset = resetAgentCost(state, 'dev')
		// Only reviewer's cost remains
		expect(reset.totalCostUsd).toBeCloseTo(0.02)
	})

	it('does not affect other agents', () => {
		let state = emptyFleetState()
		state = reduceEvent(state, ev({
			type: 'cost_update', agentName: 'dev', inputTokens: 1000, outputTokens: 500, costUsd: 0.05,
		}))
		state = reduceEvent(state, ev({
			type: 'cost_update', agentName: 'reviewer', inputTokens: 500, outputTokens: 200, costUsd: 0.02,
		}))

		const reset = resetAgentCost(state, 'dev')
		const reviewer = reset.costs.get('reviewer')!
		expect(reviewer.inputTokens).toBe(500)
		expect(reviewer.outputTokens).toBe(200)
		expect(reviewer.costUsd).toBeCloseTo(0.02)
	})

	it('handles resetting an agent with no prior cost', () => {
		const state = emptyFleetState()
		const reset = resetAgentCost(state, 'nonexistent')
		const cost = reset.costs.get('nonexistent')!
		expect(cost.inputTokens).toBe(0)
		expect(cost.outputTokens).toBe(0)
		expect(cost.costUsd).toBe(0)
		expect(reset.totalCostUsd).toBe(0)
	})
})

describe('state reconstruction performance', () => {
	it('handles 10,000 events efficiently', () => {
		const events: FleetEvent[] = [
			ev({
				type: 'session_start',
				startedAt: ts, repoRoot: '/r', baseSha: 'a',
				constraints: { maxUsd: 100, maxMinutes: 60, taskTimeoutMs: 120000, maxConcurrency: 5 },
			}),
		]

		// Generate 9,999 cost_update events
		for (let i = 0; i < 9999; i++) {
			events.push(
				ev({
					type: 'cost_update',
					agentName: `agent-${i % 5}`,
					inputTokens: 100,
					outputTokens: 50,
					costUsd: 0.001,
				})
			)
		}

		const start = performance.now()
		const state = reconstructState(events)
		const elapsed = performance.now() - start

		expect(elapsed).toBeLessThan(2000) // Must be < 2s per spec
		expect(state.totalCostUsd).toBeCloseTo(9.999, 1)
		expect(state.costs.size).toBe(5)
	})
})
