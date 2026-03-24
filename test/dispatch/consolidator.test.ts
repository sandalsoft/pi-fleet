import { describe, it, expect } from 'vitest'
import { consolidateReports, type SpecialistReport } from '../../src/dispatch/consolidator.js'
import type { Usage } from '../../src/dispatch/types.js'

function usage(input: number, output: number): Usage {
	return {
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
	}
}

function report(
	agentName: string,
	status: 'completed' | 'failed',
	text: string,
	u: Usage = usage(100, 50)
): SpecialistReport {
	return { agentName, report: text, usage: u, status }
}

describe('consolidator', () => {
	it('consolidates completed reports into a summary', () => {
		const result = consolidateReports([
			report('developer', 'completed', 'Implemented login feature'),
			report('qa', 'completed', 'All tests passing'),
		])

		expect(result.completedAgents).toEqual(['developer', 'qa'])
		expect(result.failedAgents).toEqual([])
		expect(result.summary).toContain('2 agent(s) completed')
		expect(result.summary).toContain('## developer')
		expect(result.summary).toContain('Implemented login feature')
		expect(result.summary).toContain('## qa')
	})

	it('tracks failed agents separately', () => {
		const result = consolidateReports([
			report('developer', 'completed', 'Done'),
			report('qa', 'failed', 'Timeout'),
		])

		expect(result.completedAgents).toEqual(['developer'])
		expect(result.failedAgents).toEqual(['qa'])
		expect(result.summary).toContain('1 agent(s) completed')
		expect(result.summary).toContain('1 agent(s) failed: qa')
		expect(result.summary).toContain('## qa (FAILED)')
	})

	it('aggregates usage across all reports', () => {
		const result = consolidateReports([
			report('dev', 'completed', 'Done', usage(100, 50)),
			report('qa', 'completed', 'Pass', usage(200, 75)),
		])

		expect(result.totalUsage.inputTokens).toBe(300)
		expect(result.totalUsage.outputTokens).toBe(125)
	})

	it('handles empty reports array', () => {
		const result = consolidateReports([])

		expect(result.completedAgents).toEqual([])
		expect(result.failedAgents).toEqual([])
		expect(result.totalUsage.inputTokens).toBe(0)
		expect(result.summary).toBe('')
	})

	it('handles reports with empty text', () => {
		const result = consolidateReports([
			report('dev', 'completed', ''),
		])

		expect(result.completedAgents).toEqual(['dev'])
		// Should not include section header for empty report
		expect(result.summary).not.toContain('## dev')
	})

	it('handles all-failed scenario', () => {
		const result = consolidateReports([
			report('dev', 'failed', 'Out of memory'),
			report('qa', 'failed', 'Timeout'),
		])

		expect(result.completedAgents).toEqual([])
		expect(result.failedAgents).toEqual(['dev', 'qa'])
		expect(result.summary).toContain('2 agent(s) failed: dev, qa')
	})
})
