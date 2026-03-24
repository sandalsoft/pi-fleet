import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import type { WorktreeManager, WorktreeInfo } from './manager.js'

export interface WorktreePoolOptions {
	manager: WorktreeManager
	baseBranch: string
	pi: ExtensionAPI
}

interface PoolEntry {
	info: WorktreeInfo
	inUse: boolean
}

/**
 * Pool of pre-created worktrees with acquire/release semantics.
 *
 * Reuses released worktrees by resetting them to the base branch state.
 * Tracks in-use state to prevent double-allocation.
 */
export class WorktreePool {
	private readonly manager: WorktreeManager
	private readonly baseBranch: string
	private readonly pi: ExtensionAPI
	private readonly entries: PoolEntry[] = []
	private preCreateCounter = 0

	constructor(opts: WorktreePoolOptions) {
		this.manager = opts.manager
		this.baseBranch = opts.baseBranch
		this.pi = opts.pi
	}

	/**
	 * Pre-create worktrees on init for faster agent startup.
	 */
	async preCreate(
		count: number,
		ctx?: ExtensionCommandContext
	): Promise<void> {
		for (let i = 0; i < count; i++) {
			this.preCreateCounter++
			const name = `pool-${this.preCreateCounter}`
			if (ctx) {
				ctx.ui.setWorkingMessage(
					`Pre-creating worktree ${i + 1}/${count}...`
				)
			}
			const info = await this.manager.createWorktree(name, this.baseBranch, ctx)
			this.entries.push({ info, inUse: false })
		}
		if (ctx) {
			ctx.ui.setWorkingMessage('')
		}
	}

	/**
	 * Acquire a worktree for an agent.
	 *
	 * If a free worktree exists in the pool, reuse it by resetting its
	 * git state to the base branch. Otherwise, create a new one.
	 * The returned worktree is marked as in-use until released.
	 */
	async acquire(
		agentName: string,
		ctx?: ExtensionCommandContext
	): Promise<WorktreeInfo> {
		// Look for a free pooled worktree
		const free = this.entries.find((e) => !e.inUse)
		if (free) {
			free.inUse = true
			// Reset worktree to base branch state for a clean starting point
			await this.pi.exec('git', [
				'-C',
				free.info.worktreePath,
				'checkout',
				'-B',
				free.info.branch,
				this.baseBranch,
			])
			// Update the info to reflect the new agent owner
			free.info = { ...free.info, agentName }
			return free.info
		}

		// No free worktree available: create one on demand
		const info = await this.manager.createWorktree(
			agentName,
			this.baseBranch,
			ctx
		)
		this.entries.push({ info, inUse: true })
		return info
	}

	/**
	 * Release a worktree back to the pool.
	 * The worktree remains on disk but is marked as available for reuse.
	 */
	release(worktreePath: string): void {
		const entry = this.entries.find(
			(e) => e.info.worktreePath === worktreePath
		)
		if (entry) {
			entry.inUse = false
		}
	}

	/**
	 * Get all worktrees currently in use.
	 */
	getInUse(): WorktreeInfo[] {
		return this.entries.filter((e) => e.inUse).map((e) => e.info)
	}

	/**
	 * Get all worktrees available for reuse.
	 */
	getAvailable(): WorktreeInfo[] {
		return this.entries.filter((e) => !e.inUse).map((e) => e.info)
	}

	/**
	 * Total number of worktrees in the pool (used + available).
	 */
	get size(): number {
		return this.entries.length
	}

	/**
	 * Clean up all pooled worktrees via the manager.
	 */
	async destroyAll(): Promise<void> {
		await this.manager.cleanupAll()
		this.entries.length = 0
	}
}
