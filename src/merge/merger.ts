import fs from 'node:fs/promises'
import type { GitExec, ConflictResolution } from './conflict-resolver.js'
import { resolveAllConflicts } from './conflict-resolver.js'

/**
 * Result of merging a single specialist branch.
 */
export interface BranchMergeResult {
	agentName: string
	branch: string
	status: 'merged' | 'conflict-resolved' | 'skipped' | 'failed'
	conflictResolutions: ConflictResolution[]
	/** Files that had residual conflicts needing manual dispatch */
	unresolvedPaths: string[]
	error?: string
}

export interface MergerOpts {
	git: GitExec
	repoRoot: string
	onConflict?: (agentName: string, filePath: string, resolution: ConflictResolution) => void
}

/**
 * Check whether a specialist branch has any commits beyond the base.
 * Returns true if the branch has diverged from the merge base.
 */
export async function hasBranchChanges(
	git: GitExec,
	branch: string,
	targetBranch: string
): Promise<boolean> {
	const mergeBase = await git(['merge-base', targetBranch, branch])
	if (mergeBase.code !== 0) return false

	const branchSha = await git(['rev-parse', branch])
	if (branchSha.code !== 0) return false

	return mergeBase.stdout.trim() !== branchSha.stdout.trim()
}

/**
 * Get the list of conflicted file paths during an active merge.
 */
export async function getConflictedPaths(git: GitExec): Promise<string[]> {
	const result = await git(['diff', '--name-only', '--diff-filter=U'])
	if (result.code !== 0) return []

	return result.stdout
		.split('\n')
		.map((p) => p.trim())
		.filter(Boolean)
}

/**
 * Write resolved content to a file and stage it.
 */
async function writeAndStageResolution(
	git: GitExec,
	repoRoot: string,
	filePath: string,
	content: string
): Promise<void> {
	const fullPath = `${repoRoot}/${filePath}`
	await fs.writeFile(fullPath, content, 'utf-8')
	await git(['add', filePath])
}

/**
 * Merge a single specialist branch into the current branch (integration branch).
 *
 * Uses git merge --no-commit to allow inspection before committing.
 * On conflicts: attempts automatic resolution via conflict-resolver.
 * On failure: aborts merge to restore clean state.
 */
export async function mergeBranch(
	opts: MergerOpts,
	agentName: string,
	branch: string
): Promise<BranchMergeResult> {
	const { git, repoRoot, onConflict } = opts

	// Check the current branch to use for merge-base comparison
	const headRef = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
	const currentBranch = headRef.stdout.trim()

	// Check if branch has anything to merge
	const hasChanges = await hasBranchChanges(git, branch, currentBranch)
	if (!hasChanges) {
		return {
			agentName,
			branch,
			status: 'skipped',
			conflictResolutions: [],
			unresolvedPaths: [],
		}
	}

	// Attempt merge
	const mergeResult = await git(['merge', '--no-commit', '--no-ff', branch])

	// Clean merge (exit code 0)
	if (mergeResult.code === 0) {
		const commitResult = await git(['commit', '-m', `merge: ${agentName} (${branch})`])
		if (commitResult.code !== 0) {
			// Nothing to commit (already up to date)
			return {
				agentName,
				branch,
				status: 'skipped',
				conflictResolutions: [],
				unresolvedPaths: [],
			}
		}
		return {
			agentName,
			branch,
			status: 'merged',
			conflictResolutions: [],
			unresolvedPaths: [],
		}
	}

	// Check for actual conflicts vs. other errors
	const conflicts = await getConflictedPaths(git)
	if (conflicts.length === 0) {
		// Non-conflict merge error: abort and report failure
		await git(['merge', '--abort'])
		return {
			agentName,
			branch,
			status: 'failed',
			conflictResolutions: [],
			unresolvedPaths: [],
			error: mergeResult.stderr.trim() || 'Merge failed with no conflicts detected',
		}
	}

	// Resolve conflicts
	const resolutions = await resolveAllConflicts(
		git,
		conflicts,
		(filePath, resolution) => onConflict?.(agentName, filePath, resolution)
	)

	// Write resolved content to disk and stage
	for (const res of resolutions) {
		if (res.resolved && res.content !== undefined) {
			await writeAndStageResolution(git, repoRoot, res.filePath, res.content)
		}
	}

	const unresolvedPaths = resolutions
		.filter((r) => !r.resolved)
		.map((r) => r.filePath)

	if (unresolvedPaths.length > 0) {
		// Abort the merge -- cannot commit with unresolved conflicts
		await git(['merge', '--abort'])
		return {
			agentName,
			branch,
			status: 'failed',
			conflictResolutions: resolutions,
			unresolvedPaths,
			error: `Unresolved conflicts in: ${unresolvedPaths.join(', ')}`,
		}
	}

	// All conflicts resolved, commit
	const commitResult = await git([
		'commit',
		'-m',
		`merge: ${agentName} (${branch}) with conflict resolution`,
	])
	if (commitResult.code !== 0) {
		await git(['merge', '--abort'])
		return {
			agentName,
			branch,
			status: 'failed',
			conflictResolutions: resolutions,
			unresolvedPaths: [],
			error: `Commit after conflict resolution failed: ${commitResult.stderr.trim()}`,
		}
	}

	return {
		agentName,
		branch,
		status: 'conflict-resolved',
		conflictResolutions: resolutions,
		unresolvedPaths: [],
	}
}
