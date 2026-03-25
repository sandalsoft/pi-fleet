import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import type { AgentDefinition } from '../config/schema.js'
import type { EventLogWriter } from '../session/event-log.js'
import { createFleetEvent, type InterviewCompleteEvent } from '../session/events.js'
import {
	type InterviewContext,
	type InterviewQuestion,
	getApplicableQuestions,
} from './questions.js'
import { analyzeTaskDescription } from './analyzer.js'

/**
 * Result of the interview process.
 * `cancelled` is true if the user bailed out mid-interview.
 */
export interface InterviewResult {
	cancelled: boolean
	answers: Record<string, unknown>
}

/**
 * Detect file extensions present in the project root (non-recursive, top level + src/).
 * Returns a deduplicated sorted array of extensions like ['.go', '.py', '.ts'].
 */
export async function detectProjectExtensions(repoRoot: string): Promise<string[]> {
	const extensions = new Set<string>()

	async function scanDir(dir: string): Promise<void> {
		let entries: string[]
		try {
			entries = await fs.readdir(dir)
		} catch {
			return
		}
		for (const entry of entries) {
			const ext = path.extname(entry)
			if (ext) extensions.add(ext)
		}
	}

	await scanDir(repoRoot)
	await scanDir(path.join(repoRoot, 'src'))

	return [...extensions].sort()
}

interface RunInterviewOpts {
	pi: ExtensionAPI
	ctx: ExtensionCommandContext
	agents: AgentDefinition[]
	repoRoot: string
	eventLog: EventLogWriter
}

/**
 * Run the interactive interview via pi UI methods.
 *
 * Flow:
 * 1. Ask for the task description (free-form input)
 * 2. LLM-analyze the description to infer task_type, affected_areas,
 *    scope_size, and needs_devops — skipping those interactive questions
 * 3. Hard-code needs_qa = true, needs_review = true
 * 4. Ask remaining questions (has_tests, needs_architect, priority, parallel_safe)
 */
export async function runInterview(opts: RunInterviewOpts): Promise<InterviewResult> {
	const { ctx, agents, repoRoot, eventLog } = opts

	const detectedExtensions = await detectProjectExtensions(repoRoot)

	const interviewCtx: InterviewContext = {
		agents,
		detectedExtensions,
		answers: {},
	}

	// Track which questions have already been asked
	const asked = new Set<string>()

	// Step 1: Ask for the task description
	const taskDescQuestion = getApplicableQuestions(interviewCtx).find((q) => q.id === 'task_description')
	if (taskDescQuestion) {
		asked.add('task_description')
		const answer = await askQuestion(ctx, taskDescQuestion, interviewCtx)
		if (answer === undefined) {
			await emitAbort(eventLog)
			return { cancelled: true, answers: interviewCtx.answers }
		}
		interviewCtx.answers['task_description'] = answer
	}

	// Step 2: LLM-analyze the task description to auto-infer answers
	const taskDescription = String(interviewCtx.answers['task_description'] ?? '')
	if (taskDescription && ctx.model) {
		ctx.ui.setWorkingMessage('Analyzing task...')
		try {
			const analysis = await analyzeTaskDescription({
				taskDescription,
				model: ctx.model,
				detectedExtensions,
				agents,
			})

			interviewCtx.answers['task_type'] = analysis.task_type
			interviewCtx.answers['affected_areas'] = analysis.affected_areas
			interviewCtx.answers['scope_size'] = analysis.scope_size
			interviewCtx.answers['needs_devops'] = analysis.needs_devops
			interviewCtx.answers['needs_architect'] = analysis.needs_architect
			interviewCtx.answers['parallel_safe'] = analysis.parallel_safe
		} catch {
			// Fallback: set reasonable defaults
			interviewCtx.answers['task_type'] = 'feature'
			interviewCtx.answers['affected_areas'] = 'src/**'
			interviewCtx.answers['scope_size'] = 'medium'
			interviewCtx.answers['needs_devops'] = false
			interviewCtx.answers['needs_architect'] = false
			interviewCtx.answers['parallel_safe'] = true
		}
		ctx.ui.setWorkingMessage('')
	} else {
		// No model or no description — set defaults
		interviewCtx.answers['task_type'] = 'feature'
		interviewCtx.answers['affected_areas'] = 'src/**'
		interviewCtx.answers['scope_size'] = 'medium'
		interviewCtx.answers['needs_devops'] = false
		interviewCtx.answers['needs_architect'] = false
		interviewCtx.answers['parallel_safe'] = true
	}

	// Step 3: Hard-code always-yes answers
	interviewCtx.answers['needs_qa'] = true
	interviewCtx.answers['needs_review'] = true
	interviewCtx.answers['has_tests'] = true

	// Step 4: Ask remaining interactive questions
	while (true) {
		const applicable = getApplicableQuestions(interviewCtx)
		const next = applicable.find((q) => !asked.has(q.id))
		if (!next) break

		asked.add(next.id)
		const answer = await askQuestion(ctx, next, interviewCtx)

		// undefined from select/input means the user cancelled
		if (answer === undefined && next.kind !== 'confirm') {
			await emitAbort(eventLog)
			return { cancelled: true, answers: interviewCtx.answers }
		}

		interviewCtx.answers[next.id] = answer
	}

	// Emit interview_complete event
	await eventLog.append(
		createFleetEvent<InterviewCompleteEvent>({
			type: 'interview_complete',
			answers: interviewCtx.answers,
		})
	)

	return { cancelled: false, answers: interviewCtx.answers }
}

async function emitAbort(eventLog: EventLogWriter): Promise<void> {
	await eventLog.append(
		createFleetEvent<import('../session/events.js').SessionAbortedEvent>({
			type: 'session_aborted',
			reason: 'User cancelled interview',
		})
	)
}

/**
 * Ask a single question using the appropriate pi UI method.
 */
async function askQuestion(
	ctx: ExtensionCommandContext,
	question: InterviewQuestion,
	interviewCtx: InterviewContext
): Promise<unknown> {
	switch (question.kind) {
		case 'input':
			return ctx.ui.input(question.prompt)

		case 'select': {
			const options = question.options?.(interviewCtx) ?? []
			return ctx.ui.select(
				question.prompt,
				options.map((o) => o.label)
			)
		}

		case 'confirm':
			return ctx.ui.confirm('pi-fleet', question.prompt)
	}
}
