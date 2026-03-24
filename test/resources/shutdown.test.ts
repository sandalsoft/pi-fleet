import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { gracefulShutdown, installSignalHandlers } from '../../src/resources/shutdown.js'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { EventLogWriter } from '../../src/session/event-log.js'

function mockEventLog(): EventLogWriter & { events: unknown[] } {
	const events: unknown[] = []
	return {
		events,
		async append(event: unknown) {
			events.push(event)
		},
	}
}

/**
 * Create a fake ChildProcess that tracks signal calls.
 */
function fakeProcess(opts: { exitCode?: number | null; killed?: boolean } = {}): ChildProcess & {
	signals: string[]
	simulateExit: (code?: number) => void
} {
	const emitter = new EventEmitter() as any
	emitter.exitCode = opts.exitCode ?? null
	emitter.killed = opts.killed ?? false
	emitter.pid = Math.floor(Math.random() * 100000)
	emitter.signals = [] as string[]

	emitter.kill = (signal: string) => {
		emitter.signals.push(signal)
		if (signal === 'SIGKILL') {
			emitter.killed = true
			emitter.exitCode = 137
			emitter.emit('exit', 137)
		}
	}

	emitter.simulateExit = (code = 0) => {
		emitter.exitCode = code
		emitter.emit('exit', code)
	}

	return emitter as any
}

describe('gracefulShutdown', () => {
	it('sends SIGTERM to all active processes', async () => {
		const proc1 = fakeProcess()
		const proc2 = fakeProcess()

		// Simulate processes exiting after SIGTERM
		setTimeout(() => proc1.simulateExit(0), 10)
		setTimeout(() => proc2.simulateExit(0), 10)

		const result = await gracefulShutdown({
			processes: [proc1, proc2],
			scratchpadDir: '/tmp/test-scratch',
			eventLog: mockEventLog(),
			reason: 'budget_exceeded',
			isMergeInProgress: () => false,
		})

		expect(result.terminated).toBe(2)
		expect(result.killed).toBe(0)
		expect(proc1.signals).toContain('SIGTERM')
		expect(proc2.signals).toContain('SIGTERM')
	})

	it('skips already-exited processes', async () => {
		const aliveProc = fakeProcess()
		const deadProc = fakeProcess({ exitCode: 0 })

		setTimeout(() => aliveProc.simulateExit(0), 10)

		const result = await gracefulShutdown({
			processes: [aliveProc, deadProc],
			scratchpadDir: '/tmp/test-scratch',
			eventLog: mockEventLog(),
			reason: 'time_exceeded',
			isMergeInProgress: () => false,
		})

		expect(result.terminated).toBe(1)
		expect(deadProc.signals).toHaveLength(0)
	})

	it('emits session_aborted event', async () => {
		const eventLog = mockEventLog()

		const result = await gracefulShutdown({
			processes: [],
			scratchpadDir: '/tmp/test-scratch',
			eventLog,
			reason: 'manual_stop',
			isMergeInProgress: () => false,
		})

		expect(eventLog.events).toHaveLength(1)
		const event = eventLog.events[0] as Record<string, unknown>
		expect(event.type).toBe('session_aborted')
		expect(event.reason).toBe('manual_stop')
	})

	it('waits for merge safe window when merge is in progress', async () => {
		let mergeInProgress = true
		const startTime = Date.now()

		// Merge "completes" after 100ms
		setTimeout(() => {
			mergeInProgress = false
		}, 100)

		const result = await gracefulShutdown({
			processes: [],
			scratchpadDir: '/tmp/test-scratch',
			eventLog: mockEventLog(),
			reason: 'budget_exceeded',
			isMergeInProgress: () => mergeInProgress,
		})

		expect(result.mergeWaited).toBe(true)
		const elapsed = Date.now() - startTime
		// Should have waited at least ~100ms for merge, but less than the 30s window
		expect(elapsed).toBeGreaterThanOrEqual(50)
		expect(elapsed).toBeLessThan(5000)
	})

	it('does not wait if no merge is in progress', async () => {
		const startTime = Date.now()

		const result = await gracefulShutdown({
			processes: [],
			scratchpadDir: '/tmp/test-scratch',
			eventLog: mockEventLog(),
			reason: 'time_exceeded',
			isMergeInProgress: () => false,
		})

		expect(result.mergeWaited).toBe(false)
		expect(Date.now() - startTime).toBeLessThan(1000)
	})

	it('result reports worktreesCleaned as false when no manager provided', async () => {
		const result = await gracefulShutdown({
			processes: [],
			scratchpadDir: '/tmp/test-scratch',
			eventLog: mockEventLog(),
			reason: 'test',
			isMergeInProgress: () => false,
		})

		expect(result.worktreesCleaned).toBe(false)
	})
})

describe('installSignalHandlers', () => {
	it('returns a cleanup function that removes handlers', () => {
		const triggerShutdown = vi.fn().mockResolvedValue(undefined)
		const cleanup = installSignalHandlers(triggerShutdown)

		// Should not throw
		expect(typeof cleanup).toBe('function')
		cleanup()
	})

	it('prevents double-fire on repeated signals', () => {
		const triggerShutdown = vi.fn().mockResolvedValue(undefined)
		const cleanup = installSignalHandlers(triggerShutdown)

		// Simulate SIGINT
		process.emit('SIGINT' as any)

		// The handler should have fired once
		expect(triggerShutdown).toHaveBeenCalledOnce()
		expect(triggerShutdown).toHaveBeenCalledWith('Received SIGINT')

		// Second signal should be ignored (shutdownTriggered flag)
		process.emit('SIGTERM' as any)
		expect(triggerShutdown).toHaveBeenCalledOnce()

		cleanup()
	})
})
