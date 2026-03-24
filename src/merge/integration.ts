import type { EventLogWriter } from '../session/event-log.js'
import { createFleetEvent } from '../session/events.js'
import type {
	MergeStartedEvent,
	MergeCompletedEvent,
	MergeConflictEvent,
} from '../session/events.js'
import type { GitExec } from './conflict-resolver.js'
import { mergeBranch, type BranchMergeResult } from './merger.js'

/**
 * Specialist branch to merge, with the agent name for identification.
 */
export interface SpecialistBranch {
	agentName: string
	branch: string
}

export interface IntegrationOpts {
	git: GitExec
	repoRoot: string
	baseSha: string
	specialists: SpecialistBranch[]
	eventLog?: EventLogWriter
	sessionId: string
	/** Signal to request graceful shutdown */
	cancelSignal?: AbortSignal
	/** Safe window (ms) to finish current merge before stopping. Default: 30000 */
	mergeTimeoutMs?: number
}

export interface IntegrationResult {
	integrationBranch: string
	mergedAgents: string[]
	skippedAgents: string[]
	failedAgents: string[]
	results: BranchMergeResult[]
	drifted: boolean
	rebaseSucceeded: boolean | null
}

const MERGE_SAFE_WINDOW_MS = 30_000

/**
 * Create an integration branch from the base SHA and sequentially merge
 * each specialist branch into it.
 *
 * After all merges, checks for drift (HEAD has moved since baseSha).
 * If drifted, rebases the integration branch onto current HEAD.
 * If rebase fails, leaves the integration branch for manual resolution.
 */
export async function integrate(opts: IntegrationOpts): Promise<IntegrationResult> {
	const {
		git,
		repoRoot,
		baseSha,
		specialists,
		eventLog,
		sessionId,
		cancelSignal,
		mergeTimeoutMs = MERGE_SAFE_WINDOW_MS,
	} = opts

	const integrationBranch = `fleet/integration-${sessionId}`

	// Record the original branch so we can return to it
	const origBranchResult = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
	const origBranch = origBranchResult.stdout.trim()

	// Create integration branch from base SHA
	const createResult = await git(['checkout', '-b', integrationBranch, baseSha])
	if (createResult.code !== 0) {
		throw new Error(
			`Failed to create integration branch ${integrationBranch}: ${createResult.stderr.trim()}`
		)
	}

	// Emit merge_started
	if (eventLog) {
		await eventLog.append(
			createFleetEvent<MergeStartedEvent>({
				type: 'merge_started',
				integrationBranch,
			})
		)
	}

	const results: BranchMergeResult[] = []
	const mergedAgents: string[] = []
	const skippedAgents: string[] = []
	const failedAgents: string[] = []

	// Sequential merge of each specialist
	for (const spec of specialists) {
		// Check shutdown signal
		if (cancelSignal?.aborted) {
			// Allow bounded time for cleanup; stop merging new branches
			break
		}

		const mergePromise = mergeBranch(
			{
				git,
				repoRoot,
				onConflict: (agentName, filePath, resolution) => {
					// Emit merge_conflict event
					if (eventLog) {
						eventLog.append(
							createFleetEvent<MergeConflictEvent>({
								type: 'merge_conflict',
								agentName,
								filePath,
								resolution: resolution.strategy,
							})
						)
					}
				},
			},
			spec.agentName,
			spec.branch
		)

		// Bounded merge safe window: if shutdown triggers, allow current merge
		// to complete within the timeout, then stop
		let result: BranchMergeResult
		if (cancelSignal?.aborted) {
			result = await withTimeout(mergePromise, mergeTimeoutMs)
		} else {
			result = await mergePromise
		}

		results.push(result)

		switch (result.status) {
			case 'merged':
			case 'conflict-resolved':
				mergedAgents.push(spec.agentName)
				break
			case 'skipped':
				skippedAgents.push(spec.agentName)
				break
			case 'failed':
				failedAgents.push(spec.agentName)
				break
		}
	}

	// Drift detection: check if original branch HEAD has moved since baseSha
	let drifted = false
	let rebaseSucceeded: boolean | null = null

	const currentHeadResult = await git(['rev-parse', origBranch])
	const currentHead = currentHeadResult.stdout.trim()

	if (currentHead !== baseSha) {
		drifted = true

		// Rebase integration branch onto current HEAD
		const rebaseResult = await git(['rebase', '--onto', origBranch, baseSha, integrationBranch])
		if (rebaseResult.code === 0) {
			rebaseSucceeded = true
		} else {
			// Abort the failed rebase, leave integration branch for manual resolution
			await git(['rebase', '--abort'])
			rebaseSucceeded = false
		}
	}

	// Fast-forward origBranch to integration if rebase succeeded (or no drift)
	if (rebaseSucceeded !== false && mergedAgents.length > 0) {
		await git(['checkout', origBranch])
		await git(['merge', '--ff-only', integrationBranch])
	} else {
		// Return to original branch without merging
		await git(['checkout', origBranch])
	}

	// Emit merge_completed
	if (eventLog) {
		await eventLog.append(
			createFleetEvent<MergeCompletedEvent>({
				type: 'merge_completed',
				integrationBranch,
				mergedAgents,
			})
		)
	}

	return {
		integrationBranch,
		mergedAgents,
		skippedAgents,
		failedAgents,
		results,
		drifted,
		rebaseSucceeded,
	}
}

/**
 * Race a promise against a timeout. If the timeout fires first,
 * the original promise still runs but we return a failure result.
 */
async function withTimeout(
	promise: Promise<BranchMergeResult>,
	timeoutMs: number
): Promise<BranchMergeResult> {
	return Promise.race([
		promise,
		new Promise<BranchMergeResult>((_, reject) =>
			setTimeout(() => reject(new Error('Merge timed out during shutdown')), timeoutMs)
		),
	])
}
