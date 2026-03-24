import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
	extractThreeWayInput,
	detectBinaryConflicts,
	tryDiff3Merge,
	resolveConflict,
	resolveAllConflicts,
} from '../../src/merge/conflict-resolver.js'

// Helper: create an isolated git repo in a temp directory
async function createTempRepo(): Promise<string> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-merge-test-'))
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

// Create a merge conflict scenario. Returns the repo path.
async function createConflictScenario(
	tmpDir: string
): Promise<void> {
	// Create specialist branch with a conflicting change
	execFileSync('git', ['checkout', '-b', 'specialist'], { cwd: tmpDir })
	await fs.writeFile(path.join(tmpDir, 'file.txt'), 'line 1\nspecialist change\nline 3\n')
	execFileSync('git', ['add', '.'], { cwd: tmpDir })
	execFileSync('git', ['commit', '-m', 'specialist edit'], { cwd: tmpDir })

	// Go back to main and make a conflicting change
	execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })
	await fs.writeFile(path.join(tmpDir, 'file.txt'), 'line 1\nmain change\nline 3\n')
	execFileSync('git', ['add', '.'], { cwd: tmpDir })
	execFileSync('git', ['commit', '-m', 'main edit'], { cwd: tmpDir })

	// Start the merge (will conflict)
	execFileSync('git', ['merge', '--no-commit', 'specialist'], {
		cwd: tmpDir,
		stdio: ['pipe', 'pipe', 'pipe'],
	}).toString()
}

describe('tryDiff3Merge', () => {
	it('returns merged content for non-overlapping changes', () => {
		// Changes must be separated by unchanged context lines for diff3 to resolve cleanly
		const input = {
			filePath: 'test.txt',
			base: 'line 1\nline 2\nline 3\nline 4\nline 5\n',
			ours: 'line 1\nline 2\nline 3\nline 4\nour line 5\n',
			theirs: 'their line 1\nline 2\nline 3\nline 4\nline 5\n',
			isBinary: false,
		}

		const result = tryDiff3Merge(input)
		expect(result).not.toBeNull()
		expect(result).toContain('their line 1')
		expect(result).toContain('our line 5')
	})

	it('returns null when changes overlap (true conflict)', () => {
		const input = {
			filePath: 'test.txt',
			base: 'line 1\noriginal\nline 3\n',
			ours: 'line 1\nour version\nline 3\n',
			theirs: 'line 1\ntheir version\nline 3\n',
			isBinary: false,
		}

		const result = tryDiff3Merge(input)
		expect(result).toBeNull()
	})

	it('handles identical changes from both sides (no conflict)', () => {
		const input = {
			filePath: 'test.txt',
			base: 'line 1\noriginal\nline 3\n',
			ours: 'line 1\nsame change\nline 3\n',
			theirs: 'line 1\nsame change\nline 3\n',
			isBinary: false,
		}

		const result = tryDiff3Merge(input)
		expect(result).not.toBeNull()
		expect(result).toContain('same change')
	})

	it('handles empty file gracefully', () => {
		const input = {
			filePath: 'test.txt',
			base: '',
			ours: 'new content\n',
			theirs: '',
			isBinary: false,
		}

		const result = tryDiff3Merge(input)
		expect(result).not.toBeNull()
	})
})

describe('extractThreeWayInput (real git)', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('extracts base, ours, theirs from git index stages', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		try {
			await createConflictScenario(tmpDir)
		} catch {
			// merge --no-commit exits non-zero on conflict, that's expected
		}

		const input = await extractThreeWayInput(git, 'file.txt')

		expect(input.base).toContain('line 2')
		expect(input.ours).toContain('main change')
		expect(input.theirs).toContain('specialist change')
	})
})

describe('detectBinaryConflicts (real git)', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('returns empty set when no binary conflicts', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		const result = await detectBinaryConflicts(git, ['file.txt'])
		expect(result.size).toBe(0)
	})
})

describe('resolveConflict (real git)', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('returns manual strategy for true conflicts', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		try {
			await createConflictScenario(tmpDir)
		} catch {
			// expected
		}

		const resolution = await resolveConflict(git, 'file.txt', false)
		// Both sides modified the same line, so diff3 cannot auto-resolve
		expect(resolution.strategy).toBe('manual')
		expect(resolution.resolved).toBe(false)
	})

	it('resolves binary files with theirs strategy', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		try {
			await createConflictScenario(tmpDir)
		} catch {
			// expected
		}

		const resolution = await resolveConflict(git, 'file.txt', true)
		expect(resolution.strategy).toBe('theirs')
		expect(resolution.resolved).toBe(true)
	})
})

describe('resolveAllConflicts', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('resolves all conflicts and calls onConflict callback', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)

		try {
			await createConflictScenario(tmpDir)
		} catch {
			// expected
		}

		const callbacks: Array<{ path: string; strategy: string }> = []
		const results = await resolveAllConflicts(
			git,
			['file.txt'],
			(filePath, resolution) => {
				callbacks.push({ path: filePath, strategy: resolution.strategy })
			}
		)

		expect(results).toHaveLength(1)
		expect(callbacks).toHaveLength(1)
		expect(callbacks[0].path).toBe('file.txt')
	})
})
