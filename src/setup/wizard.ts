import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { preflightBootstrap } from '../preflight.js'
import {
	AVAILABLE_AGENTS,
	detectConfigState,
	scaffold,
	type AgentTemplateName,
} from './scaffolder.js'

export interface WizardResult {
	repoRoot: string
	teamId: string
	agents: AgentTemplateName[]
	skipped: boolean
}

/**
 * Interactive setup wizard triggered when /fleet detects no .pi/teams.yaml.
 *
 * Calls preflightBootstrap in "bootstrap" mode (validates git repo and
 * shallow clone but allows missing config). Walks user through team creation
 * using ctx.ui methods.
 */
export async function runSetupWizard(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext
): Promise<WizardResult> {
	// Resolve repo root (bootstrap mode: git checks only, config can be missing)
	const { repoRoot } = await preflightBootstrap({ pi })

	// Detect partial state
	const state = await detectConfigState(repoRoot)

	if (state.hasTeamsYaml) {
		// Teams config already exists. This shouldn't normally happen since
		// the wizard is only triggered when teams.yaml is missing, but handle
		// the race condition gracefully.
		ctx.ui.notify('teams.yaml already exists. Skipping setup.', 'info')
		return { repoRoot, teamId: '', agents: [], skipped: true }
	}

	// Inform user about partial state if detected
	if (state.hasAgentsDir && state.agentFiles.length > 0) {
		ctx.ui.notify(
			`Found ${state.agentFiles.length} existing agent file(s) in .pi/agents/. ` +
				'The wizard will preserve them and only add missing templates.',
			'info'
		)
	}

	// Step 1: Team ID
	const teamId = await ctx.ui.input(
		'Choose a team ID (used as identifier in config):',
		'default'
	)

	if (!teamId) {
		ctx.ui.notify('Setup cancelled.', 'warning')
		return { repoRoot, teamId: '', agents: [], skipped: true }
	}

	// Step 2: Select agents
	const agentDescriptions: Record<AgentTemplateName, string> = {
		architect: 'Architect (Opus) - System design and technical decisions',
		developer: 'Developer (Sonnet) - Implementation and testing',
		reviewer: 'Reviewer (Opus) - Code review and security analysis',
		researcher: 'Researcher (Sonnet) - Codebase analysis and context gathering',
		qa: 'QA Engineer (Sonnet) - Test strategy and edge case discovery',
		devops: 'DevOps (Haiku) - Build systems and infrastructure',
	}

	// Present each agent as a confirm choice (pi UI may not have multi-select)
	const selectedAgents: AgentTemplateName[] = []

	const useAll = await ctx.ui.confirm(
		'Agent selection',
		'Use all 6 default agents? (Architect, Developer, Reviewer, Researcher, QA, DevOps)'
	)

	if (useAll) {
		selectedAgents.push(...AVAILABLE_AGENTS)
	} else {
		for (const agent of AVAILABLE_AGENTS) {
			const include = await ctx.ui.confirm(
				'Include agent',
				`Include ${agentDescriptions[agent]}?`
			)
			if (include) {
				selectedAgents.push(agent)
			}
		}
	}

	if (selectedAgents.length === 0) {
		ctx.ui.notify('No agents selected. You need at least one agent. Setup cancelled.', 'warning')
		return { repoRoot, teamId, agents: [], skipped: true }
	}

	// Step 3: Confirm and scaffold
	const confirmed = await ctx.ui.confirm(
		'Confirm setup',
		`Create team "${teamId}" with ${selectedAgents.length} agent(s): ${selectedAgents.join(', ')}?`
	)

	if (!confirmed) {
		ctx.ui.notify('Setup cancelled.', 'warning')
		return { repoRoot, teamId, agents: selectedAgents, skipped: true }
	}

	// Scaffold the config files
	const result = await scaffold({
		repoRoot,
		agents: selectedAgents,
		teamId,
	})

	ctx.ui.notify(
		`Setup complete. Created:\n` +
			`  - ${result.teamsYamlPath}\n` +
			`  - ${result.agentPaths.length} agent template(s)\n` +
			`  - ${result.chainYamlPath}\n` +
			'\nEdit these files to customize your team, then run /fleet again.',
		'info'
	)

	return { repoRoot, teamId, agents: selectedAgents, skipped: false }
}
