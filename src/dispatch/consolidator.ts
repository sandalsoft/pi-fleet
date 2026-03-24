import type { Usage } from './types.js'
import { emptyUsage, addUsage } from './types.js'

export interface SpecialistReport {
	agentName: string
	report: string
	usage: Usage
	status: 'completed' | 'failed'
	/** Branch name in the specialist's worktree (for merge) */
	worktreeBranch?: string
}

export interface ConsolidationResult {
	summary: string
	reports: SpecialistReport[]
	totalUsage: Usage
	failedAgents: string[]
	completedAgents: string[]
}

/**
 * Collect and consolidate reports from all specialists in a wave.
 * Produces a unified summary suitable for the dispatcher or user display.
 */
export function consolidateReports(reports: SpecialistReport[]): ConsolidationResult {
	const completed = reports.filter((r) => r.status === 'completed')
	const failed = reports.filter((r) => r.status === 'failed')

	const totalUsage = reports.reduce(
		(acc, r) => addUsage(acc, r.usage),
		emptyUsage()
	)

	const summaryParts: string[] = []

	if (completed.length > 0) {
		summaryParts.push(`${completed.length} agent(s) completed successfully.`)
	}
	if (failed.length > 0) {
		summaryParts.push(`${failed.length} agent(s) failed: ${failed.map((r) => r.agentName).join(', ')}.`)
	}

	for (const report of completed) {
		if (report.report.trim()) {
			summaryParts.push(`\n## ${report.agentName}\n${report.report.trim()}`)
		}
	}

	for (const report of failed) {
		if (report.report.trim()) {
			summaryParts.push(`\n## ${report.agentName} (FAILED)\n${report.report.trim()}`)
		}
	}

	return {
		summary: summaryParts.join('\n'),
		reports,
		totalUsage,
		failedAgents: failed.map((r) => r.agentName),
		completedAgents: completed.map((r) => r.agentName),
	}
}
