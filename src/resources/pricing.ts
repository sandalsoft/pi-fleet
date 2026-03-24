import type { Usage } from '../dispatch/types.js'

/**
 * Static pricing table for known Anthropic models.
 * Prices are in USD per token.
 *
 * These are hardcoded for v1 to avoid network dependencies.
 * When msg.usage.cost is present, it takes priority over this table.
 */
interface ModelPricing {
	inputPerToken: number
	outputPerToken: number
	cacheReadPerToken: number
	cacheWritePerToken: number
}

const PRICING_TABLE: Record<string, ModelPricing> = {
	opus: {
		inputPerToken: 15.0 / 1_000_000,
		outputPerToken: 75.0 / 1_000_000,
		cacheReadPerToken: 1.5 / 1_000_000,
		cacheWritePerToken: 18.75 / 1_000_000,
	},
	sonnet: {
		inputPerToken: 3.0 / 1_000_000,
		outputPerToken: 15.0 / 1_000_000,
		cacheReadPerToken: 0.3 / 1_000_000,
		cacheWritePerToken: 3.75 / 1_000_000,
	},
	haiku: {
		inputPerToken: 0.25 / 1_000_000,
		outputPerToken: 1.25 / 1_000_000,
		cacheReadPerToken: 0.03 / 1_000_000,
		cacheWritePerToken: 0.3 / 1_000_000,
	},
}

/**
 * Normalize a model ID to a pricing tier using contains-based matching.
 *
 * Model strings from pi may arrive in several formats:
 * - Provider-qualified: "anthropic:claude-sonnet-4-20250514"
 * - Full name: "claude-opus-4-20250514"
 * - Short alias: "opus", "sonnet"
 *
 * We check if the lowercased model ID contains "opus", "sonnet", or "haiku".
 * Returns null for unrecognized models.
 */
export function resolveModelTier(modelId: string): string | null {
	const lower = modelId.toLowerCase()

	if (lower.includes('opus')) return 'opus'
	if (lower.includes('sonnet')) return 'sonnet'
	if (lower.includes('haiku')) return 'haiku'

	return null
}

/**
 * Calculate cost in USD from token usage and model ID.
 *
 * Priority:
 * 1. If usage.cost is already set (non-zero), return it directly.
 * 2. Look up model in the static pricing table via contains-based matching.
 * 3. If model is unrecognized, return { costUsd: 0, unknown: true }.
 */
export function calculateCost(
	usage: Usage,
	modelId: string
): { costUsd: number; unknown: boolean } {
	// Prefer the cost field from the usage data when available
	if (usage.cost > 0) {
		return { costUsd: usage.cost, unknown: false }
	}

	const tier = resolveModelTier(modelId)
	if (!tier) {
		return { costUsd: 0, unknown: true }
	}

	const pricing = PRICING_TABLE[tier]
	const costUsd =
		usage.inputTokens * pricing.inputPerToken +
		usage.outputTokens * pricing.outputPerToken +
		usage.cacheReadTokens * pricing.cacheReadPerToken +
		usage.cacheWriteTokens * pricing.cacheWritePerToken

	return { costUsd, unknown: false }
}

/**
 * Get the pricing table entry for a model tier (for testing/inspection).
 */
export function getPricingForTier(tier: string): ModelPricing | undefined {
	return PRICING_TABLE[tier]
}
