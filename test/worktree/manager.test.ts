import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
	WorktreeManager,
	resolveWorktreeRoot,
	resolveWorktreeRootFallback,
	sanitizeAgentName,
} from '../../src/worktree/manager.js'

// Helper: create an isolated git repo in a temp directory
async function createTempRepo(): Promise<string> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-test-'))
	execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir })
	execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir })
	execFileSync('git', ['config', 'user.email', 'test@test.com'], {
		cwd: tmpDir,
	})
	// Need at least one commit for worktree add to work
	await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test')
	execFileSync('git', ['add', '.'], { cwd: tmpDir })
	execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir })
	return tmpDir
}

// Helper: create a mock pi.exec that delegates to real git
function realPiExec(cwd: string) {
	return {
		exec: vi.fn(
			async (
				cmd: string,
				args: string[]
			): Promise<{
				stdout: string
				stderr: string
				code: number
				killed: boolean
			}> => {
				try {
					const stdout = execFileSync(cmd, args, {
						cwd,
						encoding: 'utf-8',
						stdio: ['pipe', 'pipe', 'pipe'],
					})
					return { stdout, stderr: '', code: 0, killed: false }
				} catch (err: unknown) {
					const e = err as {
						stdout?: string
						stderr?: string
						status?: number
					}
					return {
						stdout: e.stdout ?? '',
						stderr: e.stderr ?? '',
						code: e.status ?? 1,
						killed: false,
					}
				}
			}
		),
	}
}

function mockEventLog() {
	return {
		append: vi.fn(async () => {}),
	}
}

describe('sanitizeAgentName', () => {
	it('passes through valid names unchanged', () => {
		expect(sanitizeAgentName('developer')).toBe('developer')
		expect(sanitizeAgentName('qa-lead')).toBe('qa-lead')
		expect(sanitizeAgentName('agent_1')).toBe('agent_1')
	})

	it('rejects names with path separators', () => {
		expect(() => sanitizeAgentName('../evil')).toThrow('must not contain')
		expect(() => sanitizeAgentName('foo/bar')).toThrow('must not contain')
		expect(() => sanitizeAgentName('foo\\bar')).toThrow('must not contain')
	})

	it('rejects names with .. sequences', () => {
		expect(() => sanitizeAgentName('foo..bar')).toThrow('must not contain')
	})

	it('replaces invalid characters with hyphens', () => {
		expect(sanitizeAgentName('agent name')).toBe('agent-name')
		expect(sanitizeAgentName('agent@name!')).toBe('agent-name-')
	})

	it('rejects names that produce empty slugs', () => {
		expect(() => sanitizeAgentName('!!!')).not.toThrow() // produces ---
	})

	it('rejects names exceeding 64 characters', () => {
		const longName = 'a'.repeat(65)
		expect(() => sanitizeAgentName(longName)).toThrow('exceeds 64')
	})
})

describe('resolveWorktreeRoot', () => {
	it('places worktrees in a sibling directory', () => {
		const result = resolveWorktreeRoot('/home/user/my-project')
		expect(result).toBe('/home/user/my-project-fleet-worktrees')
	})

	it('uses project basename for the directory name', () => {
		const result = resolveWorktreeRoot('/deep/nested/path/cool-repo')
		expect(result).toBe('/deep/nested/path/cool-repo-fleet-worktrees')
	})
})

describe('resolveWorktreeRootFallback', () => {
	it('uses OS tmpdir as the root', () => {
		const result = resolveWorktreeRootFallback('/home/user/my-project')
		expect(result).toBe(
			path.join(os.tmpdir(), 'my-project-fleet-worktrees')
		)
	})
})

describe('WorktreeManager (real git)', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('validates a real git repo without error', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'test-session',
		})
		await expect(manager.validateGitRepo()).resolves.toBeUndefined()
	})

	it('creates a worktree with correct branch name including counter', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const eventLog = mockEventLog()
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'sess-001',
			eventLog,
		})

		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const info = await manager.createWorktree('developer', 'main')
		expect(info.agentName).toBe('developer')
		expect(info.branch).toBe('fleet/developer-sess-001-1')
		expect(info.worktreePath).toContain('developer-sess-001-1')

		// Verify worktree directory actually exists
		const stat = await fs.stat(info.worktreePath)
		expect(stat.isDirectory()).toBe(true)

		// Verify event was emitted
		expect(eventLog.append).toHaveBeenCalledOnce()
		const emittedEvent = eventLog.append.mock.calls[0][0]
		expect(emittedEvent.type).toBe('worktree_created')
		expect(emittedEvent.agentName).toBe('developer')
	})

	it('creates multiple worktrees for different agents with unique counters', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'sess-002',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const dev = await manager.createWorktree('developer', 'main')
		const rev = await manager.createWorktree('reviewer', 'main')

		expect(dev.branch).toBe('fleet/developer-sess-002-1')
		expect(rev.branch).toBe('fleet/reviewer-sess-002-2')

		const active = manager.getActiveWorktrees()
		expect(active).toHaveLength(2)
	})

	it('creates multiple worktrees for same agent name without conflict', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'sess-dup',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const first = await manager.createWorktree('developer', 'main')
		const second = await manager.createWorktree('developer', 'main')

		expect(first.branch).not.toBe(second.branch)
		expect(first.worktreePath).not.toBe(second.worktreePath)

		await manager.cleanupAll()
	})

	it('removes a worktree and its branch', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'sess-003',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const info = await manager.createWorktree('qa', 'main')
		expect(manager.getActiveWorktrees()).toHaveLength(1)

		await manager.removeWorktree(info.worktreePath)
		expect(manager.getActiveWorktrees()).toHaveLength(0)

		// Directory should be gone
		await expect(fs.stat(info.worktreePath)).rejects.toThrow()
	})

	it('cleans up all worktrees', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'sess-004',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		await manager.createWorktree('dev', 'main')
		await manager.createWorktree('qa', 'main')
		expect(manager.getActiveWorktrees()).toHaveLength(2)

		await manager.cleanupAll()
		expect(manager.getActiveWorktrees()).toHaveLength(0)
	})

	it('prunes stale worktrees without error', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'sess-005',
		})

		await expect(manager.pruneStaleWorktrees()).resolves.toBeUndefined()
	})

	it('lists all worktrees via porcelain output', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'sess-006',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		await manager.createWorktree('architect', 'main')

		const all = await manager.listAllWorktrees()
		// Should have at least the main worktree + the one we created
		expect(all.length).toBeGreaterThanOrEqual(2)

		const fleetWt = all.find((w) =>
			w.branch?.includes('fleet/architect-sess-006')
		)
		expect(fleetWt).toBeDefined()

		await manager.cleanupAll()
	})

	it('uses -C repoRoot and array args for all git commands', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'sess-007',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		await manager.createWorktree('developer', 'main')

		// Verify all exec calls are git with array arguments and -C flag
		for (const call of pi.exec.mock.calls) {
			expect(call[0]).toBe('git')
			expect(Array.isArray(call[1])).toBe(true)
			expect(call[1][0]).toBe('-C')
			expect(call[1][1]).toBe(repoDir)
		}

		await manager.cleanupAll()
	})

	it('shows progress via setWorkingMessage when ctx provided', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const ctx = {
			ui: {
				setWorkingMessage: vi.fn(),
				notify: vi.fn(),
				confirm: vi.fn(),
				select: vi.fn(),
				input: vi.fn(),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
			},
		}
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'sess-008',
		})

		await manager.createWorktree('developer', 'main', ctx as never)

		expect(ctx.ui.setWorkingMessage).toHaveBeenCalledWith(
			'Creating worktree for developer...'
		)
		// Should clear the message after creation
		expect(ctx.ui.setWorkingMessage).toHaveBeenCalledWith('')

		await manager.cleanupAll()
	})

	it('removes foreign worktrees and their branches', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)

		// Create a worktree with one manager instance
		const manager1 = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'old-sess',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const info = await manager1.createWorktree('dev', 'main')

		// A different manager (simulating new session) removes it
		const manager2 = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'new-sess',
		})

		// Should resolve branch from porcelain output and delete it
		await manager2.removeWorktree(info.worktreePath)

		// Verify worktree is gone
		await expect(fs.stat(info.worktreePath)).rejects.toThrow()
	})
})

describe('WorktreeManager (mutex)', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('serializes concurrent worktree creation', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'mutex-test',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		// Create worktrees concurrently — mutex should prevent races
		const results = await Promise.all([
			manager.createWorktree('agent-a', 'main'),
			manager.createWorktree('agent-b', 'main'),
			manager.createWorktree('agent-c', 'main'),
		])

		expect(results).toHaveLength(3)
		const branches = results.map((r) => r.branch)
		// All branches should be unique
		expect(new Set(branches).size).toBe(3)

		await manager.cleanupAll()
	})
})
