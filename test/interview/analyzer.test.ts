import { describe, it, expect, vi } from 'vitest'

// We test parseAnalysisResponse indirectly via analyzeTaskDescription
// by mocking the LLM call. The analyzer module calls completeSimple
// from @mariozechner/pi-ai which is externalized, so we mock it.

vi.mock('@mariozechner/pi-ai', () => ({
	completeSimple: vi.fn(),
}))

import { analyzeTaskDescription, type AnalysisResult } from '../../src/interview/analyzer.js'
import { completeSimple } from '@mariozechner/pi-ai'
import type { AgentDefinition } from '../../src/config/schema.js'

const mockedComplete = vi.mocked(completeSimple)

function makeAgent(id: string): AgentDefinition {
	return {
		id,
		frontmatter: { name: id, model: 'sonnet' },
		body: '',
	}
}

function mockLLMResponse(json: Record<string, unknown>): void {
	mockedComplete.mockResolvedValueOnce({
		role: 'assistant',
		content: [{ type: 'text', text: JSON.stringify(json) }],
		api: 'anthropic' as any,
		provider: 'anthropic' as any,
		model: 'claude-sonnet-4-20250514',
		usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150 } as any,
		stopReason: 'stop',
		timestamp: Date.now(),
	} as any)
}

describe('analyzeTaskDescription', () => {
	it('parses a valid LLM response with all fields', async () => {
		mockLLMResponse({
			task_type: 'bugfix',
			affected_areas: 'src/auth, src/middleware',
			scope_size: 'small',
			needs_devops: false,
			needs_architect: false,
			parallel_safe: false,
		})

		const result = await analyzeTaskDescription({
			taskDescription: 'Fix the authentication timeout bug',
			model: {} as any,
			detectedExtensions: ['.ts'],
			agents: [makeAgent('developer')],
		})

		expect(result.task_type).toBe('bugfix')
		expect(result.affected_areas).toBe('src/auth, src/middleware')
		expect(result.scope_size).toBe('small')
		expect(result.needs_devops).toBe(false)
		expect(result.needs_architect).toBe(false)
		expect(result.parallel_safe).toBe(false)
	})

	it('handles LLM response wrapped in markdown code fences', async () => {
		mockedComplete.mockResolvedValueOnce({
			role: 'assistant',
			content: [{ type: 'text', text: '```json\n{"task_type":"refactor","affected_areas":"src/api","scope_size":"medium","needs_devops":false}\n```' }],
			api: 'anthropic' as any,
			provider: 'anthropic' as any,
			model: 'test',
			usage: {} as any,
			stopReason: 'stop',
			timestamp: Date.now(),
		} as any)

		const result = await analyzeTaskDescription({
			taskDescription: 'Refactor the API module',
			model: {} as any,
			detectedExtensions: ['.ts'],
			agents: [makeAgent('developer')],
		})

		expect(result.task_type).toBe('refactor')
		expect(result.scope_size).toBe('medium')
	})

	it('falls back to defaults for invalid task_type', async () => {
		mockLLMResponse({
			task_type: 'invalid_type',
			affected_areas: 'src/api',
			scope_size: 'medium',
			needs_devops: false,
		})

		const result = await analyzeTaskDescription({
			taskDescription: 'Do something',
			model: {} as any,
			detectedExtensions: [],
			agents: [],
		})

		expect(result.task_type).toBe('feature')
	})

	it('falls back to defaults when LLM call fails', async () => {
		mockedComplete.mockRejectedValueOnce(new Error('API error'))

		const result = await analyzeTaskDescription({
			taskDescription: 'Build a thing',
			model: {} as any,
			detectedExtensions: [],
			agents: [],
		})

		expect(result.task_type).toBe('feature')
		expect(result.affected_areas).toBe('src/**')
		expect(result.scope_size).toBe('medium')
		expect(result.needs_devops).toBe(false)
		expect(result.needs_architect).toBe(false)
		expect(result.parallel_safe).toBe(true)
	})

	it('falls back to defaults for malformed JSON response', async () => {
		mockedComplete.mockResolvedValueOnce({
			role: 'assistant',
			content: [{ type: 'text', text: 'This is not JSON at all' }],
			api: 'anthropic' as any,
			provider: 'anthropic' as any,
			model: 'test',
			usage: {} as any,
			stopReason: 'stop',
			timestamp: Date.now(),
		} as any)

		const result = await analyzeTaskDescription({
			taskDescription: 'Build something',
			model: {} as any,
			detectedExtensions: [],
			agents: [],
		})

		expect(result.task_type).toBe('feature')
		expect(result.scope_size).toBe('medium')
	})

	it('detects devops tasks correctly', async () => {
		mockLLMResponse({
			task_type: 'devops',
			affected_areas: '.github/workflows, Dockerfile',
			scope_size: 'medium',
			needs_devops: true,
		})

		const result = await analyzeTaskDescription({
			taskDescription: 'Set up CI/CD pipeline with GitHub Actions',
			model: {} as any,
			detectedExtensions: ['.yml', '.ts'],
			agents: [makeAgent('developer'), makeAgent('devops')],
		})

		expect(result.task_type).toBe('devops')
		expect(result.needs_devops).toBe(true)
	})
})
