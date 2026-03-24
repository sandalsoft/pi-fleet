import type { WorktreeManager } from './manager.js'

/**
 * Remove a single worktree by path, delegating to the manager.
 */
export async function removeWorktree(
	manager: WorktreeManager,
	worktreePath: string
): Promise<void> {
	await manager.removeWorktree(worktreePath)
}

/**
 * Prune stale worktrees from prior crashed sessions.
 * Runs `git worktree prune` to clean up references to worktrees
 * whose backing directories no longer exist.
 */
export async function pruneStaleWorktrees(
	manager: WorktreeManager
): Promise<void> {
	await manager.pruneStaleWorktrees()
}

/**
 * Detect and list fleet worktrees from prior sessions that may be stale.
 * Identifies worktrees with branch names matching the fleet/ prefix.
 */
export async function detectStaleFleetWorktrees(
	manager: WorktreeManager,
	currentSessionId: string
): Promise<Array<{ path: string; branch: string }>> {
	const allWorktrees = await manager.listAllWorktrees()
	const stale: Array<{ path: string; branch: string }> = []

	for (const wt of allWorktrees) {
		if (!wt.branch) continue
		// Fleet branches follow the pattern refs/heads/fleet/<agentName>-<sessionId>
		const branchName = wt.branch.replace('refs/heads/', '')
		if (!branchName.startsWith('fleet/')) continue

		// Skip worktrees belonging to the current session
		if (branchName.includes(currentSessionId)) continue

		stale.push({ path: wt.path, branch: branchName })
	}

	return stale
}

/**
 * Run a full cleanup cycle: prune git worktree references,
 * detect stale fleet worktrees, and remove them.
 */
export async function fullCleanup(
	manager: WorktreeManager,
	currentSessionId: string
): Promise<{ pruned: boolean; removedCount: number }> {
	// First, prune any already-removed worktrees
	await pruneStaleWorktrees(manager)

	// Detect stale fleet worktrees from prior sessions
	const stale = await detectStaleFleetWorktrees(manager, currentSessionId)

	let removedCount = 0
	for (const entry of stale) {
		try {
			await manager.removeWorktree(entry.path)
			removedCount++
		} catch {
			// Non-fatal: log and continue
			console.warn(
				`[pi-fleet] Could not remove stale worktree: ${entry.path}`
			)
		}
	}

	return { pruned: true, removedCount }
}
