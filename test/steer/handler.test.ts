import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
	parseSteerArgs,
	resolveTargets,
	handleSteer,
	type SteerContext,
	type SteerOpts,
} from '../../src/steer/handler.js'
import { emptyFleetState, type FleetState } from '../../src/session/state.js'

function mockCtx(): SteerContext {
	return {
		ui: {
			notify: vi.fn(),
		},
	}
}

function runningState(): FleetState {
	const state = emptyFleetState()
	state.phase = 'executing'
	state.members = ['developer', 'reviewer', 'architect']
	state.specialists.set('developer', {
		agentName: 'developer',
		runId: 'run-001',
		pid: 1234,
		worktreePath: '/tmp/wt/developer',
		model: 'claude-sonnet-4-20250514',
		status: 'running',
		startedAt: null,
		completedAt: null,
		turnCount: 0,
	})
	state.specialists.set('reviewer', {
		agentName: 'reviewer',
		runId: 'run-002',
		pid: 1235,
		worktreePath: '/tmp/wt/reviewer',
		model: 'claude-sonnet-4-20250514',
		status: 'running',
		startedAt: null,
		completedAt: null,
		turnCount: 0,
	})
	state.specialists.set('architect', {
		agentName: 'architect',
		runId: 'run-003',
		pid: 1236,
		worktreePath: '/tmp/wt/architect',
		model: 'claude-opus-4-20250514',
		status: 'completed',
		startedAt: null,
		completedAt: null,
		turnCount: 2,
	})
	return state
}

describe('parseSteerArgs', () => {
	it('parses agent name and message', () => {
		const result = parseSteerArgs('developer fix the API endpoint')
		expect(result).toEqual({
			agentName: 'developer',
			message: 'fix the API endpoint',
		})
	})

	it('returns null for empty input', () => {
		expect(parseSteerArgs('')).toBeNull()
		expect(parseSteerArgs('   ')).toBeNull()
	})

	it('returns null for name only (no message)', () => {
		expect(parseSteerArgs('developer')).toBeNull()
	})

	it('returns null for name + empty message', () => {
		expect(parseSteerArgs('developer   ')).toBeNull()
	})

	it('preserves whitespace in message body', () => {
		const result = parseSteerArgs('all  focus on  performance')
		expect(result).toEqual({
			agentName: 'all',
			message: 'focus on  performance',
		})
	})
})

describe('resolveTargets', () => {
	it('resolves a specific running agent', () => {
		const state = runningState()
		const { targets, error } = resolveTargets('developer', state)
		expect(error).toBeNull()
		expect(targets).toHaveLength(1)
		expect(targets[0].agentName).toBe('developer')
	})

	it('returns error for nonexistent agent', () => {
		const state = runningState()
		const { targets, error } = resolveTargets('nonexistent', state)
		expect(targets).toHaveLength(0)
		expect(error).toContain('not found')
		expect(error).toContain('developer')
	})

	it('returns error for completed agent', () => {
		const state = runningState()
		const { targets, error } = resolveTargets('architect', state)
		expect(targets).toHaveLength(0)
		expect(error).toContain('already completed')
	})

	it('"all" resolves to all running agents', () => {
		const state = runningState()
		const { targets, error } = resolveTargets('all', state)
		expect(error).toBeNull()
		expect(targets).toHaveLength(2)
		expect(targets.map((t) => t.agentName).sort()).toEqual(['developer', 'reviewer'])
	})

	it('"all" returns error when no agents are running', () => {
		const state = emptyFleetState()
		const { targets, error } = resolveTargets('all', state)
		expect(targets).toHaveLength(0)
		expect(error).toContain('No agents are currently running')
	})

	it('"dispatcher" resolves to a synthetic dispatcher target', () => {
		const state = runningState()
		const { targets, error } = resolveTargets('dispatcher', state)
		expect(error).toBeNull()
		expect(targets).toHaveLength(1)
		expect(targets[0].agentName).toBe('dispatcher')
	})
})

describe('handleSteer', () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'steer-test-'))
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	function baseOpts(overrides: Partial<SteerOpts> = {}): SteerOpts {
		return {
			repoRoot: tmpDir,
			state: runningState(),
			ctx: mockCtx(),
			source: 'user',
			...overrides,
		}
	}

	it('writes steer to scratchpad with standardized format', async () => {
		const result = await handleSteer('developer refactor the auth module', baseOpts())

		expect(result.delivered).toBe(true)
		expect(result.targets).toEqual(['developer'])
		expect(result.method).toBe('scratchpad')

		const scratchpadPath = path.join(tmpDir, '.pi', 'scratchpads', 'developer.md')
		const content = await fs.readFile(scratchpadPath, 'utf-8')
		expect(content).toContain('[STEER')
		expect(content).toContain('from=user]')
		expect(content).toContain('refactor the auth module')
		expect(content).toContain('---')
	})

	it('multiple rapid steers produce parseable ordered content', async () => {
		const opts = baseOpts()

		await handleSteer('developer first message', opts)
		await handleSteer('developer second message', opts)
		await handleSteer('developer third message', opts)

		const scratchpadPath = path.join(tmpDir, '.pi', 'scratchpads', 'developer.md')
		const content = await fs.readFile(scratchpadPath, 'utf-8')

		// Each steer is separated by ---
		const entries = content.split('---').filter((s) => s.trim())
		expect(entries).toHaveLength(3)

		// Verify order: first, second, third
		expect(entries[0]).toContain('first message')
		expect(entries[1]).toContain('second message')
		expect(entries[2]).toContain('third message')

		// Each has a STEER header with timestamp
		for (const entry of entries) {
			expect(entry).toMatch(/\[STEER \d{4}-\d{2}-\d{2}T/)
		}
	})

	it('"all" broadcasts to all running agents', async () => {
		const result = await handleSteer('all focus on tests', baseOpts())

		expect(result.delivered).toBe(true)
		expect(result.targets.sort()).toEqual(['developer', 'reviewer'])

		// Both scratchpads should exist
		for (const name of ['developer', 'reviewer']) {
			const content = await fs.readFile(
				path.join(tmpDir, '.pi', 'scratchpads', `${name}.md`),
				'utf-8'
			)
			expect(content).toContain('focus on tests')
		}
	})

	it('rejects path traversal in agent name', async () => {
		const ctx = mockCtx()
		const result = await handleSteer('../etc/passwd attack', baseOpts({ ctx }))

		expect(result.delivered).toBe(false)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('Invalid agent name'),
			'error'
		)
	})

	it('rejects names with slashes', async () => {
		const ctx = mockCtx()
		const result = await handleSteer('foo/bar message', baseOpts({ ctx }))

		expect(result.delivered).toBe(false)
		expect(result.errors).toHaveLength(1)
	})

	it('notifies when agent is finished', async () => {
		const ctx = mockCtx()
		const result = await handleSteer('architect do something', baseOpts({ ctx }))

		expect(result.delivered).toBe(false)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('already completed'),
			'warning'
		)
	})

	it('notifies when agent does not exist', async () => {
		const ctx = mockCtx()
		const result = await handleSteer('ghost do something', baseOpts({ ctx }))

		expect(result.delivered).toBe(false)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('not found'),
			'warning'
		)
	})

	it('returns usage error for missing message', async () => {
		const ctx = mockCtx()
		const result = await handleSteer('developer', baseOpts({ ctx }))

		expect(result.delivered).toBe(false)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining('Usage'),
			'warning'
		)
	})

	it('uses sendMessage when hostRoutableId is available', async () => {
		const state = runningState()
		state.specialists.set('developer', {
			...state.specialists.get('developer')!,
			hostRoutableId: 'host-routable-123',
		})

		const sendMessage = vi.fn().mockResolvedValue(undefined)
		const result = await handleSteer('developer use the new API', baseOpts({ state, sendMessage }))

		expect(result.delivered).toBe(true)
		expect(result.method).toBe('sendMessage')
		expect(sendMessage).toHaveBeenCalledWith({
			to: 'host-routable-123',
			content: 'use the new API',
			deliverAs: 'steer',
		})
	})

	it('falls back to scratchpad when sendMessage fails', async () => {
		const state = runningState()
		state.specialists.set('developer', {
			...state.specialists.get('developer')!,
			hostRoutableId: 'host-routable-123',
		})

		const sendMessage = vi.fn().mockRejectedValue(new Error('delivery failed'))
		const result = await handleSteer('developer use the old API', baseOpts({ state, sendMessage }))

		expect(result.delivered).toBe(true)
		expect(result.method).toBe('scratchpad')

		const content = await fs.readFile(
			path.join(tmpDir, '.pi', 'scratchpads', 'developer.md'),
			'utf-8'
		)
		expect(content).toContain('use the old API')
	})

	it('reports mixed method when some use sendMessage and others use scratchpad', async () => {
		const state = runningState()
		state.specialists.set('developer', {
			...state.specialists.get('developer')!,
			hostRoutableId: 'host-routable-123',
		})
		// reviewer has no hostRoutableId, so it goes to scratchpad

		const sendMessage = vi.fn().mockResolvedValue(undefined)
		const result = await handleSteer('all update status', baseOpts({ state, sendMessage }))

		expect(result.delivered).toBe(true)
		expect(result.method).toBe('mixed')
		expect(result.targets.sort()).toEqual(['developer', 'reviewer'])
	})
})
