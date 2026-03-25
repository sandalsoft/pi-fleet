import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { handleFleetLogs } from '../../src/status/fleet-logs.js'
import { setFleetState, setLogDir, clearFleetState } from '../../src/session/runtime-store.js'
import { emptyFleetState } from '../../src/session/state.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'

function mockPi(): ExtensionAPI {
	return {
		exec: vi.fn(async () => ({ stdout: '/tmp/test-repo', stderr: '', code: 0 })),
	} as unknown as ExtensionAPI
}

function mockCtx(): ExtensionCommandContext & { notifications: Array<{ msg: string; level: string }> } {
	const notifications: Array<{ msg: string; level: string }> = []
	return {
		notifications,
		ui: {
			notify: (msg: string, level: string) => notifications.push({ msg, level }),
			setWidget: vi.fn(),
			setStatus: vi.fn(),
			input: vi.fn(),
		},
		model: {} as any,
		hasUI: true,
		sessionManager: { getEntries: () => [] },
	} as any
}

describe('handleFleetLogs', () => {
	let tmpDir: string
	let logsDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-logs-test-'))
		logsDir = path.join(tmpDir, '.pi', 'logs')
		await fs.mkdir(logsDir, { recursive: true })

		// Set fleet state so repoRoot is resolved
		const state = emptyFleetState()
		state.repoRoot = tmpDir
		setFleetState(state)
	})

	afterEach(async () => {
		clearFleetState()
		try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch {}
	})

	it('shows message when no sessions exist', async () => {
		const pi = mockPi()
		const ctx = mockCtx()
		await handleFleetLogs('', { pi, ctx })
		expect(ctx.notifications[0].msg).toContain('No log sessions')
	})

	it('lists sessions when no agent argument given', async () => {
		// Create two session dirs
		const sid1 = 'abc123'
		const sid2 = 'def456'
		await fs.mkdir(path.join(logsDir, sid1), { recursive: true })
		await fs.mkdir(path.join(logsDir, sid2), { recursive: true })
		await fs.writeFile(path.join(logsDir, sid1, 'developer.jsonl'), '', 'utf-8')
		await fs.writeFile(path.join(logsDir, sid2, 'reviewer.jsonl'), '', 'utf-8')

		// Write meta for sid1 as completed
		await fs.writeFile(
			path.join(logsDir, sid1, 'developer.meta.json'),
			JSON.stringify({ agentName: 'developer', status: 'completed', startedAt: '2026-01-01', model: 'test', worktreePath: '/tmp' }),
			'utf-8',
		)

		const pi = mockPi()
		const ctx = mockCtx()
		await handleFleetLogs('', { pi, ctx })

		const msg = ctx.notifications[0].msg
		expect(msg).toContain('Fleet Log Sessions')
		expect(msg).toContain('developer')
		expect(msg).toContain('reviewer')
	})

	it('shows agent log details when agent name is given', async () => {
		const sid = 'aaa111'
		const sessionDir = path.join(logsDir, sid)
		await fs.mkdir(sessionDir, { recursive: true })

		// Create meta
		await fs.writeFile(
			path.join(sessionDir, 'developer.meta.json'),
			JSON.stringify({
				agentName: 'developer',
				status: 'completed',
				startedAt: '2026-01-01T00:00:00Z',
				completedAt: '2026-01-01T00:01:00Z',
				model: 'sonnet',
				worktreePath: '/tmp/wt',
				durationMs: 60000,
				exitCode: 0,
				usage: { inputTokens: 5000, outputTokens: 2000 },
			}),
			'utf-8',
		)

		// Create JSONL with activity lines
		const jsonlLines = [
			JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: '/src/main.ts' } }),
			JSON.stringify({ type: 'tool_use', name: 'Edit', input: { file_path: '/src/main.ts' } }),
		]
		await fs.writeFile(path.join(sessionDir, 'developer.jsonl'), jsonlLines.join('\n') + '\n', 'utf-8')

		// Create stderr
		await fs.writeFile(path.join(sessionDir, 'developer.stderr.log'), '', 'utf-8')

		const pi = mockPi()
		const ctx = mockCtx()
		await handleFleetLogs('developer', { pi, ctx })

		const msg = ctx.notifications[0].msg
		expect(msg).toContain('Agent: developer')
		expect(msg).toContain('Status: completed')
		expect(msg).toContain('Model: sonnet')
		expect(msg).toContain('Duration: 60.0s')
		expect(msg).toContain('Tokens: 5000 in / 2000 out')
		expect(msg).toContain('Log:')
	})

	it('shows raw JSONL when --raw is passed', async () => {
		const sid = 'bbb222'
		const sessionDir = path.join(logsDir, sid)
		await fs.mkdir(sessionDir, { recursive: true })

		const line = JSON.stringify({ type: 'tool_use', name: 'Read', input: {} })
		await fs.writeFile(path.join(sessionDir, 'developer.jsonl'), line + '\n', 'utf-8')

		const pi = mockPi()
		const ctx = mockCtx()
		await handleFleetLogs('developer --raw', { pi, ctx })

		const msg = ctx.notifications[0].msg
		expect(msg).toContain('raw JSONL')
		expect(msg).toContain('"type":"tool_use"')
	})

	it('reports when agent not found', async () => {
		const pi = mockPi()
		const ctx = mockCtx()
		await handleFleetLogs('nonexistent', { pi, ctx })

		expect(ctx.notifications[0].msg).toContain('No logs found')
		expect(ctx.notifications[0].level).toBe('warning')
	})

	it('marks stale running sessions as interrupted', async () => {
		const sid = 'ccc333'
		const sessionDir = path.join(logsDir, sid)
		await fs.mkdir(sessionDir, { recursive: true })

		// Meta with status 'running' but session is not the active one
		await fs.writeFile(
			path.join(sessionDir, 'developer.meta.json'),
			JSON.stringify({ agentName: 'developer', status: 'running', startedAt: '2026-01-01', model: 'test', worktreePath: '/tmp' }),
			'utf-8',
		)
		await fs.writeFile(path.join(sessionDir, 'developer.jsonl'), '', 'utf-8')

		const pi = mockPi()
		const ctx = mockCtx()
		await handleFleetLogs('', { pi, ctx })

		const msg = ctx.notifications[0].msg
		expect(msg).toContain('interrupted')
	})

	it('marks current session as active', async () => {
		const sid = 'ddd444'
		const sessionDir = path.join(logsDir, sid)
		await fs.mkdir(sessionDir, { recursive: true })

		// Set logDir to this session and phase to executing
		setLogDir(sessionDir)
		const state = emptyFleetState()
		state.repoRoot = tmpDir
		state.phase = 'executing'
		setFleetState(state)

		await fs.writeFile(
			path.join(sessionDir, 'developer.meta.json'),
			JSON.stringify({ agentName: 'developer', status: 'running', startedAt: '2026-01-01', model: 'test', worktreePath: '/tmp' }),
			'utf-8',
		)
		await fs.writeFile(path.join(sessionDir, 'developer.jsonl'), '', 'utf-8')

		const pi = mockPi()
		const ctx = mockCtx()
		await handleFleetLogs('', { pi, ctx })

		const msg = ctx.notifications[0].msg
		expect(msg).toContain('active')
	})
})
