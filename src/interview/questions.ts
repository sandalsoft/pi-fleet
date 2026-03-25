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
// After the task_description is collected, an LLM call auto-infers:
//   task_type, affected_areas, scope_size, needs_devops, needs_architect, parallel_safe
// Hard-coded always-yes: needs_qa, needs_review, has_tests
// Only task_description and priority remain as interactive questions.

export const questionBank: InterviewQuestion[] = [
	// Task understanding — the only free-form input
	{
		id: 'task_description',
		category: 'task',
		kind: 'input',
		prompt: 'Describe the task you want the fleet to work on:',
		condition: () => true,
	},

	// Priority — the only remaining choice
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
]

/**
 * Filter the question bank to only questions whose conditions are met,
 * given the current interview context.
 */
export function getApplicableQuestions(ctx: InterviewContext): InterviewQuestion[] {
	return questionBank.filter((q) => q.condition(ctx))
}
