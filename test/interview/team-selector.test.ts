import { describe, it, expect, vi } from 'vitest'
import {
	scoreAgentForTask,
	pathsOverlap,
	generateAssignments,
	buildWaves,
	selectTeam,
	type TaskAssignment,
} from '../../src/interview/team-selector.js'
import type { AgentDefinition } from '../../src/config/schema.js'
import type { EventLogWriter } from '../../src/session/event-log.js'

// --- Helpers ---

function makeAgent(id: string, expertise?: string): AgentDefinition {
	return {
		id,
		frontmatter: { name: id.charAt(0).toUpperCase() + id.slice(1), model: 'sonnet', expertise },
		body: `You are a ${id}.`,
	}
}

const fullRoster: AgentDefinition[] = [
	makeAgent('architect', 'system design and architecture planning'),
	makeAgent('developer', 'implementation, coding, building features'),
	makeAgent('reviewer', 'code review and quality standards'),
	makeAgent('qa', 'testing, validation, test coverage'),
	makeAgent('devops', 'infrastructure, CI/CD, deployment'),
	makeAgent('researcher', 'research, analysis, investigation'),
]

function makeMockEventLog(): EventLogWriter & { events: unknown[] } {
	const events: unknown[] = []
	return {
		events,
		async append(event: unknown) {
			events.push(event)
		},
	}
}

// --- scoreAgentForTask ---

describe('scoreAgentForTask', () => {
	it('scores developer high for implementation tasks', () => {
		const dev = makeAgent('developer', 'implementation')
		const score = scoreAgentForTask(dev, 'Implement the user login feature')
		expect(score).toBeGreaterThan(0)
	})

	it('scores architect high for design tasks', () => {
		const arch = makeAgent('architect', 'system design')
		const score = scoreAgentForTask(arch, 'Design the module architecture')
		expect(score).toBeGreaterThan(0)
	})

	it('scores zero for unrelated agent/task combo', () => {
		const devops = makeAgent('devops', 'deployment')
		const score = scoreAgentForTask(devops, 'Write unit tests for the parser')
		expect(score).toBe(0)
	})

	it('considers expertise field in scoring', () => {
		const custom = makeAgent('specialist', 'authentication and security')
		const score = scoreAgentForTask(custom, 'Fix the authentication flow')
		expect(score).toBeGreaterThan(0)
	})
})

// --- pathsOverlap ---

describe('pathsOverlap', () => {
	it('returns true for empty paths (safe default)', () => {
		expect(pathsOverlap([], ['src/api'])).toBe(true)
		expect(pathsOverlap(['src/api'], [])).toBe(true)
		expect(pathsOverlap([], [])).toBe(true)
	})

	it('returns true for identical paths', () => {
		expect(pathsOverlap(['src/api'], ['src/api'])).toBe(true)
	})

	it('returns true for prefix relationships', () => {
		expect(pathsOverlap(['src'], ['src/api'])).toBe(true)
		expect(pathsOverlap(['src/api'], ['src'])).toBe(true)
	})

	it('returns false for non-overlapping paths', () => {
		expect(pathsOverlap(['src/api'], ['test/api'])).toBe(false)
		expect(pathsOverlap(['.github/**'], ['src/models'])).toBe(false)
	})

	it('handles glob patterns by stripping trailing globs', () => {
		expect(pathsOverlap(['src/**'], ['src/api'])).toBe(true)
		expect(pathsOverlap(['src/*'], ['src/api'])).toBe(true)
	})

	it('returns false for sibling directories', () => {
		expect(pathsOverlap(['src/auth'], ['src/billing'])).toBe(false)
	})
})

// --- generateAssignments ---

describe('generateAssignments', () => {
	it('generates developer assignment for basic feature request', () => {
		const assignments = generateAssignments({
			answers: {
				task_description: 'Build a REST API',
				task_type: 'feature',
				affected_areas: 'src/api',
				scope_size: 'medium',
				has_tests: false,
			},
			agents: [makeAgent('developer')],
		})

		expect(assignments).toHaveLength(1)
		expect(assignments[0].agentId).toBe('developer')
		expect(assignments[0].expectedPaths).toContain('src/api')
	})

	it('includes architect when needs_architect is true', () => {
		const assignments = generateAssignments({
			answers: {
				task_description: 'Build a microservice',
				task_type: 'feature',
				scope_size: 'large',
				needs_architect: true,
				has_tests: false,
			},
			agents: fullRoster,
		})

		const architect = assignments.find((a) => a.agentId === 'architect')
		expect(architect).toBeDefined()
		expect(architect!.dependsOn).toEqual([])

		const developer = assignments.find((a) => a.agentId === 'developer')
		expect(developer).toBeDefined()
		expect(developer!.dependsOn).toContain('architect')
	})

	it('includes reviewer with correct dependencies', () => {
		const assignments = generateAssignments({
			answers: {
				task_description: 'Fix login bug',
				task_type: 'bugfix',
				scope_size: 'small',
				has_tests: false,
				needs_review: true,
			},
			agents: [makeAgent('developer'), makeAgent('reviewer')],
		})

		const reviewer = assignments.find((a) => a.agentId === 'reviewer')
		expect(reviewer).toBeDefined()
		expect(reviewer!.dependsOn).toContain('developer')
		expect(reviewer!.expectedPaths).toEqual([])
	})

	it('includes QA agent when tests are requested', () => {
		const assignments = generateAssignments({
			answers: {
				task_description: 'Add pagination',
				task_type: 'feature',
				affected_areas: 'src/api',
				scope_size: 'medium',
				has_tests: true,
				needs_qa: true,
			},
			agents: [makeAgent('developer'), makeAgent('qa')],
		})

		const qa = assignments.find((a) => a.agentId === 'qa')
		expect(qa).toBeDefined()
		expect(qa!.dependsOn).toContain('developer')
		expect(qa!.expectedPaths).toContain('test/api')
	})

	it('includes devops when needs_devops is true', () => {
		const assignments = generateAssignments({
			answers: {
				task_description: 'Add CI pipeline',
				task_type: 'feature',
				scope_size: 'medium',
				has_tests: false,
				needs_devops: true,
			},
			agents: [makeAgent('developer'), makeAgent('devops')],
		})

		const devops = assignments.find((a) => a.agentId === 'devops')
		expect(devops).toBeDefined()
		expect(devops!.expectedPaths).toContain('.github/**')
	})

	it('includes researcher for research task type', () => {
		const assignments = generateAssignments({
			answers: {
				task_description: 'Evaluate auth libraries',
				task_type: 'research',
				scope_size: 'small',
				has_tests: false,
			},
			agents: [makeAgent('developer'), makeAgent('researcher')],
		})

		const researcher = assignments.find((a) => a.agentId === 'researcher')
		expect(researcher).toBeDefined()
		expect(researcher!.dependsOn).toEqual([])
	})

	it('falls back to first agent when no assignments match', () => {
		const assignments = generateAssignments({
			answers: { task_description: 'Do something' },
			agents: [makeAgent('custom-agent')],
		})

		expect(assignments).toHaveLength(1)
		expect(assignments[0].agentId).toBe('custom-agent')
	})

	it('defaults to src/** when no affected areas specified', () => {
		const assignments = generateAssignments({
			answers: {
				task_description: 'Build a feature',
				task_type: 'feature',
				scope_size: 'medium',
				has_tests: false,
			},
			agents: [makeAgent('developer')],
		})

		expect(assignments[0].expectedPaths).toEqual(['src/**'])
	})

	it('generates bug fix developer prompt', () => {
		const assignments = generateAssignments({
			answers: {
				task_description: 'Fix the auth timeout',
				task_type: 'bugfix',
				scope_size: 'small',
				has_tests: false,
			},
			agents: [makeAgent('developer')],
		})

		expect(assignments[0].taskDescription).toContain('bug fix')
	})
})

// --- buildWaves ---

describe('buildWaves', () => {
	it('returns empty for no assignments', () => {
		expect(buildWaves([])).toEqual([])
	})

	it('puts independent tasks with non-overlapping paths in same wave', () => {
		const assignments: TaskAssignment[] = [
			{ agentId: 'developer', taskDescription: 'Build API', dependsOn: [], expectedPaths: ['src/api'] },
			{ agentId: 'devops', taskDescription: 'Set up CI', dependsOn: [], expectedPaths: ['.github/**'] },
		]

		const waves = buildWaves(assignments)
		expect(waves).toHaveLength(1)
		expect(waves[0]).toHaveLength(2)
	})

	it('puts independent tasks with overlapping paths in separate waves', () => {
		const assignments: TaskAssignment[] = [
			{ agentId: 'agent-a', taskDescription: 'Task A', dependsOn: [], expectedPaths: ['src/auth'] },
			{ agentId: 'agent-b', taskDescription: 'Task B', dependsOn: [], expectedPaths: ['src/auth'] },
		]

		const waves = buildWaves(assignments)
		expect(waves).toHaveLength(2)
	})

	it('respects dependency ordering', () => {
		const assignments: TaskAssignment[] = [
			{ agentId: 'architect', taskDescription: 'Plan', dependsOn: [], expectedPaths: ['.pi/scratchpads/architect.md'] },
			{ agentId: 'developer', taskDescription: 'Build', dependsOn: ['architect'], expectedPaths: ['src/**'] },
			{ agentId: 'reviewer', taskDescription: 'Review', dependsOn: ['developer'], expectedPaths: [] },
		]

		const waves = buildWaves(assignments)
		expect(waves.length).toBeGreaterThanOrEqual(3)

		// Architect must be in an earlier wave than developer
		const archWaveIdx = waves.findIndex((w) => w.some((a) => a.agentId === 'architect'))
		const devWaveIdx = waves.findIndex((w) => w.some((a) => a.agentId === 'developer'))
		const revWaveIdx = waves.findIndex((w) => w.some((a) => a.agentId === 'reviewer'))

		expect(archWaveIdx).toBeLessThan(devWaveIdx)
		expect(devWaveIdx).toBeLessThan(revWaveIdx)
	})

	it('defaults tasks with empty expectedPaths to sequential', () => {
		const assignments: TaskAssignment[] = [
			{ agentId: 'agent-a', taskDescription: 'Task A', dependsOn: [], expectedPaths: [] },
			{ agentId: 'agent-b', taskDescription: 'Task B', dependsOn: [], expectedPaths: ['src/b'] },
		]

		const waves = buildWaves(assignments)
		// Empty paths overlap with everything, so they go in separate waves
		expect(waves).toHaveLength(2)
	})

	it('handles complex DAG with mixed parallel and sequential', () => {
		const assignments: TaskAssignment[] = [
			{ agentId: 'architect', taskDescription: 'Plan', dependsOn: [], expectedPaths: ['.pi/scratchpads/architect.md'] },
			{ agentId: 'developer', taskDescription: 'Build API', dependsOn: ['architect'], expectedPaths: ['src/api'] },
			{ agentId: 'devops', taskDescription: 'Set up CI', dependsOn: ['architect'], expectedPaths: ['.github/**'] },
			{ agentId: 'qa', taskDescription: 'Write tests', dependsOn: ['developer'], expectedPaths: ['test/api'] },
			{ agentId: 'reviewer', taskDescription: 'Review', dependsOn: ['developer', 'devops'], expectedPaths: [] },
		]

		const waves = buildWaves(assignments)

		// Architect first, then developer+devops in parallel, then qa+reviewer
		expect(waves.length).toBeGreaterThanOrEqual(3)

		const archWave = waves.findIndex((w) => w.some((a) => a.agentId === 'architect'))
		expect(archWave).toBe(0)

		// Developer and devops can be in same wave (non-overlapping paths)
		const devWave = waves.findIndex((w) => w.some((a) => a.agentId === 'developer'))
		const devopsWave = waves.findIndex((w) => w.some((a) => a.agentId === 'devops'))
		expect(devWave).toBe(devopsWave)
	})
})

// --- selectTeam ---

describe('selectTeam', () => {
	it('emits team_selected and task_graph_created events', async () => {
		const eventLog = makeMockEventLog()

		const result = await selectTeam({
			answers: {
				task_description: 'Build a thing',
				task_type: 'feature',
				scope_size: 'medium',
				has_tests: true,
				needs_review: true,
				needs_qa: true,
			},
			agents: [makeAgent('developer'), makeAgent('reviewer'), makeAgent('qa')],
			teamId: 'dev-squad',
			eventLog,
		})

		const teamEvent = eventLog.events.find((e: any) => e.type === 'team_selected') as any
		expect(teamEvent).toBeDefined()
		expect(teamEvent.teamId).toBe('dev-squad')
		expect(teamEvent.members).toContain('developer')

		const graphEvent = eventLog.events.find((e: any) => e.type === 'task_graph_created') as any
		expect(graphEvent).toBeDefined()
		expect(graphEvent.taskCount).toBeGreaterThan(0)
		expect(graphEvent.waveCount).toBeGreaterThan(0)
	})

	it('returns assignments with expectedPaths', async () => {
		const eventLog = makeMockEventLog()

		const result = await selectTeam({
			answers: {
				task_description: 'Build API endpoints',
				task_type: 'feature',
				affected_areas: 'src/api',
				scope_size: 'medium',
				has_tests: false,
			},
			agents: [makeAgent('developer')],
			teamId: 'team-1',
			eventLog,
		})

		expect(result.assignments).toHaveLength(1)
		expect(result.assignments[0].expectedPaths).toContain('src/api')
		expect(result.waves.length).toBeGreaterThan(0)
	})

	it('selects different agents based on interview answers', async () => {
		const eventLog = makeMockEventLog()

		// With architect and review requested
		const withAll = await selectTeam({
			answers: {
				task_description: 'Build something complex',
				task_type: 'feature',
				scope_size: 'large',
				has_tests: true,
				needs_architect: true,
				needs_review: true,
				needs_qa: true,
				needs_devops: true,
			},
			agents: fullRoster,
			teamId: 'full-team',
			eventLog,
		})

		expect(withAll.selectedAgents).toContain('architect')
		expect(withAll.selectedAgents).toContain('developer')
		expect(withAll.selectedAgents).toContain('reviewer')
		expect(withAll.selectedAgents).toContain('qa')
		expect(withAll.selectedAgents).toContain('devops')
	})

	it('handles minimal answers gracefully', async () => {
		const eventLog = makeMockEventLog()

		const result = await selectTeam({
			answers: { task_description: 'Do a thing' },
			agents: [makeAgent('developer')],
			teamId: 'minimal',
			eventLog,
		})

		expect(result.assignments.length).toBeGreaterThan(0)
		expect(result.selectedAgents).toContain('developer')
	})
})
