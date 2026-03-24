import type { Usage } from '../dispatch/types.js'
import type { EventLogWriter } from '../session/event-log.js'
import type { CostUpdateEvent } from '../session/events.js'
import { createFleetEvent } from '../session/events.js'
import { calculateCost } from './pricing.js'

/**
 * Per-agent accumulated cost record.
 */
export interface AgentCostRecord {
	agentName: string
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	costUsd: number
	messageCount: number
}

/**
 * Resource tracker for accumulating per-agent and total cost data.
 *
 * Receives usage data from the spawner (per-message), calculates cost
 * using the pricing module, and emits cost_update events to the session log.
 */
export interface ResourceTracker {
	/**
	 * Record usage from a single message for a given agent.
	 * Calculates cost, accumulates totals, and emits a cost_update event.
	 */
	recordUsage(agentName: string, modelId: string, usage: Usage): Promise<void>

	/** Get the cost record for a specific agent. */
	getAgentCost(agentName: string): AgentCostRecord | undefined

	/** Get all per-agent cost records. */
	getAllAgentCosts(): AgentCostRecord[]

	/** Get the total accumulated cost across all agents. */
	totalCostUsd(): number
}

export interface TrackerOpts {
	eventLog: EventLogWriter
	onCostUpdate?: (totalUsd: number, agentName: string) => void
	onUnknownModel?: (modelId: string, agentName: string) => void
}

/**
 * Create a resource tracker that persists cost events to the session log.
 */
export function createResourceTracker(opts: TrackerOpts): ResourceTracker {
	const { eventLog, onCostUpdate, onUnknownModel } = opts
	const agents = new Map<string, AgentCostRecord>()

	function getOrCreate(agentName: string): AgentCostRecord {
		let record = agents.get(agentName)
		if (!record) {
			record = {
				agentName,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
				messageCount: 0,
			}
			agents.set(agentName, record)
		}
		return record
	}

	return {
		async recordUsage(agentName: string, modelId: string, usage: Usage): Promise<void> {
			const record = getOrCreate(agentName)

			const { costUsd, unknown } = calculateCost(usage, modelId)

			if (unknown) {
				onUnknownModel?.(modelId, agentName)
			}

			record.inputTokens += usage.inputTokens
			record.outputTokens += usage.outputTokens
			record.cacheReadTokens += usage.cacheReadTokens
			record.cacheWriteTokens += usage.cacheWriteTokens
			record.costUsd += costUsd
			record.messageCount += 1

			// Emit cost_update event
			const event = createFleetEvent<CostUpdateEvent>({
				type: 'cost_update',
				agentName,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				costUsd,
			})
			await eventLog.append(event)

			onCostUpdate?.(totalCost(), agentName)
		},

		getAgentCost(agentName: string): AgentCostRecord | undefined {
			return agents.get(agentName)
		},

		getAllAgentCosts(): AgentCostRecord[] {
			return Array.from(agents.values())
		},

		totalCostUsd(): number {
			return totalCost()
		},
	}

	function totalCost(): number {
		let sum = 0
		for (const record of agents.values()) {
			sum += record.costUsd
		}
		return sum
	}
}
