import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { createFleetEvent, type WorktreeCreatedEvent } from '../session/events.js'
import type { EventLogWriter } from '../session/event-log.js'

export interface ExecResult {
	stdout: string
	stderr: string
	code: number
	killed: boolean
}

export interface WorktreeInfo {
	agentName: string
	branch: string
	worktreePath: string
	createdAt: string
}

export interface WorktreeManagerOptions {
	repoRoot: string
	pi: ExtensionAPI
	sessionId: string
	eventLog?: EventLogWriter
}

/**
 * Resolves the worktree root directory. Tries a sibling directory
 * next to the repo first; falls back to OS tmpdir if that fails.
 */
export function resolveWorktreeRoot(repoRoot: string): string {
	const projectName = path.basename(repoRoot)
	return path.join(repoRoot, '..', `${projectName}-fleet-worktrees`)
}

export function resolveWorktreeRootFallback(repoRoot: string): string {
	const projectName = path.basename(repoRoot)
	return path.join(os.tmpdir(), `${projectName}-fleet-worktrees`)
}

/**
 * Simple mutex for serializing worktree creation.
 * Prevents branch name races when multiple agents acquire worktrees concurrently.
 */
class Mutex {
	private _queue: Array<() => void> = []
	private _locked = false

	async acquire(): Promise<void> {
		if (!this._locked) {
			this._locked = true
			return
		}
		return new Promise<void>((resolve) => {
			this._queue.push(resolve)
		})
	}

	release(): void {
		const next = this._queue.shift()
		if (next) {
			next()
		} else {
			this._locked = false
		}
	}
}

/**
 * Higher-level API for creating and managing git worktrees.
 *
 * Branch naming: fleet/<agentName>-<sessionId>
 * Worktree location: always outside the repo (sibling dir or OS tmpdir).
 */
export class WorktreeManager {
	private readonly repoRoot: string
	private readonly pi: ExtensionAPI
	private readonly sessionId: string
	private readonly eventLog?: EventLogWriter
	private readonly mutex = new Mutex()
	private readonly activeWorktrees = new Map<string, WorktreeInfo>()
	private worktreeRoot: string | null = null
	private shutdownRegistered = false

	constructor(opts: WorktreeManagerOptions) {
		this.repoRoot = opts.repoRoot
		this.pi = opts.pi
		this.sessionId = opts.sessionId
		this.eventLog = opts.eventLog
	}

	/**
	 * Pre-flight: validate we're in a git repo and detect shallow clone.
	 * Should be called before any worktree operations.
	 */
	async validateGitRepo(): Promise<void> {
		const gitDir = await this.pi.exec('git', ['rev-parse', '--git-dir'])
		if (gitDir.code !== 0) {
			throw new Error('Not inside a git repository. Cannot manage worktrees.')
		}

		const shallow = await this.pi.exec('git', ['rev-parse', '--is-shallow-repository'])
		if (shallow.stdout.trim() === 'true') {
			throw new Error(
				'Shallow clone detected. Worktree operations require full git history. Run: git fetch --unshallow'
			)
		}
	}

	/**
	 * Resolve and create the worktree root directory.
	 * Tries sibling directory first, falls back to OS tmpdir.
	 */
	async ensureWorktreeRoot(): Promise<string> {
		if (this.worktreeRoot) return this.worktreeRoot

		const siblingRoot = resolveWorktreeRoot(this.repoRoot)

		// Try sibling directory first
		try {
			await fs.mkdir(siblingRoot, { recursive: true })
			this.worktreeRoot = siblingRoot
			return siblingRoot
		} catch {
			// Sibling directory creation failed (permissions, etc.)
		}

		// Fallback to OS tmpdir
		const fallbackRoot = resolveWorktreeRootFallback(this.repoRoot)
		try {
			await fs.mkdir(fallbackRoot, { recursive: true })
			this.worktreeRoot = fallbackRoot
			return fallbackRoot
		} catch {
			throw new Error(
				`Failed to create worktree root directory. Tried: ${siblingRoot}, ${fallbackRoot}`
			)
		}
	}

	/**
	 * Create a worktree for an agent with mutex protection.
	 * Returns the worktree info on success.
	 */
	async createWorktree(
		agentName: string,
		baseBranch: string,
		ctx?: ExtensionCommandContext
	): Promise<WorktreeInfo> {
		await this.mutex.acquire()
		try {
			return await this._createWorktreeUnsafe(agentName, baseBranch, ctx)
		} finally {
			this.mutex.release()
		}
	}

	private async _createWorktreeUnsafe(
		agentName: string,
		baseBranch: string,
		ctx?: ExtensionCommandContext
	): Promise<WorktreeInfo> {
		if (ctx) {
			ctx.ui.setWorkingMessage(`Creating worktree for ${agentName}...`)
		}

		const root = await this.ensureWorktreeRoot()
		const branch = `fleet/${agentName}-${this.sessionId}`
		const wtPath = path.join(root, `${agentName}-${this.sessionId}`)

		// Create the worktree with a new branch from the base
		const result = await this.pi.exec('git', [
			'worktree',
			'add',
			'-b',
			branch,
			wtPath,
			baseBranch,
		])

		if (result.code !== 0) {
			throw new Error(
				`Failed to create worktree for ${agentName}: ${result.stderr.trim()}`
			)
		}

		const info: WorktreeInfo = {
			agentName,
			branch,
			worktreePath: wtPath,
			createdAt: new Date().toISOString(),
		}

		this.activeWorktrees.set(wtPath, info)

		// Emit worktree_created event
		if (this.eventLog) {
			const event = createFleetEvent<WorktreeCreatedEvent>({
				type: 'worktree_created',
				agentName,
				worktreePath: wtPath,
			})
			await this.eventLog.append(event)
		}

		if (ctx) {
			ctx.ui.setWorkingMessage('')
		}

		return info
	}

	/**
	 * Remove a specific worktree and its branch.
	 */
	async removeWorktree(wtPath: string): Promise<void> {
		const info = this.activeWorktrees.get(wtPath)

		const removeResult = await this.pi.exec('git', [
			'worktree',
			'remove',
			'--force',
			wtPath,
		])

		if (removeResult.code !== 0) {
			// Not fatal: worktree may already be removed
			console.warn(
				`[pi-fleet] Failed to remove worktree ${wtPath}: ${removeResult.stderr.trim()}`
			)
		}

		// Clean up the branch too
		if (info) {
			await this.pi.exec('git', ['branch', '-D', info.branch])
			this.activeWorktrees.delete(wtPath)
		}
	}

	/**
	 * Clean up all active worktrees. Called during session shutdown.
	 */
	async cleanupAll(): Promise<void> {
		const paths = [...this.activeWorktrees.keys()]
		for (const wtPath of paths) {
			await this.removeWorktree(wtPath)
		}
	}

	/**
	 * Register a session shutdown handler to clean up worktrees.
	 * Also registers process signal handlers as a fallback.
	 */
	registerShutdownHandler(): void {
		if (this.shutdownRegistered) return
		this.shutdownRegistered = true

		const cleanup = async () => {
			await this.cleanupAll()
			await this.pruneStaleWorktrees()
		}

		// Process signal fallback
		process.once('SIGTERM', () => {
			cleanup().catch((err) =>
				console.warn('[pi-fleet] Shutdown cleanup error:', err)
			)
		})

		process.once('SIGINT', () => {
			cleanup().catch((err) =>
				console.warn('[pi-fleet] Shutdown cleanup error:', err)
			)
		})
	}

	/**
	 * Prune stale worktrees from prior crashed sessions.
	 * Should be called on startup and shutdown.
	 */
	async pruneStaleWorktrees(): Promise<void> {
		await this.pi.exec('git', ['worktree', 'prune'])
	}

	/**
	 * List all currently active worktrees managed by this session.
	 */
	getActiveWorktrees(): WorktreeInfo[] {
		return [...this.activeWorktrees.values()]
	}

	/**
	 * List all git worktrees (including those from other sessions).
	 * Uses git worktree list --porcelain for machine-parseable output.
	 */
	async listAllWorktrees(): Promise<Array<{ path: string; branch: string | null }>> {
		const result = await this.pi.exec('git', ['worktree', 'list', '--porcelain'])
		if (result.code !== 0) return []

		const entries: Array<{ path: string; branch: string | null }> = []
		let current: { path: string; branch: string | null } | null = null

		for (const line of result.stdout.split('\n')) {
			if (line.startsWith('worktree ')) {
				if (current) entries.push(current)
				current = { path: line.slice('worktree '.length), branch: null }
			} else if (line.startsWith('branch ') && current) {
				current.branch = line.slice('branch '.length)
			} else if (line === '' && current) {
				entries.push(current)
				current = null
			}
		}
		if (current) entries.push(current)

		return entries
	}
}
