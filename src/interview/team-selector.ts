import type { AgentDefinition } from '../config/schema.js'
import type { EventLogWriter } from '../session/event-log.js'
import {
	createFleetEvent,
	type TeamSelectedEvent,
	type TaskGraphCreatedEvent,
} from '../session/events.js'

/**
 * A single task assignment: one agent, one task description, its dependencies,
 * and the expected file paths it will touch (for parallel-safety analysis).
 */
export interface TaskAssignment {
	agentId: string
	taskDescription: string
	dependsOn: string[]
	expectedPaths: string[]
}

/**
 * The full team selection result: which agents were selected and
 * the task DAG they'll execute.
 */
export interface TeamSelectionResult {
	selectedAgents: string[]
	assignments: TaskAssignment[]
	waves: TaskAssignment[][]
}

// --- Expertise scoring ---

/**
 * Keywords that map task types / descriptions to agent expertise areas.
 * Used by the scoring heuristic to match agents to tasks.
 */
const expertiseKeywords: Record<string, string[]> = {
	architect: ['architecture', 'design', 'plan', 'structure', 'system', 'module', 'component'],
	developer: [
		'implement',
		'code',
		'build',
		'feature',
		'function',
		'class',
		'api',
		'endpoint',
		'fix',
		'bug',
	],
	reviewer: ['review', 'quality', 'check', 'verify', 'approve', 'standards'],
	researcher: ['research', 'investigate', 'explore', 'analyze', 'study', 'evaluate'],
	qa: ['test', 'testing', 'qa', 'validation', 'coverage', 'assertion', 'spec'],
	devops: ['deploy', 'ci', 'cd', 'pipeline', 'infrastructure', 'docker', 'kubernetes', 'config'],
}

/**
 * Score how well an agent matches a task description.
 * Returns a number between 0 and 1.
 */
export function scoreAgentForTask(agent: AgentDefinition, taskDesc: string): number {
	const lower = taskDesc.toLowerCase()
	const keywords = expertiseKeywords[agent.id] ?? []

	// Check expertise field from front matter
	const expertiseLower = (agent.frontmatter.expertise ?? '').toLowerCase()

	let matches = 0
	let total = keywords.length || 1

	for (const kw of keywords) {
		if (lower.includes(kw)) matches++
	}

	// Bonus if the agent's expertise field mentions terms from the task
	const taskWords = lower.split(/\s+/)
	for (const word of taskWords) {
		if (word.length > 3 && expertiseLower.includes(word)) {
			matches += 0.5
		}
	}

	return Math.min(1, matches / total)
}

// --- Path overlap detection ---

/**
 * Check whether two sets of expected paths overlap.
 * Uses a conservative check: if either path is a prefix of the other,
 * or they share glob patterns (src/**), they overlap.
 * Empty paths always overlap (safe fallback: sequential).
 */
export function pathsOverlap(a: string[], b: string[]): boolean {
	if (a.length === 0 || b.length === 0) return true

	for (const pathA of a) {
		const normA = normalizePath(pathA)
		for (const pathB of b) {
			const normB = normalizePath(pathB)
			if (normA === normB) return true
			if (normA.startsWith(normB) || normB.startsWith(normA)) return true
		}
	}

	return false
}

function normalizePath(p: string): string {
	// Strip trailing glob patterns for prefix comparison
	return p.replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/$/, '')
}

// --- Task generation from interview answers ---

interface TaskGenContext {
	answers: Record<string, unknown>
	agents: AgentDefinition[]
}

/**
 * Generate task assignments from interview answers and the agent roster.
 * Determines which agents to include and what each should do.
 */
export function generateAssignments(ctx: TaskGenContext): TaskAssignment[] {
	const { answers, agents } = ctx
	const agentMap = new Map(agents.map((a) => [a.id, a]))
	const assignments: TaskAssignment[] = []

	const taskDesc = String(answers['task_description'] ?? '')
	const taskType = String(answers['task_type'] ?? 'feature')
	const affectedAreas = String(answers['affected_areas'] ?? '')
	const scopeSize = String(answers['scope_size'] ?? 'medium')
	const wantsTests = answers['has_tests'] === true
	const needsArchitect = answers['needs_architect'] === true
	const needsReview = answers['needs_review'] === true
	const needsDevops = answers['needs_devops'] === true
	const needsQa = answers['needs_qa'] === true

	// Parse affected areas into path hints
	const areaPaths = affectedAreas
		.split(/[,;]/)
		.map((s) => s.trim())
		.filter(Boolean)

	// 1. Architect (if needed) — runs first, no dependencies
	if (needsArchitect && agentMap.has('architect')) {
		assignments.push({
			agentId: 'architect',
			taskDescription: `Plan the architecture for: ${taskDesc}. Scope: ${scopeSize}. Affected areas: ${affectedAreas || 'TBD'}. Produce a clear design document with component breakdown and interfaces.`,
			dependsOn: [],
			expectedPaths: ['.pi/scratchpads/architect.md'],
		})
	}

	// 2. Developer(s) — the main implementation work
	if (agentMap.has('developer')) {
		const devDeps = needsArchitect && agentMap.has('architect') ? ['architect'] : []
		assignments.push({
			agentId: 'developer',
			taskDescription: buildDeveloperPrompt(taskDesc, taskType, affectedAreas, wantsTests),
			dependsOn: devDeps,
			expectedPaths: areaPaths.length > 0 ? areaPaths : ['src/**'],
		})
	}

	// 3. DevOps (if needed) — can run in parallel with developer if paths don't overlap
	if (needsDevops && agentMap.has('devops')) {
		const devDeps = needsArchitect && agentMap.has('architect') ? ['architect'] : []
		assignments.push({
			agentId: 'devops',
			taskDescription: `Handle infrastructure and deployment concerns for: ${taskDesc}. Update CI/CD, configuration, or deployment files as needed.`,
			dependsOn: devDeps,
			expectedPaths: ['.github/**', 'Dockerfile', 'docker-compose.yml', '.env.example'],
		})
	}

	// 4. QA (if needed) — runs after developer
	if (needsQa && agentMap.has('qa')) {
		assignments.push({
			agentId: 'qa',
			taskDescription: `Write comprehensive tests for: ${taskDesc}. Cover edge cases, error paths, and integration scenarios. Affected areas: ${affectedAreas || 'TBD'}.`,
			dependsOn: ['developer'],
			expectedPaths: areaPaths.map((p) => p.replace(/^src\//, 'test/')),
		})
	}

	// 5. Reviewer (if needed) — runs after all implementation work
	if (needsReview && agentMap.has('reviewer')) {
		const reviewDeps = assignments
			.filter((a) => a.agentId !== 'architect')
			.map((a) => a.agentId)
		assignments.push({
			agentId: 'reviewer',
			taskDescription: `Review the implementation of: ${taskDesc}. Check code quality, correctness, test coverage, and adherence to project conventions. Provide specific, actionable feedback.`,
			dependsOn: reviewDeps.length > 0 ? reviewDeps : [],
			expectedPaths: [],
		})
	}

	// 6. Research agent — if task type is research
	if (taskType === 'research' && agentMap.has('researcher')) {
		assignments.push({
			agentId: 'researcher',
			taskDescription: `Research and analyze: ${taskDesc}. Produce findings, recommendations, and relevant references.`,
			dependsOn: [],
			expectedPaths: ['.pi/scratchpads/researcher.md'],
		})
	}

	// If no assignments were generated, fall back to using the first available agent
	if (assignments.length === 0 && agents.length > 0) {
		const fallback = agents[0]
		assignments.push({
			agentId: fallback.id,
			taskDescription: taskDesc || 'Complete the assigned task.',
			dependsOn: [],
			expectedPaths: ['src/**'],
		})
	}

	return assignments
}

function buildDeveloperPrompt(
	taskDesc: string,
	taskType: string,
	affectedAreas: string,
	wantsTests: boolean
): string {
	const parts = [`Implement: ${taskDesc}.`]

	if (taskType === 'bugfix') {
		parts.push('This is a bug fix. Identify the root cause, fix it, and add a regression test.')
	} else if (taskType === 'refactor') {
		parts.push('This is a refactor. Preserve existing behavior while improving code structure.')
	}

	if (affectedAreas) {
		parts.push(`Focus on: ${affectedAreas}.`)
	}

	if (wantsTests) {
		parts.push('Write tests covering the implementation.')
	}

	return parts.join(' ')
}

// --- Wave construction (DAG → parallel execution waves) ---

/**
 * Build execution waves from task assignments using a topological sort.
 * Tasks that can run in parallel (no dependency relationship AND
 * no overlapping expectedPaths) go in the same wave.
 * Tasks with empty expectedPaths default to sequential.
 */
export function buildWaves(assignments: TaskAssignment[]): TaskAssignment[][] {
	if (assignments.length === 0) return []

	const byId = new Map(assignments.map((a) => [a.agentId, a]))
	const inDegree = new Map<string, number>()
	const dependents = new Map<string, string[]>()

	// Initialize
	for (const a of assignments) {
		inDegree.set(a.agentId, 0)
		dependents.set(a.agentId, [])
	}

	// Build the dependency graph
	for (const a of assignments) {
		for (const dep of a.dependsOn) {
			if (byId.has(dep)) {
				inDegree.set(a.agentId, (inDegree.get(a.agentId) ?? 0) + 1)
				dependents.get(dep)?.push(a.agentId)
			}
		}
	}

	const waves: TaskAssignment[][] = []
	let ready = assignments.filter((a) => (inDegree.get(a.agentId) ?? 0) === 0)

	while (ready.length > 0) {
		// Split ready tasks into sub-waves based on path overlap
		const wave = splitByPathOverlap(ready)
		waves.push(...wave)

		// Decrement in-degree for dependents
		const nextReady: TaskAssignment[] = []
		for (const completed of ready) {
			for (const depId of dependents.get(completed.agentId) ?? []) {
				const newDeg = (inDegree.get(depId) ?? 1) - 1
				inDegree.set(depId, newDeg)
				if (newDeg === 0) {
					const task = byId.get(depId)
					if (task) nextReady.push(task)
				}
			}
		}
		ready = nextReady
	}

	return waves
}

/**
 * Given a set of tasks at the same dependency level, split them into
 * sub-waves where tasks in the same sub-wave have non-overlapping paths.
 */
function splitByPathOverlap(tasks: TaskAssignment[]): TaskAssignment[][] {
	const waves: TaskAssignment[][] = []

	for (const task of tasks) {
		let placed = false
		for (const wave of waves) {
			const overlaps = wave.some((existing) =>
				pathsOverlap(existing.expectedPaths, task.expectedPaths)
			)
			if (!overlaps) {
				wave.push(task)
				placed = true
				break
			}
		}
		if (!placed) {
			waves.push([task])
		}
	}

	return waves
}

// --- Top-level team selection ---

interface SelectTeamOpts {
	answers: Record<string, unknown>
	agents: AgentDefinition[]
	teamId: string
	eventLog: EventLogWriter
}

/**
 * Select agents and build the task DAG from interview answers.
 * Emits team_selected and task_graph_created events.
 * Returns the full selection result.
 */
export async function selectTeam(opts: SelectTeamOpts): Promise<TeamSelectionResult> {
	const { answers, agents, teamId, eventLog } = opts

	const assignments = generateAssignments({ answers, agents })
	const waves = buildWaves(assignments)
	const selectedAgents = [...new Set(assignments.map((a) => a.agentId))]

	// Emit team_selected event
	await eventLog.append(
		createFleetEvent<TeamSelectedEvent>({
			type: 'team_selected',
			teamId,
			members: selectedAgents,
		})
	)

	// Emit task_graph_created event
	await eventLog.append(
		createFleetEvent<TaskGraphCreatedEvent>({
			type: 'task_graph_created',
			taskCount: assignments.length,
			waveCount: waves.length,
		})
	)

	return { selectedAgents, assignments, waves }
}
