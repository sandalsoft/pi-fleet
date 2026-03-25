import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { AgentLogger, rotateSessionLogs, tailLines, KEEP_LOG_SESSIONS } from '../../src/dispatch/agent-logger.js'

let tmpDir: string

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-logger-test-'))
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentLogger', () => {
	it('create() returns AgentLogger on valid inputs', async () => {
		const logDir = path.join(tmpDir, 'session1')
		const logger = await AgentLogger.create({
			logDir,
			agentName: 'developer',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})

		expect(logger).not.toBeNull()
		expect(logger!.agentName).toBe('developer')

		// Meta file written with status: running
		const meta = JSON.parse(await fs.readFile(path.join(logDir, 'developer.meta.json'), 'utf-8'))
		expect(meta.status).toBe('running')
		expect(meta.agentName).toBe('developer')
		expect(meta.model).toBe('claude-sonnet')
		expect(meta.startedAt).toBeTruthy()

		// Empty stderr.log exists
		const stderr = await fs.readFile(path.join(logDir, 'developer.stderr.log'), 'utf-8')
		expect(stderr).toBe('')

		// JSONL file exists (empty initially)
		const jsonl = await fs.readFile(path.join(logDir, 'developer.jsonl'), 'utf-8')
		expect(jsonl).toBe('')

		await logger!.close()
	})

	it('create() returns null for invalid agent name', async () => {
		const logDir = path.join(tmpDir, 'session2')

		const result1 = await AgentLogger.create({
			logDir,
			agentName: '../traversal',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})
		expect(result1).toBeNull()

		const result2 = await AgentLogger.create({
			logDir,
			agentName: '',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})
		expect(result2).toBeNull()

		const result3 = await AgentLogger.create({
			logDir,
			agentName: 'a'.repeat(129),
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})
		expect(result3).toBeNull()

		const result4 = await AgentLogger.create({
			logDir,
			agentName: 'agent with spaces',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})
		expect(result4).toBeNull()
	})

	it('create() accepts valid agent names with hyphens and underscores', async () => {
		const logDir = path.join(tmpDir, 'session3')

		const logger = await AgentLogger.create({
			logDir,
			agentName: 'my-agent_01',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})
		expect(logger).not.toBeNull()
		await logger!.close()
	})

	it('appendLine() writes to JSONL file', async () => {
		const logDir = path.join(tmpDir, 'session4')
		const logger = await AgentLogger.create({
			logDir,
			agentName: 'dev',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})

		logger!.appendLine('{"type":"result","text":"hello"}')
		logger!.appendLine('{"type":"result","text":"world"}')

		await logger!.close()

		const content = await fs.readFile(path.join(logDir, 'dev.jsonl'), 'utf-8')
		const lines = content.trim().split('\n')
		expect(lines).toHaveLength(2)
		expect(lines[0]).toBe('{"type":"result","text":"hello"}')
		expect(lines[1]).toBe('{"type":"result","text":"world"}')
	})

	it('appendLine() is a no-op after close', async () => {
		const logDir = path.join(tmpDir, 'session5')
		const logger = await AgentLogger.create({
			logDir,
			agentName: 'dev',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})

		logger!.appendLine('{"line":1}')
		await logger!.close()

		// This should not throw or write
		logger!.appendLine('{"line":2}')

		const content = await fs.readFile(path.join(logDir, 'dev.jsonl'), 'utf-8')
		expect(content.trim().split('\n')).toHaveLength(1)
	})

	it('writeStderr() overwrites stderr.log', async () => {
		const logDir = path.join(tmpDir, 'session6')
		const logger = await AgentLogger.create({
			logDir,
			agentName: 'dev',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})

		await logger!.writeStderr('Error: something went wrong\nStack trace...')

		const content = await fs.readFile(path.join(logDir, 'dev.stderr.log'), 'utf-8')
		expect(content).toBe('Error: something went wrong\nStack trace...')

		await logger!.close()
	})

	it('close() computes durationMs and writes final meta', async () => {
		const logDir = path.join(tmpDir, 'session7')
		const logger = await AgentLogger.create({
			logDir,
			agentName: 'dev',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})

		// Small delay so durationMs > 0
		await new Promise((r) => setTimeout(r, 10))

		await logger!.close({
			exitCode: 0,
			usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 },
		})

		const meta = JSON.parse(await fs.readFile(path.join(logDir, 'dev.meta.json'), 'utf-8'))
		expect(meta.status).toBe('completed')
		expect(meta.exitCode).toBe(0)
		expect(meta.durationMs).toBeGreaterThan(0)
		expect(meta.completedAt).toBeTruthy()
		expect(meta.usage.inputTokens).toBe(100)
	})

	it('close() defaults to failed when exitCode is non-zero', async () => {
		const logDir = path.join(tmpDir, 'session8')
		const logger = await AgentLogger.create({
			logDir,
			agentName: 'dev',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})

		await logger!.close({ exitCode: 1 })

		const meta = JSON.parse(await fs.readFile(path.join(logDir, 'dev.meta.json'), 'utf-8'))
		expect(meta.status).toBe('failed')
		expect(meta.exitCode).toBe(1)
	})

	it('close() with explicit status override', async () => {
		const logDir = path.join(tmpDir, 'session9')
		const logger = await AgentLogger.create({
			logDir,
			agentName: 'dev',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})

		await logger!.close({ status: 'aborted' })

		const meta = JSON.parse(await fs.readFile(path.join(logDir, 'dev.meta.json'), 'utf-8'))
		expect(meta.status).toBe('aborted')
	})

	it('close() is idempotent', async () => {
		const logDir = path.join(tmpDir, 'session10')
		const logger = await AgentLogger.create({
			logDir,
			agentName: 'dev',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})

		await logger!.close({ exitCode: 0, status: 'completed' })

		// Read meta after first close
		const meta1 = await fs.readFile(path.join(logDir, 'dev.meta.json'), 'utf-8')

		// Second close should be a no-op
		await logger!.close({ exitCode: 1, status: 'failed' })

		const meta2 = await fs.readFile(path.join(logDir, 'dev.meta.json'), 'utf-8')
		expect(meta2).toBe(meta1)
	})

	it('close() defaults to failed when no opts given', async () => {
		const logDir = path.join(tmpDir, 'session11')
		const logger = await AgentLogger.create({
			logDir,
			agentName: 'dev',
			model: 'claude-sonnet',
			worktreePath: '/tmp/wt',
		})

		await logger!.close()

		const meta = JSON.parse(await fs.readFile(path.join(logDir, 'dev.meta.json'), 'utf-8'))
		// No exitCode provided, undefined !== 0, so defaults to 'failed'
		expect(meta.status).toBe('failed')
	})
})

describe('KEEP_LOG_SESSIONS', () => {
	it('equals 5', () => {
		expect(KEEP_LOG_SESSIONS).toBe(5)
	})
})

describe('rotateSessionLogs', () => {
	it('removes oldest sessions beyond keepCount', async () => {
		const logsRoot = path.join(tmpDir, 'logs')
		await fs.mkdir(logsRoot, { recursive: true })

		// Create 7 session dirs with base36 timestamps (ascending)
		const sessions = [100, 200, 300, 400, 500, 600, 700].map((n) => n.toString(36))
		for (const s of sessions) {
			await fs.mkdir(path.join(logsRoot, s))
			await fs.writeFile(path.join(logsRoot, s, 'dev.jsonl'), 'test')
		}

		await rotateSessionLogs(logsRoot, 3)

		const remaining = await fs.readdir(logsRoot)
		expect(remaining).toHaveLength(3)

		// The 3 newest should remain (500, 600, 700 in base36)
		const expected = [500, 600, 700].map((n) => n.toString(36))
		expect(remaining.sort()).toEqual(expected.sort())
	})

	it('does nothing when count is within limit', async () => {
		const logsRoot = path.join(tmpDir, 'logs')
		await fs.mkdir(logsRoot, { recursive: true })

		await fs.mkdir(path.join(logsRoot, 'abc'))
		await fs.mkdir(path.join(logsRoot, 'def'))

		await rotateSessionLogs(logsRoot, 5)

		const remaining = await fs.readdir(logsRoot)
		expect(remaining).toHaveLength(2)
	})

	it('ignores non-base36 directory names', async () => {
		const logsRoot = path.join(tmpDir, 'logs')
		await fs.mkdir(logsRoot, { recursive: true })

		// Valid base36 dirs
		await fs.mkdir(path.join(logsRoot, '1'))
		await fs.mkdir(path.join(logsRoot, '2'))
		await fs.mkdir(path.join(logsRoot, '3'))

		// Invalid: contains non-base36 chars
		await fs.mkdir(path.join(logsRoot, '.DS_Store_dir'))
		await fs.writeFile(path.join(logsRoot, 'readme.txt'), 'hi')

		await rotateSessionLogs(logsRoot, 2)

		const remaining = await fs.readdir(logsRoot)
		// '3' and '2' should remain (newest base36), plus .DS_Store_dir and readme.txt
		expect(remaining).toContain('.DS_Store_dir')
		expect(remaining).toContain('readme.txt')
		// Only 1 base36 dir removed ('1')
		expect(remaining).not.toContain('1')
		expect(remaining).toContain('2')
		expect(remaining).toContain('3')
	})

	it('handles non-existent directory gracefully', async () => {
		await expect(
			rotateSessionLogs(path.join(tmpDir, 'nonexistent'), 5)
		).resolves.toBeUndefined()
	})

	it('uses exact base36 regex filter, not parseInt', async () => {
		const logsRoot = path.join(tmpDir, 'logs')
		await fs.mkdir(logsRoot, { recursive: true })

		// "123abc!!" would pass parseInt(_, 36) but fails /^[0-9a-z]+$/i
		await fs.mkdir(path.join(logsRoot, '123abc!!'))
		await fs.mkdir(path.join(logsRoot, 'abc'))

		await rotateSessionLogs(logsRoot, 1)

		const remaining = await fs.readdir(logsRoot)
		// '123abc!!' is invalid base36, should not be touched
		expect(remaining).toContain('123abc!!')
		// 'abc' is valid base36
		expect(remaining).toContain('abc')
	})
})

describe('tailLines', () => {
	it('returns last N lines of a file', async () => {
		const filePath = path.join(tmpDir, 'test.jsonl')
		await fs.writeFile(filePath, 'line1\nline2\nline3\nline4\nline5\n')

		const result = await tailLines(filePath, 3)
		expect(result).toEqual(['line3', 'line4', 'line5'])
	})

	it('returns all lines when n exceeds file length', async () => {
		const filePath = path.join(tmpDir, 'test.jsonl')
		await fs.writeFile(filePath, 'line1\nline2\n')

		const result = await tailLines(filePath, 10)
		expect(result).toEqual(['line1', 'line2'])
	})

	it('returns empty array for n <= 0', async () => {
		const filePath = path.join(tmpDir, 'test.jsonl')
		await fs.writeFile(filePath, 'line1\n')

		expect(await tailLines(filePath, 0)).toEqual([])
		expect(await tailLines(filePath, -1)).toEqual([])
	})

	it('returns empty array for ENOENT', async () => {
		const result = await tailLines(path.join(tmpDir, 'nonexistent.jsonl'), 5)
		expect(result).toEqual([])
	})

	it('handles file with no trailing newline', async () => {
		const filePath = path.join(tmpDir, 'test.jsonl')
		await fs.writeFile(filePath, 'line1\nline2\nline3')

		const result = await tailLines(filePath, 2)
		expect(result).toEqual(['line2', 'line3'])
	})

	it('normalizes CRLF to LF', async () => {
		const filePath = path.join(tmpDir, 'test.jsonl')
		await fs.writeFile(filePath, 'line1\r\nline2\r\nline3\r\n')

		const result = await tailLines(filePath, 2)
		expect(result).toEqual(['line2', 'line3'])
	})

	it('returns empty array for empty file', async () => {
		const filePath = path.join(tmpDir, 'empty.jsonl')
		await fs.writeFile(filePath, '')

		const result = await tailLines(filePath, 5)
		expect(result).toEqual([])
	})
})
