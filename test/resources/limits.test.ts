import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createLimitsMonitor, type LimitCheckResult } from '../../src/resources/limits.js'
import type { EventLogWriter } from '../../src/session/event-log.js'
import type { SessionTimer } from '../../src/resources/timer.js'
import type { ResourceTracker } from '../../src/resources/tracker.js'

function mockEventLog(): EventLogWriter & { events: unknown[] } {
	const events: unknown[] = []
	return {
		events,
		async append(event: unknown) {
			events.push(event)
		},
	}
}

function mockTimer(elapsedMin: number): SessionTimer {
	return {
		startedAt: Date.now() - elapsedMin * 60_000,
		elapsedMs: () => elapsedMin * 60_000,
		elapsedMinutes: () => elapsedMin,
		minutesRemaining: (limit: number) => Math.max(0, limit - elapsedMin),
		elapsedRatio: (limit: number) => (limit > 0 ? elapsedMin / limit : 0),
	}
}

function mockTracker(totalUsd: number): ResourceTracker {
	return {
		async recordUsage() {},
		getAgentCost: () => undefined,
		getAllAgentCosts: () => [],
		totalCostUsd: () => totalUsd,
	}
}

describe('LimitsMonitor', () => {
	const scratchpadDir = '/tmp/test-scratchpads'

	it('does not fire warnings below 80% threshold', async () => {
		const eventLog = mockEventLog()
		const onSoftWarning = vi.fn()
		const onHardLimit = vi.fn()

		const monitor = createLimitsMonitor({
			maxUsd: 10,
			maxMinutes: 30,
			timer: mockTimer(10), // 33% of 30min
			tracker: mockTracker(5), // 50% of $10
			eventLog,
			scratchpadDir,
			onSoftWarning,
			onHardLimit,
		})

		const results = await monitor.check()
		expect(results).toHaveLength(0)
		expect(onSoftWarning).not.toHaveBeenCalled()
		expect(onHardLimit).not.toHaveBeenCalled()
	})

	it('fires soft budget warning at 80%', async () => {
		const eventLog = mockEventLog()
		const onSoftWarning = vi.fn()

		const monitor = createLimitsMonitor({
			maxUsd: 10,
			maxMinutes: 60,
			timer: mockTimer(5), // well below time limit
			tracker: mockTracker(8.5), // 85% of $10
			eventLog,
			scratchpadDir,
			onSoftWarning,
		})

		const results = await monitor.check()
		expect(results).toHaveLength(1)
		expect(results[0].kind).toBe('budget')
		expect(results[0].level).toBe('soft')
		expect(onSoftWarning).toHaveBeenCalledOnce()

		// Verify event was emitted
		const budgetEvents = eventLog.events.filter(
			(e: any) => e.type === 'budget_warning'
		)
		expect(budgetEvents).toHaveLength(1)
	})

	it('fires soft time warning at 80%', async () => {
		const eventLog = mockEventLog()
		const onSoftWarning = vi.fn()

		const monitor = createLimitsMonitor({
			maxUsd: 100,
			maxMinutes: 30,
			timer: mockTimer(25), // 83% of 30min
			tracker: mockTracker(1), // well below budget
			eventLog,
			scratchpadDir,
			onSoftWarning,
		})

		const results = await monitor.check()
		expect(results).toHaveLength(1)
		expect(results[0].kind).toBe('time')
		expect(results[0].level).toBe('soft')
	})

	it('fires hard budget limit at 100%', async () => {
		const eventLog = mockEventLog()
		const onHardLimit = vi.fn()

		const monitor = createLimitsMonitor({
			maxUsd: 5,
			maxMinutes: 60,
			timer: mockTimer(5),
			tracker: mockTracker(5.5), // 110% of $5
			eventLog,
			scratchpadDir,
			onHardLimit,
		})

		const results = await monitor.check()
		expect(results).toHaveLength(1)
		expect(results[0].kind).toBe('budget')
		expect(results[0].level).toBe('hard')
		expect(onHardLimit).toHaveBeenCalledOnce()
		expect(monitor.isHardLimitReached()).toBe(true)
	})

	it('fires hard time limit at 100%', async () => {
		const eventLog = mockEventLog()
		const onHardLimit = vi.fn()

		const monitor = createLimitsMonitor({
			maxUsd: 100,
			maxMinutes: 10,
			timer: mockTimer(11), // 110% of 10min
			tracker: mockTracker(0),
			eventLog,
			scratchpadDir,
			onHardLimit,
		})

		const results = await monitor.check()
		expect(results).toHaveLength(1)
		expect(results[0].kind).toBe('time')
		expect(results[0].level).toBe('hard')
		expect(monitor.isHardLimitReached()).toBe(true)
	})

	it('does not fire the same warning twice', async () => {
		const eventLog = mockEventLog()
		const onSoftWarning = vi.fn()

		const monitor = createLimitsMonitor({
			maxUsd: 10,
			maxMinutes: 60,
			timer: mockTimer(5),
			tracker: mockTracker(9), // 90%
			eventLog,
			scratchpadDir,
			onSoftWarning,
		})

		await monitor.check()
		await monitor.check()
		await monitor.check()

		expect(onSoftWarning).toHaveBeenCalledOnce()
	})

	it('can fire both budget and time warnings simultaneously', async () => {
		const eventLog = mockEventLog()
		const onSoftWarning = vi.fn()

		const monitor = createLimitsMonitor({
			maxUsd: 10,
			maxMinutes: 30,
			timer: mockTimer(26), // 87%
			tracker: mockTracker(9), // 90%
			eventLog,
			scratchpadDir,
			onSoftWarning,
		})

		const results = await monitor.check()
		expect(results).toHaveLength(2)
		expect(results.map((r) => r.kind).sort()).toEqual(['budget', 'time'])
		expect(onSoftWarning).toHaveBeenCalledTimes(2)
	})

	it('skips soft warning when jumping straight to hard', async () => {
		const eventLog = mockEventLog()
		const onSoftWarning = vi.fn()
		const onHardLimit = vi.fn()

		const monitor = createLimitsMonitor({
			maxUsd: 5,
			maxMinutes: 60,
			timer: mockTimer(5),
			tracker: mockTracker(6), // 120% — straight past soft
			eventLog,
			scratchpadDir,
			onSoftWarning,
			onHardLimit,
		})

		const results = await monitor.check()
		expect(results).toHaveLength(1)
		expect(results[0].level).toBe('hard')
		expect(onSoftWarning).not.toHaveBeenCalled()
		expect(onHardLimit).toHaveBeenCalledOnce()

		// Second check should not re-fire
		const results2 = await monitor.check()
		expect(results2).toHaveLength(0)
	})

	it('resetWarnings allows warnings to fire again', async () => {
		const eventLog = mockEventLog()
		const onSoftWarning = vi.fn()

		const monitor = createLimitsMonitor({
			maxUsd: 10,
			maxMinutes: 60,
			timer: mockTimer(5),
			tracker: mockTracker(9),
			eventLog,
			scratchpadDir,
			onSoftWarning,
		})

		await monitor.check()
		expect(onSoftWarning).toHaveBeenCalledOnce()

		monitor.resetWarnings()
		await monitor.check()
		expect(onSoftWarning).toHaveBeenCalledTimes(2)
	})

	it('handles zero limits without division by zero', async () => {
		const eventLog = mockEventLog()

		const monitor = createLimitsMonitor({
			maxUsd: 0,
			maxMinutes: 0,
			timer: mockTimer(5),
			tracker: mockTracker(1),
			eventLog,
			scratchpadDir,
		})

		const results = await monitor.check()
		// With zero limits, ratios compute to 0 — no warnings fire
		expect(results).toHaveLength(0)
		expect(monitor.isHardLimitReached()).toBe(false)
	})
})
