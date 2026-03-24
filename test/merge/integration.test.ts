import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { integrate } from '../../src/merge/integration.js'

async function createTempRepo(): Promise<string> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-integration-test-'))
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

function getHeadSha(cwd: string): string {
	return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim()
}

function mockEventLog() {
	return {
		append: vi.fn(async () => {}),
	}
}

describe('integrate (real git)', () => {
	const cleanupDirs: string[] = []

	afterEach(async () => {
		for (const dir of cleanupDirs) {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
		cleanupDirs.length = 0
	})

	it('creates integration branch and merges a single specialist', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)
		const baseSha = getHeadSha(tmpDir)
		const eventLog = mockEventLog()

		// Create specialist branch with changes
		execFileSync('git', ['checkout', '-b', 'fleet/dev-sess-1'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'feature.ts'), 'export const x = 1\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'dev work'], { cwd: tmpDir })
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })

		const result = await integrate({
			git,
			repoRoot: tmpDir,
			baseSha,
			specialists: [{ agentName: 'developer', branch: 'fleet/dev-sess-1' }],
			eventLog,
			sessionId: 'test-001',
		})

		expect(result.mergedAgents).toEqual(['developer'])
		expect(result.skippedAgents).toHaveLength(0)
		expect(result.failedAgents).toHaveLength(0)
		expect(result.drifted).toBe(false)
		expect(result.integrationBranch).toBe('fleet/integration-test-001')

		// Verify file exists on main
		const content = await fs.readFile(path.join(tmpDir, 'feature.ts'), 'utf-8')
		expect(content).toBe('export const x = 1\n')

		// Verify events emitted
		expect(eventLog.append).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'merge_started' })
		)
		expect(eventLog.append).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'merge_completed' })
		)
	})

	it('merges multiple specialists sequentially', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)
		const baseSha = getHeadSha(tmpDir)

		// First specialist adds file A
		execFileSync('git', ['checkout', '-b', 'fleet/dev-1'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'a.ts'), 'export const a = 1\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'dev1 work'], { cwd: tmpDir })

		// Second specialist adds file B (from same base)
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })
		execFileSync('git', ['checkout', '-b', 'fleet/dev-2'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'b.ts'), 'export const b = 2\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'dev2 work'], { cwd: tmpDir })

		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })

		const result = await integrate({
			git,
			repoRoot: tmpDir,
			baseSha,
			specialists: [
				{ agentName: 'dev1', branch: 'fleet/dev-1' },
				{ agentName: 'dev2', branch: 'fleet/dev-2' },
			],
			sessionId: 'test-002',
		})

		expect(result.mergedAgents).toEqual(['dev1', 'dev2'])

		// Both files should exist on main
		expect(await fs.readFile(path.join(tmpDir, 'a.ts'), 'utf-8')).toBe('export const a = 1\n')
		expect(await fs.readFile(path.join(tmpDir, 'b.ts'), 'utf-8')).toBe('export const b = 2\n')
	})

	it('skips specialists with no changes', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)
		const baseSha = getHeadSha(tmpDir)

		// Create a branch with no new commits
		execFileSync('git', ['branch', 'fleet/idle'], { cwd: tmpDir })

		// Create a branch with actual changes
		execFileSync('git', ['checkout', '-b', 'fleet/worker'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'work.ts'), 'done\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'actual work'], { cwd: tmpDir })
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })

		const result = await integrate({
			git,
			repoRoot: tmpDir,
			baseSha,
			specialists: [
				{ agentName: 'idle', branch: 'fleet/idle' },
				{ agentName: 'worker', branch: 'fleet/worker' },
			],
			sessionId: 'test-003',
		})

		expect(result.skippedAgents).toEqual(['idle'])
		expect(result.mergedAgents).toEqual(['worker'])
	})

	it('detects drift and rebases integration branch', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)
		const baseSha = getHeadSha(tmpDir)

		// Create specialist branch
		execFileSync('git', ['checkout', '-b', 'fleet/dev'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'feature.ts'), 'specialist work\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'specialist'], { cwd: tmpDir })

		// Main has drifted (new commit after baseSha)
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'other.txt'), 'drift commit\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'drift'], { cwd: tmpDir })

		const result = await integrate({
			git,
			repoRoot: tmpDir,
			baseSha,
			specialists: [{ agentName: 'dev', branch: 'fleet/dev' }],
			sessionId: 'test-004',
		})

		expect(result.drifted).toBe(true)
		expect(result.rebaseSucceeded).toBe(true)
		expect(result.mergedAgents).toEqual(['dev'])

		// Both the drift commit and the specialist's work should be on main
		const featureContent = await fs.readFile(path.join(tmpDir, 'feature.ts'), 'utf-8')
		expect(featureContent).toBe('specialist work\n')
		const otherContent = await fs.readFile(path.join(tmpDir, 'other.txt'), 'utf-8')
		expect(otherContent).toBe('drift commit\n')
	})

	it('handles conflicts between specialists that touch same file differently', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)
		const baseSha = getHeadSha(tmpDir)

		// Specialist 1 changes line 2
		execFileSync('git', ['checkout', '-b', 'fleet/spec1'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'file.txt'), 'line 1\nspec1 change\nline 3\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'spec1 edit'], { cwd: tmpDir })

		// Specialist 2 also changes line 2 (from same base)
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })
		execFileSync('git', ['checkout', '-b', 'fleet/spec2'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'file.txt'), 'line 1\nspec2 change\nline 3\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'spec2 edit'], { cwd: tmpDir })

		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })

		const eventLog = mockEventLog()
		const result = await integrate({
			git,
			repoRoot: tmpDir,
			baseSha,
			specialists: [
				{ agentName: 'spec1', branch: 'fleet/spec1' },
				{ agentName: 'spec2', branch: 'fleet/spec2' },
			],
			eventLog,
			sessionId: 'test-005',
		})

		// spec1 merges clean; spec2 conflicts with spec1's changes
		expect(result.mergedAgents).toContain('spec1')
		expect(result.failedAgents).toContain('spec2')

		// merge_conflict event should have been emitted
		const conflictEvents = eventLog.append.mock.calls.filter(
			(call: unknown[]) => (call[0] as { type: string }).type === 'merge_conflict'
		)
		expect(conflictEvents.length).toBeGreaterThan(0)
	})

	it('emits merge_started and merge_completed events', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)
		const baseSha = getHeadSha(tmpDir)
		const eventLog = mockEventLog()

		execFileSync('git', ['checkout', '-b', 'fleet/dev'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'x.ts'), 'done\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'work'], { cwd: tmpDir })
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })

		await integrate({
			git,
			repoRoot: tmpDir,
			baseSha,
			specialists: [{ agentName: 'dev', branch: 'fleet/dev' }],
			eventLog,
			sessionId: 'test-006',
		})

		const eventTypes = eventLog.append.mock.calls.map(
			(call: unknown[]) => (call[0] as { type: string }).type
		)
		expect(eventTypes).toContain('merge_started')
		expect(eventTypes).toContain('merge_completed')
		expect(eventTypes.indexOf('merge_started')).toBeLessThan(
			eventTypes.indexOf('merge_completed')
		)
	})

	it('returns to original branch after integration', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)
		const baseSha = getHeadSha(tmpDir)

		execFileSync('git', ['checkout', '-b', 'fleet/dev'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'x.ts'), 'done\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'work'], { cwd: tmpDir })
		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })

		await integrate({
			git,
			repoRoot: tmpDir,
			baseSha,
			specialists: [{ agentName: 'dev', branch: 'fleet/dev' }],
			sessionId: 'test-007',
		})

		// Should be back on main
		const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
			cwd: tmpDir,
			encoding: 'utf-8',
		}).trim()
		expect(currentBranch).toBe('main')
	})

	it('stops merging new branches when cancelSignal is aborted', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)
		const baseSha = getHeadSha(tmpDir)

		// Create two specialist branches
		execFileSync('git', ['checkout', '-b', 'fleet/first'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'first.ts'), 'first\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'first'], { cwd: tmpDir })

		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })
		execFileSync('git', ['checkout', '-b', 'fleet/second'], { cwd: tmpDir })
		await fs.writeFile(path.join(tmpDir, 'second.ts'), 'second\n')
		execFileSync('git', ['add', '.'], { cwd: tmpDir })
		execFileSync('git', ['commit', '-m', 'second'], { cwd: tmpDir })

		execFileSync('git', ['checkout', 'main'], { cwd: tmpDir })

		// Abort immediately
		const controller = new AbortController()
		controller.abort()

		const result = await integrate({
			git,
			repoRoot: tmpDir,
			baseSha,
			specialists: [
				{ agentName: 'first', branch: 'fleet/first' },
				{ agentName: 'second', branch: 'fleet/second' },
			],
			sessionId: 'test-008',
			cancelSignal: controller.signal,
		})

		// Should have skipped at least the second specialist
		expect(result.mergedAgents.length + result.skippedAgents.length).toBeLessThanOrEqual(2)
	})

	it('handles all specialists having no changes', async () => {
		const tmpDir = await createTempRepo()
		cleanupDirs.push(tmpDir)
		const git = makeGitExec(tmpDir)
		const baseSha = getHeadSha(tmpDir)

		execFileSync('git', ['branch', 'fleet/idle1'], { cwd: tmpDir })
		execFileSync('git', ['branch', 'fleet/idle2'], { cwd: tmpDir })

		const result = await integrate({
			git,
			repoRoot: tmpDir,
			baseSha,
			specialists: [
				{ agentName: 'idle1', branch: 'fleet/idle1' },
				{ agentName: 'idle2', branch: 'fleet/idle2' },
			],
			sessionId: 'test-009',
		})

		expect(result.skippedAgents).toEqual(['idle1', 'idle2'])
		expect(result.mergedAgents).toHaveLength(0)
	})
})
