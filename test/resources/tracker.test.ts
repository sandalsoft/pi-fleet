import { describe, it, expect, vi } from 'vitest'
import { createResourceTracker } from '../../src/resources/tracker.js'
import type { EventLogWriter } from '../../src/session/event-log.js'
import type { Usage } from '../../src/dispatch/types.js'

function mockEventLog(): EventLogWriter & { events: unknown[] } {
	const events: unknown[] = []
	return {
		events,
		async append(event: unknown) {
			events.push(event)
		},
	}
}

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		...overrides,
	}
}

describe('ResourceTracker', () => {
	it('accumulates per-agent costs across multiple messages', async () => {
		const eventLog = mockEventLog()
		const tracker = createResourceTracker({ eventLog })

		await tracker.recordUsage('developer', 'claude-sonnet-4-20250514', usage({ cost: 0.01 }))
		await tracker.recordUsage('developer', 'claude-sonnet-4-20250514', usage({ cost: 0.02 }))

		const agentCost = tracker.getAgentCost('developer')
		expect(agentCost).toBeDefined()
		expect(agentCost!.costUsd).toBeCloseTo(0.03, 10)
		expect(agentCost!.messageCount).toBe(2)
	})

	it('tracks costs separately per agent', async () => {
		const eventLog = mockEventLog()
		const tracker = createResourceTracker({ eventLog })

		await tracker.recordUsage('developer', 'sonnet', usage({ cost: 0.01 }))
		await tracker.recordUsage('reviewer', 'opus', usage({ cost: 0.05 }))

		expect(tracker.getAgentCost('developer')!.costUsd).toBeCloseTo(0.01)
		expect(tracker.getAgentCost('reviewer')!.costUsd).toBeCloseTo(0.05)
	})

	it('computes correct total cost across agents', async () => {
		const eventLog = mockEventLog()
		const tracker = createResourceTracker({ eventLog })

		await tracker.recordUsage('agent-a', 'sonnet', usage({ cost: 0.10 }))
		await tracker.recordUsage('agent-b', 'opus', usage({ cost: 0.25 }))
		await tracker.recordUsage('agent-a', 'sonnet', usage({ cost: 0.05 }))

		expect(tracker.totalCostUsd()).toBeCloseTo(0.40)
	})

	it('emits cost_update events to the event log', async () => {
		const eventLog = mockEventLog()
		const tracker = createResourceTracker({ eventLog })

		await tracker.recordUsage('dev', 'sonnet', usage({ cost: 0.01 }))

		expect(eventLog.events).toHaveLength(1)
		const event = eventLog.events[0] as Record<string, unknown>
		expect(event.type).toBe('cost_update')
		expect(event.agentName).toBe('dev')
		expect(event.costUsd).toBe(0.01)
	})

	it('calls onCostUpdate callback with running total', async () => {
		const eventLog = mockEventLog()
		const onCostUpdate = vi.fn()
		const tracker = createResourceTracker({ eventLog, onCostUpdate })

		await tracker.recordUsage('dev', 'sonnet', usage({ cost: 0.01 }))
		await tracker.recordUsage('dev', 'sonnet', usage({ cost: 0.02 }))

		expect(onCostUpdate).toHaveBeenCalledTimes(2)
		expect(onCostUpdate).toHaveBeenLastCalledWith(expect.closeTo(0.03, 5), 'dev')
	})

	it('calls onUnknownModel when model is unrecognized and cost is zero', async () => {
		const eventLog = mockEventLog()
		const onUnknownModel = vi.fn()
		const tracker = createResourceTracker({ eventLog, onUnknownModel })

		await tracker.recordUsage('dev', 'gpt-4o', usage({ inputTokens: 100, outputTokens: 50 }))

		expect(onUnknownModel).toHaveBeenCalledWith('gpt-4o', 'dev')
	})

	it('does not call onUnknownModel when cost is present', async () => {
		const eventLog = mockEventLog()
		const onUnknownModel = vi.fn()
		const tracker = createResourceTracker({ eventLog, onUnknownModel })

		await tracker.recordUsage('dev', 'gpt-4o', usage({ cost: 0.05 }))

		expect(onUnknownModel).not.toHaveBeenCalled()
	})

	it('accumulates token counts alongside cost', async () => {
		const eventLog = mockEventLog()
		const tracker = createResourceTracker({ eventLog })

		await tracker.recordUsage('dev', 'sonnet', usage({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 200,
			cacheWriteTokens: 30,
			cost: 0.01,
		}))
		await tracker.recordUsage('dev', 'sonnet', usage({
			inputTokens: 200,
			outputTokens: 100,
			cost: 0.02,
		}))

		const record = tracker.getAgentCost('dev')!
		expect(record.inputTokens).toBe(300)
		expect(record.outputTokens).toBe(150)
		expect(record.cacheReadTokens).toBe(200)
		expect(record.cacheWriteTokens).toBe(30)
	})

	it('getAllAgentCosts returns all tracked agents', async () => {
		const eventLog = mockEventLog()
		const tracker = createResourceTracker({ eventLog })

		await tracker.recordUsage('a', 'sonnet', usage({ cost: 0.01 }))
		await tracker.recordUsage('b', 'opus', usage({ cost: 0.02 }))

		const all = tracker.getAllAgentCosts()
		expect(all).toHaveLength(2)
		expect(all.map((r) => r.agentName).sort()).toEqual(['a', 'b'])
	})

	it('returns undefined for unknown agent', () => {
		const eventLog = mockEventLog()
		const tracker = createResourceTracker({ eventLog })
		expect(tracker.getAgentCost('nonexistent')).toBeUndefined()
	})
})
