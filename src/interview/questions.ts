import type { AgentDefinition } from '../config/schema.js'

/**
 * Context available to question condition functions.
 * Populated before the interview starts from the agent roster,
 * file system scan, and accumulating answers.
 */
export interface InterviewContext {
	/** Agent definitions loaded from .pi/agents/*.md */
	agents: AgentDefinition[]
	/** File extensions detected in the project root (e.g., ['.ts', '.py', '.go']) */
	detectedExtensions: string[]
	/** Answers collected so far (keyed by question id) */
	answers: Record<string, unknown>
}

export type QuestionKind = 'input' | 'select' | 'confirm'

export interface SelectOption {
	label: string
	value: string
}

export interface InterviewQuestion {
	id: string
	category: 'task' | 'scope' | 'agents' | 'constraints' | 'priorities'
	kind: QuestionKind
	prompt: string
	/** For select questions: build options from context */
	options?: (ctx: InterviewContext) => SelectOption[]
	/** Return true if this question should be asked */
	condition: (ctx: InterviewContext) => boolean
}

// --- Question bank ---

export const questionBank: InterviewQuestion[] = [
	// Task understanding
	{
		id: 'task_description',
		category: 'task',
		kind: 'input',
		prompt: 'Describe the task you want the fleet to work on:',
		condition: () => true,
	},
	{
		id: 'task_type',
		category: 'task',
		kind: 'select',
		prompt: 'What kind of work is this?',
		options: () => [
			{ label: 'New feature', value: 'feature' },
			{ label: 'Bug fix', value: 'bugfix' },
			{ label: 'Refactor', value: 'refactor' },
			{ label: 'Documentation', value: 'docs' },
			{ label: 'Testing', value: 'testing' },
			{ label: 'DevOps / Infrastructure', value: 'devops' },
			{ label: 'Research / Exploration', value: 'research' },
		],
		condition: () => true,
	},
	{
		id: 'task_details',
		category: 'task',
		kind: 'input',
		prompt: 'Any specific requirements, constraints, or acceptance criteria?',
		condition: () => true,
	},

	// Scope
	{
		id: 'affected_areas',
		category: 'scope',
		kind: 'input',
		prompt: 'Which areas of the codebase will be affected? (e.g., src/api, frontend, database)',
		condition: () => true,
	},
	{
		id: 'scope_size',
		category: 'scope',
		kind: 'select',
		prompt: 'How large is this change?',
		options: () => [
			{ label: 'Small (single file or function)', value: 'small' },
			{ label: 'Medium (a few files, one module)', value: 'medium' },
			{ label: 'Large (cross-cutting, multiple modules)', value: 'large' },
		],
		condition: () => true,
	},
	{
		id: 'has_tests',
		category: 'scope',
		kind: 'confirm',
		prompt: 'Should the agents write tests for this work?',
		condition: () => true,
	},

	// Agent selection context
	{
		id: 'needs_architect',
		category: 'agents',
		kind: 'confirm',
		prompt: 'Does this task need upfront architecture planning before coding?',
		condition: (ctx) => {
			const scope = ctx.answers['scope_size']
			const hasArchitect = ctx.agents.some((a) => a.id === 'architect')
			return hasArchitect && (scope === 'medium' || scope === 'large')
		},
	},
	{
		id: 'needs_review',
		category: 'agents',
		kind: 'confirm',
		prompt: 'Should a reviewer agent check the work before merging?',
		condition: (ctx) => {
			return ctx.agents.some((a) => a.id === 'reviewer')
		},
	},
	{
		id: 'needs_devops',
		category: 'agents',
		kind: 'confirm',
		prompt: 'Does this involve infrastructure, CI/CD, or deployment changes?',
		condition: (ctx) => {
			const taskType = ctx.answers['task_type']
			const hasDevops = ctx.agents.some((a) => a.id === 'devops')
			return hasDevops && taskType !== 'devops'
		},
	},
	{
		id: 'needs_qa',
		category: 'agents',
		kind: 'confirm',
		prompt: 'Should a dedicated QA agent validate the implementation?',
		condition: (ctx) => {
			const hasQa = ctx.agents.some((a) => a.id === 'qa')
			const wantsTests = ctx.answers['has_tests'] === true
			return hasQa && wantsTests
		},
	},

	// Constraints
	{
		id: 'priority_speed_or_quality',
		category: 'priorities',
		kind: 'select',
		prompt: 'What matters more for this task?',
		options: () => [
			{ label: 'Speed (get it done fast, review later)', value: 'speed' },
			{ label: 'Quality (thorough review, more agents)', value: 'quality' },
			{ label: 'Balanced', value: 'balanced' },
		],
		condition: () => true,
	},
	{
		id: 'parallel_safe',
		category: 'constraints',
		kind: 'confirm',
		prompt: 'Can different parts of this task be worked on in parallel by different agents?',
		condition: (ctx) => {
			const scope = ctx.answers['scope_size']
			return scope === 'medium' || scope === 'large'
		},
	},
]

/**
 * Filter the question bank to only questions whose conditions are met,
 * given the current interview context.
 */
export function getApplicableQuestions(ctx: InterviewContext): InterviewQuestion[] {
	return questionBank.filter((q) => q.condition(ctx))
}
