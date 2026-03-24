import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
	mergeBranch,
	hasBranchChanges,
	getConflictedPaths,
} from '../../src/merge/merger.js'

async function createTempRepo(): Promise<string> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-merger-test-'))
	execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir })
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir })
	execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir })
	await fs.writeFile(path.join(tmpDir, 'file.txt'), 'line 1\nline 2\nline 3\n')
	execFileSync('git', ['add', '.'], { cwd: tmpDir })
	execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir })
	return tmpDir
}

function makeGitExec(cwd: string) {
	return async (args: string[]) => {
		try {
			const stdout = execFileSync('git', ['-C', cwd, ...args], {
				encoding: 'utf-8',
				stdio: ['pipe', 'pipe', 'pipe'],
			})
			return { stdout, stderr: '', code: 0 }
		} catch (err: unknown) {
			const e = err as { stdout?: string; stderr?: string; status?: number }
			return {
				stdout: e.stdout ?? '',
				stderr: e.stderr ?? '',
				code: e.status ?? 1,
			}
		}
	}
}

describe('hasBranchChanges', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('returns false when specialist branch has no divergent commits', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		// Create branch at same point (no new commits)
		execFileSync('git', ['branch', 'specialist'], { cwd: tmpDir })

		const result = await hasBranchChanges(git, 'specialist', 'main')
		expect(result).toBe(false)
	})

	it('returns true when specialist branch has new commits', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		execFileSync('git', ['checkout', '-b', 'specialist'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'new.txt'), 'content')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'specialist work'], { cwd: tmpDir })
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })

		const result = await hasBranchChanges(git, 'specialist', 'main')
		expect(result).toBe(true)
	})
})

describe('getConflictedPaths', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('returns empty array when no merge is in progress', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		const paths = await getConflictedPaths(git)
		expect(paths).toEqual([])
	})
})

describe('mergeBranch (real git)', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('merges a clean specialist branch', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		// Specialist adds a new file
		execFileSync('git', ['checkout', '-b', 'fleet/developer'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'feature.ts'), 'export const x = 1\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'add feature'], { cwd: tmpDir })
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })

		const result = await mergeBranch(
			{ git, repoRoot: tmpDir },
			'developer',
			'fleet/developer'
		)

		expect(result.status).toBe('merged')
		expect(result.conflictResolutions).toHaveLength(0)
		expect(result.unresolvedPaths).toHaveLength(0)

		// Verify the file exists on main after merge
		const content = await fs.readFile(path.join(tmpDir, 'feature.ts'), 'utf-8')
		expect(content).toBe('export const x = 1\n')
	})

	it('skips a branch with no changes', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		// Create branch at same point (no new commits)
		execFileSync('git', ['branch', 'fleet/empty'], { cwd: tmpDir })

		const result = await mergeBranch(
			{ git, repoRoot: tmpDir },
			'empty-agent',
			'fleet/empty'
		)

		expect(result.status).toBe('skipped')
	})

	it('handles non-overlapping changes between main and specialist', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		// Specialist modifies end of file
		execFileSync('git', ['checkout', '-b', 'fleet/dev'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'file.txt'), 'line 1\nline 2\nspecialist line 3\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'specialist edit'], { cwd: tmpDir })

		// Main modifies beginning of file
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'file.txt'), 'main line 1\nline 2\nline 3\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'main edit'], { cwd: tmpDir })

		const result = await mergeBranch(
			{ git, repoRoot: tmpDir },
			'dev',
			'fleet/dev'
		)

		// Git itself can auto-merge non-overlapping changes
		expect(result.status).toBe('merged')
	})

	it('reports failed status for overlapping conflicts that diff3 cannot resolve', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		// Specialist changes same line
		execFileSync('git', ['checkout', '-b', 'fleet/dev'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'file.txt'), 'line 1\nspecialist change\nline 3\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'specialist edit'], { cwd: tmpDir })

		// Main changes same line
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'file.txt'), 'line 1\nmain change\nline 3\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'main edit'], { cwd: tmpDir })

		const conflicts: Array<{ agent: string; file: string }> = []
		const result = await mergeBranch(
			{
				git,
				repoRoot: tmpDir,
				onConflict: (agentName, filePath) => {
					conflicts.push({ agent: agentName, file: filePath })
				},
			},
			'dev',
			'fleet/dev'
		)

		expect(result.status).toBe('failed')
		expect(result.unresolvedPaths).toContain('file.txt')
		expect(conflicts).toHaveLength(1)

		// Verify merge was aborted (clean state)
		const status = await git(['status', '--porcelain'])
		expect(status.stdout.trim()).toBe('')
	})

	it('calls onConflict callback for each conflicted file', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		// Create conflict in multiple files
		await fs.writeFile(path.join(tmpDir, 'a.txt'), 'original a\n')
		await fs.writeFile(path.join(tmpDir, 'b.txt'), 'original b\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'add a and b'], { cwd: tmpDir })

		execFileSync('git', ['checkout', '-b', 'fleet/multi'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'a.txt'), 'specialist a\n')
		await fs.writeFile(path.join(tmpDir, 'b.txt'), 'specialist b\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'specialist edits'], { cwd: tmpDir })

		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'a.txt'), 'main a\n')
		await fs.writeFile(path.join(tmpDir, 'b.txt'), 'main b\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'main edits'], { cwd: tmpDir })

		const conflictFiles: string[] = []
		await mergeBranch(
			{
				git,
				repoRoot: tmpDir,
				onConflict: (_agent, filePath) => conflictFiles.push(filePath),
			},
			'multi',
			'fleet/multi'
		)

		expect(conflictFiles).toContain('a.txt')
		expect(conflictFiles).toContain('b.txt')
	})
})
