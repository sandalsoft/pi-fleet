import { completeSimple } from '@mariozechner/pi-ai'
import type { Model } from '@mariozechner/pi-ai'
import type { AgentDefinition } from '../config/schema.js'

/**
 * Inferred answers from LLM analysis of the user's task description.
 */
export interface AnalysisResult {
	task_type: string
	affected_areas: string
	scope_size: string
	needs_devops: boolean
	needs_architect: boolean
	parallel_safe: boolean
}

const VALID_TASK_TYPES = ['feature', 'bugfix', 'refactor', 'docs', 'testing', 'devops', 'research']
const VALID_SCOPE_SIZES = ['small', 'medium', 'large']

/**
 * Use a fast LLM call to analyze the user's task description and
 * infer answers that would otherwise require interactive questions.
 *
 * Falls back to conservative defaults if the LLM call fails.
 */
export async function analyzeTaskDescription(opts: {
	taskDescription: string
	model: Model<any>
	detectedExtensions: string[]
	agents: AgentDefinition[]
}): Promise<AnalysisResult> {
	const { taskDescription, model, detectedExtensions, agents } = opts

	const agentIds = agents.map((a) => a.id).join(', ')
	const extensions = detectedExtensions.join(', ') || 'unknown'
	const hasArchitect = agents.some((a) => a.id === 'architect')

	const systemPrompt = `You analyze software task descriptions and return structured JSON. Be concise and accurate. Respond ONLY with valid JSON, no markdown or explanation.`

	const userPrompt = `Analyze this task and return JSON with these fields:

- "task_type": one of ${JSON.stringify(VALID_TASK_TYPES)}
- "affected_areas": comma-separated paths likely affected (e.g., "src/api, src/models, test/api"). Use the file extensions [${extensions}] and project structure hints to guess reasonable paths. If unclear, return "src/**".
- "scope_size": one of ${JSON.stringify(VALID_SCOPE_SIZES)} based on how many files/modules this likely touches
- "needs_devops": boolean, true if this involves CI/CD, deployment, infrastructure, Docker, or config changes
- "needs_architect": boolean, true if this task is complex enough to benefit from upfront architecture planning before coding (large refactors, new systems, cross-cutting changes)${hasArchitect ? '' : ' — set false, no architect agent available'}
- "parallel_safe": boolean, true if different parts of this task can be worked on independently by different agents without conflicts (e.g., backend + frontend, or separate modules)

Task: "${taskDescription}"

Available agents: [${agentIds}]

JSON:`

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

		return parseAnalysisResponse(text)
	} catch {
		return defaultAnalysis()
	}
}

/**
 * Parse the LLM's JSON response with validation and fallbacks.
 */
function parseAnalysisResponse(text: string): AnalysisResult {
	// Strip markdown code fences if present
	const cleaned = text.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim()

	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(cleaned)
	} catch {
		return defaultAnalysis()
	}

	const taskType = typeof parsed.task_type === 'string' && VALID_TASK_TYPES.includes(parsed.task_type)
		? parsed.task_type
		: 'feature'

	const affectedAreas = typeof parsed.affected_areas === 'string'
		? parsed.affected_areas
		: 'src/**'

	const scopeSize = typeof parsed.scope_size === 'string' && VALID_SCOPE_SIZES.includes(parsed.scope_size)
		? parsed.scope_size
		: 'medium'

	const needsDevops = typeof parsed.needs_devops === 'boolean'
		? parsed.needs_devops
		: false

	const needsArchitect = typeof parsed.needs_architect === 'boolean'
		? parsed.needs_architect
		: scopeSize === 'large'

	const parallelSafe = typeof parsed.parallel_safe === 'boolean'
		? parsed.parallel_safe
		: scopeSize !== 'small'

	return {
		task_type: taskType,
		affected_areas: affectedAreas,
		scope_size: scopeSize,
		needs_devops: needsDevops,
		needs_architect: needsArchitect,
		parallel_safe: parallelSafe,
	}
}

function defaultAnalysis(): AnalysisResult {
	return {
		task_type: 'feature',
		affected_areas: 'src/**',
		scope_size: 'medium',
		needs_devops: false,
		needs_architect: false,
		parallel_safe: true,
	}
}
