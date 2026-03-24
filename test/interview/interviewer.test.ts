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
	return { ctx: { ui } as unknown as ExtensionCommandContext, ui }
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

	it('collects answers from a full interview run', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		// Set up UI responses in order:
		// 1. task_description (input)
		ui.input.mockResolvedValueOnce('Build a REST API')
		// 2. task_type (select)
		ui.select.mockResolvedValueOnce('feature')
		// 3. task_details (input)
		ui.input.mockResolvedValueOnce('Must support pagination')
		// 4. affected_areas (input)
		ui.input.mockResolvedValueOnce('src/api, src/models')
		// 5. scope_size (select)
		ui.select.mockResolvedValueOnce('large')
		// 6. has_tests (confirm)
		ui.confirm.mockResolvedValueOnce(true)
		// 7. needs_architect (confirm) - triggers for large scope with architect agent
		ui.confirm.mockResolvedValueOnce(true)
		// 8. needs_review (confirm)
		ui.confirm.mockResolvedValueOnce(true)
		// 9. needs_devops (confirm) - task_type is feature, not devops, so this triggers
		ui.confirm.mockResolvedValueOnce(false)
		// 10. needs_qa (confirm) - has_tests is true and qa agent exists
		ui.confirm.mockResolvedValueOnce(true)
		// 11. priority (select)
		ui.select.mockResolvedValueOnce('balanced')
		// 12. parallel_safe (confirm) - triggers for large scope
		ui.confirm.mockResolvedValueOnce(true)

		const result = await runInterview({
			pi: makeMockPi(),
			ctx,
			agents: defaultAgents,
			repoRoot: tmpDir,
			eventLog,
		})

		expect(result.cancelled).toBe(false)
		expect(result.answers['task_description']).toBe('Build a REST API')
		expect(result.answers['task_type']).toBe('feature')
		expect(result.answers['scope_size']).toBe('large')
		expect(result.answers['has_tests']).toBe(true)
		expect(result.answers['needs_architect']).toBe(true)

		// Should have emitted interview_complete event
		const completeEvent = eventLog.events.find(
			(e: any) => e.type === 'interview_complete'
		) as any
		expect(completeEvent).toBeDefined()
		expect(completeEvent.answers['task_description']).toBe('Build a REST API')
	})

	it('asks between 8 and 12 questions with a full agent roster', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		let questionCount = 0

		ui.input.mockImplementation(async () => {
			questionCount++
			return 'some answer'
		})
		ui.select.mockImplementation(async () => {
			questionCount++
			return 'medium'
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

		expect(questionCount).toBeGreaterThanOrEqual(8)
		expect(questionCount).toBeLessThanOrEqual(12)
	})

	it('handles cancellation when input returns undefined', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		// First question (input) returns undefined = cancelled
		ui.input.mockResolvedValueOnce(undefined)

		const result = await runInterview({
			pi: makeMockPi(),
			ctx,
			agents: defaultAgents,
			repoRoot: tmpDir,
			eventLog,
		})

		expect(result.cancelled).toBe(true)

		// Should have emitted session_aborted event
		const abortEvent = eventLog.events.find(
			(e: any) => e.type === 'session_aborted'
		) as any
		expect(abortEvent).toBeDefined()
		expect(abortEvent.reason).toBe('User cancelled interview')
	})

	it('handles cancellation when select returns undefined', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		// First question is input, second is select
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

	it('adapts questions based on available agents', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		// Only a developer agent (no architect, reviewer, qa, devops)
		const minimalAgents = [makeAgent('developer')]
		let questionCount = 0

		ui.input.mockImplementation(async () => {
			questionCount++
			return 'some answer'
		})
		ui.select.mockImplementation(async () => {
			questionCount++
			return 'small'
		})
		ui.confirm.mockImplementation(async () => {
			questionCount++
			return false
		})

		const result = await runInterview({
			pi: makeMockPi(),
			ctx,
			agents: minimalAgents,
			repoRoot: tmpDir,
			eventLog,
		})

		expect(result.cancelled).toBe(false)
		// With minimal agents and small scope, fewer conditional questions trigger
		expect(questionCount).toBeLessThan(12)
	})

	it('does not ask architect question for small scope', async () => {
		const { ctx, ui } = makeMockCtx()
		const eventLog = makeMockEventLog()

		// Manually control the flow
		ui.input.mockImplementation(async () => 'answer')
		// Return 'small' for scope_size to skip needs_architect
		ui.select.mockImplementation(async (_prompt: string) => 'small')
		ui.confirm.mockImplementation(async () => false)

		const result = await runInterview({
			pi: makeMockPi(),
			ctx,
			agents: defaultAgents,
			repoRoot: tmpDir,
			eventLog,
		})

		expect(result.cancelled).toBe(false)

		// needs_architect should not appear (it requires medium/large scope)
		expect(result.answers['needs_architect']).toBeUndefined()
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
