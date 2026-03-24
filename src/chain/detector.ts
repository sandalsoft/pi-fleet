/**
 * Agent-chain detection for the interview phase.
 *
 * Checks for `.pi/agent-chain.yaml` existence and, if found,
 * offers the user a choice between Dispatcher mode and Chain mode.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent'

export type FleetMode = 'dispatcher' | 'chain'

/**
 * Check whether an agent-chain.yaml file exists at the canonical path.
 */
export async function hasChainConfig(repoRoot: string): Promise<boolean> {
	const chainPath = path.join(repoRoot, '.pi', 'agent-chain.yaml')
	try {
		await fs.access(chainPath)
		return true
	} catch {
		return false
	}
}

/**
 * If both teams.yaml and agent-chain.yaml exist, prompt the user to choose
 * between Dispatcher mode (parallel DAG) and Chain mode (sequential pipeline).
 *
 * If only one config exists, return the corresponding mode without prompting.
 * If neither exists, return null (caller should handle setup).
 */
export async function detectFleetMode(
	repoRoot: string,
	ctx: ExtensionCommandContext
): Promise<FleetMode | null> {
	const chainPath = path.join(repoRoot, '.pi', 'agent-chain.yaml')
	const teamsPath = path.join(repoRoot, '.pi', 'teams.yaml')

	let hasChain = false
	let hasTeams = false

	try {
		await fs.access(chainPath)
		hasChain = true
	} catch {
		// no chain config
	}

	try {
		await fs.access(teamsPath)
		hasTeams = true
	} catch {
		// no teams config
	}

	if (!hasChain && !hasTeams) return null
	if (hasChain && !hasTeams) return 'chain'
	if (!hasChain && hasTeams) return 'dispatcher'

	// Both exist: let the user choose
	const choice = await ctx.ui.select(
		'Both dispatcher (teams.yaml) and chain (agent-chain.yaml) configs found. Which mode?',
		['Dispatcher mode (parallel agents)', 'Chain mode (sequential pipeline)']
	)

	if (choice === undefined) return null
	// Map display label back to mode
	return choice.startsWith('Dispatcher') ? 'dispatcher' : 'chain'
}
