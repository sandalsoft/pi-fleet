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
 * Asks 8-12 adaptive questions, collecting answers into a keyed record.
 * If the user cancels any question (select/input returns undefined), the
 * interview is aborted and a session_aborted event is emitted.
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

	// Re-evaluate applicable questions after each answer, asking new ones
	// that become relevant as context accumulates.
	while (true) {
		const applicable = getApplicableQuestions(interviewCtx)
		const next = applicable.find((q) => !asked.has(q.id))
		if (!next) break

		asked.add(next.id)
		const answer = await askQuestion(ctx, next, interviewCtx)

		// undefined from select/input means the user cancelled
		if (answer === undefined && next.kind !== 'confirm') {
			await eventLog.append(
				createFleetEvent<import('../session/events.js').SessionAbortedEvent>({
					type: 'session_aborted',
					reason: 'User cancelled interview',
				})
			)
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
				options.map((o) => o.value),
				options.map((o) => o.label)
			)
		}

		case 'confirm':
			return ctx.ui.confirm(question.prompt)
	}
}
