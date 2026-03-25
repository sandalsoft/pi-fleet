import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runInterview, detectProjectExtensions } from '../../src/interview/interviewer.js'
import type { AgentDefinition } from '../../src/config/schema.js'
import type { EventLogWriter } from '../../src/session/event-log.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// --- Helpers ---

function makeAgent(id: string, expertise?: string): AgentDefinition {
	return {
		id,
		frontmatter: { name: id.charAt(0).toUpperCase() + id.slice(1), model: 'sonnet', expertise },
		body: `You are a ${id}.`,
	}
}

const defaultAgents: AgentDefinition[] = [
	makeAgent('architect', 'system design and architecture'),
	makeAgent('developer', 'implementation and coding'),
	makeAgent('reviewer', 'code review and quality'),
	makeAgent('qa', 'testing and validation'),
	makeAgent('devops', 'infrastructure and deployment'),
	makeAgent('researcher', 'research and analysis'),
]

interface MockUI {
	input: ReturnType<typeof vi.fn>
	select: ReturnType<typeof vi.fn>
	confirm: ReturnType<typeof vi.fn>
	notify: ReturnType<typeof vi.fn>
	setStatus: ReturnType<typeof vi.fn>
	setWidget: ReturnType<typeof vi.fn>
	setWorkingMessage: ReturnType<typeof vi.fn>
}

function makeMockCtx(): { ctx: ExtensionCommandContext; ui: MockUI } {
	const ui: MockUI = {
		input: vi.fn(),
		select: vi.fn(),
		confirm: vi.fn(),
		notify: vi.fn(),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
		setWorkingMessage: vi.fn(),
	}
	// ctx.model is undefined — analyzer will use fallback defaults
	return { ctx: { ui, model: undefined } as unknown as ExtensionCommandContext, ui }
}

function makeMockEventLog(): EventLogWriter & { events: unknown[] } {
	const events: unknown[] = []
	return {
		events,
		async append(event: unknown) {
			events.push(event)
		},
	}
}

function makeMockPi(): ExtensionAPI {
	return {} as unknown as ExtensionAPI
}

describe('runInterview', () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-interview-'))
	})

	it('collects answers with only 2 interactive questions (no model)', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		// Only 2 interactive questions:
		// 1. task_description (input)
		ui.input.mockResolvedValueOnce('Build a REST API')
		// 2. priority_speed_or_quality (select)
		ui.select.mockResolvedValueOnce('balanced')

		const result = await runInterview({
			pi: makeMockPi(),
			ctx,
			agents: defaultAgents,
			repoRoot: tmpDir,
			eventLog,
		})

		expect(result.cancelled).toBe(false)
		expect(result.answers['task_description']).toBe('Build a REST API')
		// LLM-inferred defaults (no model → fallback)
		expect(result.answers['task_type']).toBe('feature')
		expect(result.answers['affected_areas']).toBe('src/**')
		expect(result.answers['scope_size']).toBe('medium')
		expect(result.answers['needs_architect']).toBe(false)
		expect(result.answers['parallel_safe']).toBe(true)
		// Hard-coded always-yes
		expect(result.answers['needs_qa']).toBe(true)
		expect(result.answers['needs_review']).toBe(true)
		expect(result.answers['has_tests']).toBe(true)
		// Interactive
		expect(result.answers['priority_speed_or_quality']).toBe('balanced')

		// Should have emitted interview_complete event
		const completeEvent = eventLog.events.find(
			(e: any) => e.type === 'interview_complete'
		) as any
		expect(completeEvent).toBeDefined()
	})

	it('asks exactly 2 interactive questions', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		let questionCount = 0

		ui.input.mockImplementation(async () => {
			questionCount++
			return 'some answer'
		})
		ui.select.mockImplementation(async () => {
			questionCount++
			return 'balanced'
		})
		ui.confirm.mockImplementation(async () => {
			questionCount++
			return true
		})

		await runInterview({
			pi: makeMockPi(),
			ctx,
			agents: defaultAgents,
			repoRoot: tmpDir,
			eventLog,
		})

		// task_description (input) + priority (select) = 2
		expect(questionCount).toBe(2)
	})

	it('handles cancellation when input returns undefined', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		ui.input.mockResolvedValueOnce(undefined)

		const result = await runInterview({
			pi: makeMockPi(),
			ctx,
			agents: defaultAgents,
			repoRoot: tmpDir,
			eventLog,
		})

		expect(result.cancelled).toBe(true)

		const abortEvent = eventLog.events.find(
			(e: any) => e.type === 'session_aborted'
		) as any
		expect(abortEvent).toBeDefined()
	})

	it('handles cancellation when select returns undefined', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		ui.input.mockResolvedValueOnce('Build something')
		ui.select.mockResolvedValueOnce(undefined)

		const result = await runInterview({
			pi: makeMockPi(),
			ctx,
			agents: defaultAgents,
			repoRoot: tmpDir,
			eventLog,
		})

		expect(result.cancelled).toBe(true)
	})

	it('always sets has_tests, needs_qa, and needs_review to true', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		ui.input.mockResolvedValueOnce('Do a thing')
		ui.select.mockResolvedValue('speed')

		const result = await runInterview({
			pi: makeMockPi(),
			ctx,
			agents: defaultAgents,
			repoRoot: tmpDir,
			eventLog,
		})

		expect(result.cancelled).toBe(false)
		expect(result.answers['has_tests']).toBe(true)
		expect(result.answers['needs_qa']).toBe(true)
		expect(result.answers['needs_review']).toBe(true)
	})
})

describe('detectProjectExtensions', () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-detect-'))
	})

	it('detects file extensions in project root', async () => {
		await fs.writeFile(path.join(tmpDir, 'index.ts'), '')
		await fs.writeFile(path.join(tmpDir, 'package.json'), '')
		await fs.writeFile(path.join(tmpDir, 'README.md'), '')

		const extensions = await detectProjectExtensions(tmpDir)

		expect(extensions).toContain('.ts')
		expect(extensions).toContain('.json')
		expect(extensions).toContain('.md')
	})

	it('detects extensions in src/ subdirectory', async () => {
		const srcDir = path.join(tmpDir, 'src')
		await fs.mkdir(srcDir)
		await fs.writeFile(path.join(srcDir, 'main.go'), '')

		const extensions = await detectProjectExtensions(tmpDir)

		expect(extensions).toContain('.go')
	})

	it('returns empty array for empty directory', async () => {
		const extensions = await detectProjectExtensions(tmpDir)
		expect(extensions).toEqual([])
	})

	it('returns sorted, deduplicated extensions', async () => {
		await fs.writeFile(path.join(tmpDir, 'a.ts'), '')
		await fs.writeFile(path.join(tmpDir, 'b.ts'), '')
		await fs.writeFile(path.join(tmpDir, 'c.py'), '')

		const extensions = await detectProjectExtensions(tmpDir)

		expect(extensions).toEqual(['.py', '.ts'])
	})
})
