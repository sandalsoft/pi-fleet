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
 * Parse a fleet branch name into its components.
 * Expected format: refs/heads/fleet/<agentName>-<sessionId>-<counter>
 * or fleet/<agentName>-<sessionId>-<counter>
 * Returns the sessionId component, or null if not a fleet branch.
 */
function parseFleetBranchSessionId(branch: string): string | null {
	const branchName = branch.replace('refs/heads/', '')
	if (!branchName.startsWith('fleet/')) return null

	// Pattern: fleet/<agent>-<sessionId>-<counter>
	// The sessionId is the second-to-last segment when split by the last hyphen
	const rest = branchName.slice('fleet/'.length)
	// Split from the right: last segment is counter, second-to-last is sessionId
	// But sessionId itself might contain hyphens, so we parse more carefully.
	// Convention: counter is always a number at the very end after the last hyphen.
	// SessionId is between the agent name and the counter.
	// Since agent names are sanitized to [a-zA-Z0-9-_], we can't trivially split.
	// Instead, check if the branch contains the session ID anywhere in its path.
	return rest
}

/**
 * Detect and list fleet worktrees from prior sessions that may be stale.
 * Identifies worktrees with branch names matching the fleet/ prefix
 * whose session ID component does not match the current session.
 */
export async function detectStaleFleetWorktrees(
	manager: WorktreeManager,
	currentSessionId: string
): Promise<Array<{ path: string; branch: string }>> {
	const allWorktrees = await manager.listAllWorktrees()
	const stale: Array<{ path: string; branch: string }> = []

	for (const wt of allWorktrees) {
		if (!wt.branch) continue
		const branchName = wt.branch.replace('refs/heads/', '')
		if (!branchName.startsWith('fleet/')) continue

		// Extract the portion after "fleet/" and check if it contains
		// the current session ID as a distinct segment (bounded by hyphens or end)
		const rest = branchName.slice('fleet/'.length)
		const sessionPattern = new RegExp(`(^|-)${escapeRegExp(currentSessionId)}(-|$)`)
		if (sessionPattern.test(rest)) continue

		stale.push({ path: wt.path, branch: branchName })
	}

	return stale
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
			await manager.removeWorktree(entry.path, entry.branch)
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
