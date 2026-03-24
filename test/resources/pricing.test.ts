import { describe, it, expect } from 'vitest'
import { resolveModelTier, calculateCost, getPricingForTier } from '../../src/resources/pricing.js'
import type { Usage } from '../../src/dispatch/types.js'

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

describe('resolveModelTier', () => {
	it('resolves provider-qualified opus model', () => {
		expect(resolveModelTier('anthropic:claude-opus-4-20250514')).toBe('opus')
	})

	it('resolves full sonnet model name', () => {
		expect(resolveModelTier('claude-sonnet-4-20250514')).toBe('sonnet')
	})

	it('resolves short alias', () => {
		expect(resolveModelTier('opus')).toBe('opus')
		expect(resolveModelTier('sonnet')).toBe('sonnet')
		expect(resolveModelTier('haiku')).toBe('haiku')
	})

	it('is case-insensitive', () => {
		expect(resolveModelTier('Claude-OPUS-4')).toBe('opus')
		expect(resolveModelTier('HAIKU')).toBe('haiku')
	})

	it('returns null for unrecognized models', () => {
		expect(resolveModelTier('gpt-4o')).toBeNull()
		expect(resolveModelTier('gemini-pro')).toBeNull()
		expect(resolveModelTier('llama-3')).toBeNull()
	})
})

describe('calculateCost', () => {
	it('uses usage.cost when present (non-zero)', () => {
		const result = calculateCost(usage({ cost: 0.042 }), 'claude-sonnet-4-20250514')
		expect(result.costUsd).toBe(0.042)
		expect(result.unknown).toBe(false)
	})

	it('calculates from token counts when cost is zero', () => {
		const u = usage({ inputTokens: 1000, outputTokens: 500 })
		const result = calculateCost(u, 'claude-sonnet-4-20250514')

		const sonnet = getPricingForTier('sonnet')!
		const expected = 1000 * sonnet.inputPerToken + 500 * sonnet.outputPerToken
		expect(result.costUsd).toBeCloseTo(expected, 10)
		expect(result.unknown).toBe(false)
	})

	it('includes cache tokens in calculation', () => {
		const u = usage({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 2000,
			cacheWriteTokens: 500,
		})
		const result = calculateCost(u, 'opus')

		const opus = getPricingForTier('opus')!
		const expected =
			100 * opus.inputPerToken +
			50 * opus.outputPerToken +
			2000 * opus.cacheReadPerToken +
			500 * opus.cacheWritePerToken
		expect(result.costUsd).toBeCloseTo(expected, 10)
	})

	it('returns zero cost with unknown flag for unrecognized models', () => {
		const u = usage({ inputTokens: 1000, outputTokens: 500 })
		const result = calculateCost(u, 'gpt-4o-mini')
		expect(result.costUsd).toBe(0)
		expect(result.unknown).toBe(true)
	})

	it('still uses usage.cost for unrecognized models when cost is present', () => {
		const u = usage({ inputTokens: 1000, outputTokens: 500, cost: 0.05 })
		const result = calculateCost(u, 'gpt-4o-mini')
		expect(result.costUsd).toBe(0.05)
		expect(result.unknown).toBe(false)
	})
})

describe('getPricingForTier', () => {
	it('returns pricing for known tiers', () => {
		expect(getPricingForTier('opus')).toBeDefined()
		expect(getPricingForTier('sonnet')).toBeDefined()
		expect(getPricingForTier('haiku')).toBeDefined()
	})

	it('returns undefined for unknown tiers', () => {
		expect(getPricingForTier('gpt4')).toBeUndefined()
	})

	it('haiku is cheaper than sonnet is cheaper than opus', () => {
		const haiku = getPricingForTier('haiku')!
		const sonnet = getPricingForTier('sonnet')!
		const opus = getPricingForTier('opus')!

		expect(haiku.inputPerToken).toBeLessThan(sonnet.inputPerToken)
		expect(sonnet.inputPerToken).toBeLessThan(opus.inputPerToken)
	})
})
