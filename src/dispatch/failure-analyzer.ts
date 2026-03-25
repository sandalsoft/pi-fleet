import { completeSimple } from '@mariozechner/pi-ai'
import type { Model } from '@mariozechner/pi-ai'

/**
 * Use an LLM to analyze why an agent failed and produce a
 * human-readable diagnosis.
 *
 * Inputs: the agent's stdout (JSONL), stderr, task brief, and error details
 * extracted from the stream. Falls back to a raw summary if the LLM call fails.
 */
export async function analyzeFailure(opts: {
	agentName: string
	taskBrief: string
	stdout: string
	stderr: string
	errorDetails: string[]
	report: string
	model: Model<any>
}): Promise<string> {
	const { agentName, taskBrief, stdout, stderr, errorDetails, report, model } = opts

	// Build context from available data — truncate to avoid blowing token limits
	const rawContext = buildRawContext(stdout, stderr, errorDetails, report)

	// If we have no data at all, return a generic message
	if (!rawContext.trim()) {
		return `Agent "${agentName}" failed with no output. The process may have been killed by timeout or signal.`
	}

	const systemPrompt = `You analyze why an AI coding agent failed its task. Be specific and actionable. Output 2-4 sentences: what went wrong, the likely root cause, and what to fix. No markdown formatting.`

	const userPrompt = `Agent "${agentName}" failed while working on: ${taskBrief}

Here is the relevant output from the agent:

${rawContext}

What went wrong and how should it be fixed?`

	try {
		const response = await completeSimple(model, {
			systemPrompt,
			messages: [{
				role: 'user' as const,
				content: userPrompt,
				timestamp: Date.now(),
			}],
		}, {
			maxTokens: 300,
			temperature: 0,
		})

		const text = response.content
			.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
			.map((c) => c.text)
			.join('')
			.trim()

		return text || buildFallbackSummary(agentName, errorDetails, stderr, report)
	} catch {
		return buildFallbackSummary(agentName, errorDetails, stderr, report)
	}
}

/**
 * Build raw context from all available error data, truncated to ~2000 chars.
 */
function buildRawContext(stdout: string, stderr: string, errorDetails: string[], report: string): string {
	const parts: string[] = []

	if (errorDetails.length > 0) {
		parts.push('Error details:')
		parts.push(errorDetails.join('\n').slice(0, 800))
	}

	if (stderr.trim()) {
		parts.push('Stderr:')
		parts.push(stderr.trim().slice(-500))
	}

	if (report) {
		parts.push('Last agent message:')
		parts.push(report.slice(-500))
	}

	// If nothing above, grab the last chunk of stdout
	if (parts.length === 0 && stdout.trim()) {
		parts.push('Raw output (last lines):')
		const lines = stdout.trim().split('\n')
		parts.push(lines.slice(-20).join('\n').slice(-800))
	}

	return parts.join('\n\n').slice(0, 2000)
}

/**
 * Non-LLM fallback when the API is unavailable.
 */
function buildFallbackSummary(agentName: string, errorDetails: string[], stderr: string, report: string): string {
	if (errorDetails.length > 0) {
		return `${agentName} failed: ${errorDetails[0].slice(0, 200)}`
	}
	if (stderr.trim()) {
		const lastLine = stderr.trim().split('\n').pop() ?? ''
		return `${agentName} failed: ${lastLine.slice(0, 200)}`
	}
	if (report) {
		return `${agentName} failed. Last output: ${report.slice(0, 200)}`
	}
	return `${agentName} failed with no diagnostic output. Check if pi is installed and the model is accessible.`
}
