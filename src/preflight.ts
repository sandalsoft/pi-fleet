import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'

interface PreflightBootstrapResult {
	repoRoot: string
}

interface PreflightBootstrapArgs {
	pi: ExtensionAPI
}

/**
 * Resolves the git repo root and validates the git environment.
 * Cheap to call: just git checks, no config validation.
 */
export async function preflightBootstrap({
	pi,
}: PreflightBootstrapArgs): Promise<PreflightBootstrapResult> {
	// Validate we're in a git repo
	const gitDirResult = await pi.exec('git', ['rev-parse', '--git-dir'])
	if (gitDirResult.code !== 0) {
		throw new Error('Not inside a git repository. Run /fleet from within a git repo.')
	}

	// Check for shallow clone
	const shallowResult = await pi.exec('git', ['rev-parse', '--is-shallow-repository'])
	if (shallowResult.stdout.trim() === 'true') {
		throw new Error(
			'Shallow clone detected. pi-fleet requires full git history for worktree operations. Run: git fetch --unshallow'
		)
	}

	// Resolve repo root
	const rootResult = await pi.exec('git', ['rev-parse', '--show-toplevel'])
	if (rootResult.code !== 0) {
		throw new Error('Failed to resolve git repo root.')
	}

	return { repoRoot: rootResult.stdout.trim() }
}

interface PreflightRunChecksArgs {
	repoRoot: string
	allowDirty: boolean
	pi: ExtensionAPI
	ctx: ExtensionCommandContext
}

/**
 * Checks config existence and dirty-tree gating.
 * Assumes repoRoot is already resolved via preflightBootstrap().
 */
export async function preflightRunChecks({
	repoRoot,
	allowDirty,
	pi,
	ctx,
}: PreflightRunChecksArgs): Promise<void> {
	// Check teams.yaml exists (existence only, no parse)
	const teamsPath = path.join(repoRoot, '.pi', 'teams.yaml')
	try {
		await fs.access(teamsPath)
	} catch {
		throw new Error(`Missing config: ${teamsPath}. Run /fleet to set up a new team.`)
	}

	// Dirty tree gating
	if (!allowDirty) {
		const statusResult = await pi.exec('git', ['status', '--porcelain'])
		if (statusResult.stdout.trim().length > 0) {
			const confirmed = await ctx.ui.confirm(
				'Dirty working tree',
				'Your working tree has uncommitted changes. pi-fleet creates worktrees from HEAD, so uncommitted changes will not be available to agents. Continue anyway?'
			)
			if (!confirmed) {
				throw new Error(
					'Aborted: dirty working tree. Commit your changes or use --allow-dirty.'
				)
			}
		}
	}
}
