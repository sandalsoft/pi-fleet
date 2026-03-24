import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { WorktreeManager } from '../../src/worktree/manager.js'
import { WorktreePool } from '../../src/worktree/pool.js'

async function createTempRepo(): Promise<string> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-pool-'))
	execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir })
	execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir })
	execFileSync('git', ['config', 'user.email', 'test@test.com'], {
		cwd: tmpDir,
	})
	await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test')
	execFileSync('git', ['add', '.'], { cwd: tmpDir })
	execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir })
	return tmpDir
}

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

describe('WorktreePool', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('acquires and releases worktrees', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'pool-test-1',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const pool = new WorktreePool({
			manager,
			baseBranch: 'main',
			pi: pi as never,
		})

		// Acquire
		const info = await pool.acquire('developer')
		expect(info.agentName).toBe('developer')
		expect(pool.getInUse()).toHaveLength(1)
		expect(pool.getAvailable()).toHaveLength(0)

		// Release
		pool.release(info.worktreePath)
		expect(pool.getInUse()).toHaveLength(0)
		expect(pool.getAvailable()).toHaveLength(1)

		await pool.destroyAll()
	})

	it('reuses released worktrees with git state reset', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'pool-test-2',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const pool = new WorktreePool({
			manager,
			baseBranch: 'main',
			pi: pi as never,
		})

		// Acquire and release
		const first = await pool.acquire('developer')
		pool.release(first.worktreePath)

		// Second acquire should reuse the released worktree
		const second = await pool.acquire('reviewer')
		expect(second.worktreePath).toBe(first.worktreePath)
		expect(second.agentName).toBe('reviewer')

		// Pool size should still be 1
		expect(pool.size).toBe(1)

		// Verify that git checkout was called to reset state
		const checkoutCalls = pi.exec.mock.calls.filter(
			(call: [string, string[]]) =>
				call[0] === 'git' && call[1].includes('checkout')
		)
		expect(checkoutCalls.length).toBeGreaterThanOrEqual(1)

		await pool.destroyAll()
	})

	it('creates new worktree when pool is exhausted', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'pool-test-3',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const pool = new WorktreePool({
			manager,
			baseBranch: 'main',
			pi: pi as never,
		})

		// Acquire first
		const first = await pool.acquire('developer')

		// Acquire second while first is still in use
		const second = await pool.acquire('reviewer')
		expect(second.worktreePath).not.toBe(first.worktreePath)

		expect(pool.size).toBe(2)
		expect(pool.getInUse()).toHaveLength(2)

		await pool.destroyAll()
	})

	it('pre-creates worktrees and serves from pool without new git calls', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'pool-test-4',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const pool = new WorktreePool({
			manager,
			baseBranch: 'main',
			pi: pi as never,
		})
		await pool.preCreate(2)

		expect(pool.size).toBe(2)
		expect(pool.getAvailable()).toHaveLength(2)
		expect(pool.getInUse()).toHaveLength(0)

		// Count git worktree add calls before acquire
		const worktreeAddCalls = pi.exec.mock.calls.filter(
			(call: [string, string[]]) =>
				call[0] === 'git' && call[1].includes('worktree') && call[1].includes('add')
		)
		const addCountBefore = worktreeAddCalls.length

		// Acquire should come from pool (no new worktree add)
		const info = await pool.acquire('developer')
		expect(info.agentName).toBe('developer')
		expect(pool.getAvailable()).toHaveLength(1)

		// No new worktree add calls (only checkout for reset)
		const addCountAfter = pi.exec.mock.calls.filter(
			(call: [string, string[]]) =>
				call[0] === 'git' && call[1].includes('worktree') && call[1].includes('add')
		).length
		expect(addCountAfter).toBe(addCountBefore)

		await pool.destroyAll()
	})

	it('shows progress during pre-creation', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'pool-test-5',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

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

		const pool = new WorktreePool({
			manager,
			baseBranch: 'main',
			pi: pi as never,
		})
		await pool.preCreate(2, ctx as never)

		expect(ctx.ui.setWorkingMessage).toHaveBeenCalledWith(
			'Pre-creating worktree 1/2...'
		)
		expect(ctx.ui.setWorkingMessage).toHaveBeenCalledWith(
			'Pre-creating worktree 2/2...'
		)
		// Should clear the message at the end
		expect(ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith('')

		await pool.destroyAll()
	})

	it('destroyAll cleans up all worktrees', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'pool-test-6',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const pool = new WorktreePool({
			manager,
			baseBranch: 'main',
			pi: pi as never,
		})
		await pool.acquire('dev')
		await pool.acquire('qa')
		expect(pool.size).toBe(2)

		await pool.destroyAll()
		expect(pool.size).toBe(0)
	})
})
