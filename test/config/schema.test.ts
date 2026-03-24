import { describe, it, expect } from 'vitest'
import { TeamSchema, AgentFrontmatterSchema, ChainSchema } from '../../src/config/schema.js'

describe('TeamSchema', () => {
	const validTeam = {
		team_id: 'dev-squad',
		orchestrator: { model: 'claude-sonnet-4-20250514', skills: ['planning'] },
		members: ['architect', 'developer'],
		constraints: {
			max_usd: 5.0,
			max_minutes: 30,
			max_concurrency: 3,
		},
	}

	it('parses a valid team config and transforms to camelCase', () => {
		const result = TeamSchema.safeParse(validTeam)
		expect(result.success).toBe(true)
		if (!result.success) return

		expect(result.data.teamId).toBe('dev-squad')
		expect(result.data.orchestrator.model).toBe('claude-sonnet-4-20250514')
		expect(result.data.orchestrator.skills).toEqual(['planning'])
		expect(result.data.members).toEqual(['architect', 'developer'])
		expect(result.data.constraints.maxUsd).toBe(5.0)
		expect(result.data.constraints.maxMinutes).toBe(30)
		expect(result.data.constraints.maxConcurrency).toBe(3)
	})

	it('applies default task_timeout_ms of 120000', () => {
		const result = TeamSchema.safeParse(validTeam)
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.data.constraints.taskTimeoutMs).toBe(120000)
	})

	it('accepts optional task_timeout_ms override', () => {
		const withTimeout = {
			...validTeam,
			constraints: { ...validTeam.constraints, task_timeout_ms: 60000 },
		}
		const result = TeamSchema.safeParse(withTimeout)
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.data.constraints.taskTimeoutMs).toBe(60000)
	})

	it('rejects unknown keys (strict mode)', () => {
		const withPaths = { ...validTeam, paths: { agents: './agents' } }
		const result = TeamSchema.safeParse(withPaths)
		expect(result.success).toBe(false)
		if (result.success) return
		const messages = result.error.issues.map((i) => i.message)
		expect(messages.some((m) => m.includes('Unrecognized key'))).toBe(true)
	})

	it('rejects missing team_id', () => {
		const { team_id: _, ...noId } = validTeam
		const result = TeamSchema.safeParse(noId)
		expect(result.success).toBe(false)
	})

	it('rejects empty members array', () => {
		const empty = { ...validTeam, members: [] }
		const result = TeamSchema.safeParse(empty)
		expect(result.success).toBe(false)
	})

	it('rejects negative max_usd', () => {
		const neg = {
			...validTeam,
			constraints: { ...validTeam.constraints, max_usd: -1 },
		}
		const result = TeamSchema.safeParse(neg)
		expect(result.success).toBe(false)
	})
})

describe('AgentFrontmatterSchema', () => {
	it('parses required fields', () => {
		const result = AgentFrontmatterSchema.safeParse({
			name: 'Architect',
			model: 'claude-sonnet-4-20250514',
		})
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.data.name).toBe('Architect')
		expect(result.data.model).toBe('claude-sonnet-4-20250514')
	})

	it('accepts optional fields', () => {
		const result = AgentFrontmatterSchema.safeParse({
			name: 'Developer',
			model: 'claude-sonnet-4-20250514',
			skills: ['typescript', 'testing'],
			expertise: 'Full-stack development',
			thinking: 'high',
		})
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.data.skills).toEqual(['typescript', 'testing'])
		expect(result.data.expertise).toBe('Full-stack development')
		expect(result.data.thinking).toBe('high')
	})

	it('allows unknown keys (passthrough for forward compat)', () => {
		const result = AgentFrontmatterSchema.safeParse({
			name: 'Tester',
			model: 'haiku',
			custom_field: 'preserved',
		})
		expect(result.success).toBe(true)
		if (!result.success) return
		expect((result.data as Record<string, unknown>).custom_field).toBe('preserved')
	})

	it('rejects missing name', () => {
		const result = AgentFrontmatterSchema.safeParse({ model: 'sonnet' })
		expect(result.success).toBe(false)
	})

	it('rejects missing model', () => {
		const result = AgentFrontmatterSchema.safeParse({ name: 'Test' })
		expect(result.success).toBe(false)
	})
})

describe('ChainSchema', () => {
	it('parses a valid chain config', () => {
		const result = ChainSchema.safeParse({
			name: 'review-pipeline',
			steps: [
				{ agent: 'architect', prompt: 'Review the design' },
				{ agent: 'developer' },
			],
		})
		expect(result.success).toBe(true)
		if (!result.success) return
		expect(result.data.name).toBe('review-pipeline')
		expect(result.data.steps).toHaveLength(2)
		expect(result.data.steps[0].agent).toBe('architect')
		expect(result.data.steps[0].prompt).toBe('Review the design')
		expect(result.data.steps[1].prompt).toBeUndefined()
	})

	it('rejects empty steps', () => {
		const result = ChainSchema.safeParse({ name: 'empty', steps: [] })
		expect(result.success).toBe(false)
	})

	it('rejects missing name', () => {
		const result = ChainSchema.safeParse({ steps: [{ agent: 'dev' }] })
		expect(result.success).toBe(false)
	})
})
