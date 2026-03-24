import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { WorktreeManager } from '../../src/worktree/manager.js'
import {
	removeWorktree,
	pruneStaleWorktrees,
	detectStaleFleetWorktrees,
	fullCleanup,
} from '../../src/worktree/cleanup.js'

async function createTempRepo(): Promise<string> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-cleanup-'))
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

describe('cleanup functions', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('removeWorktree removes a worktree via the manager', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'cleanup-1',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		const info = await manager.createWorktree('developer', 'main')
		expect(manager.getActiveWorktrees()).toHaveLength(1)

		await removeWorktree(manager, info.worktreePath)
		expect(manager.getActiveWorktrees()).toHaveLength(0)
	})

	it('pruneStaleWorktrees runs without error', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'cleanup-2',
		})

		await expect(pruneStaleWorktrees(manager)).resolves.toBeUndefined()
	})

	it('detectStaleFleetWorktrees finds worktrees from other sessions', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)

		// Create worktrees for a "prior" session
		const oldManager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'old-session',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)

		await oldManager.createWorktree('developer', 'main')
		await oldManager.createWorktree('reviewer', 'main')

		// Create a new manager for the "current" session
		const currentManager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'current-session',
		})
		await currentManager.createWorktree('architect', 'main')

		// Detect stale worktrees (should find the old ones, not the current one)
		const stale = await detectStaleFleetWorktrees(
			currentManager,
			'current-session'
		)
		expect(stale).toHaveLength(2)
		expect(stale.every((s) => s.branch.includes('old-session'))).toBe(true)
		expect(stale.every((s) => !s.branch.includes('current-session'))).toBe(
			true
		)

		// Cleanup
		await oldManager.cleanupAll()
		await currentManager.cleanupAll()
	})

	it('fullCleanup prunes and removes stale worktrees', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)

		// Create "stale" worktree from a prior session
		const oldManager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'stale-session',
		})
		const wtRoot = path.join(
			repoDir,
			'..',
			`${path.basename(repoDir)}-fleet-worktrees`
		)
		cleanupDirs.push(wtRoot)
		await oldManager.createWorktree('developer', 'main')

		// New session runs fullCleanup
		const newManager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'new-session',
		})

		const result = await fullCleanup(newManager, 'new-session')
		expect(result.pruned).toBe(true)
		expect(result.removedCount).toBe(1)
	})

	it('fullCleanup is safe when no stale worktrees exist', async () => {
		const repoDir = await createTempRepo()
		cleanupDirs.push(repoDir)
		const pi = realPiExec(repoDir)
		const manager = new WorktreeManager({
			repoRoot: repoDir,
			pi: pi as never,
			sessionId: 'clean-session',
		})

		const result = await fullCleanup(manager, 'clean-session')
		expect(result.pruned).toBe(true)
		expect(result.removedCount).toBe(0)
	})
})
