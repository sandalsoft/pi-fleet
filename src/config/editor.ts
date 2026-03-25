import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { AVAILABLE_AGENTS, type AgentTemplateName } from '../setup/scaffolder.js'

/**
 * Interactive fleet configuration editor.
 * Reads/writes .pi/teams.yaml, .pi/agents/*.md, .pi/agent-chain.yaml.
 */

interface ConfigEditorOpts {
	ctx: ExtensionCommandContext
	repoRoot: string
}

const SECTIONS = [
	'Team settings',
	'Constraints (budget, time, concurrency)',
	'Agent roster',
	'Chain pipeline',
	'View current config',
] as const

export async function runConfigEditor(opts: ConfigEditorOpts): Promise<void> {
	const { ctx, repoRoot } = opts
	const piDir = path.join(repoRoot, '.pi')

	while (true) {
		const choice = await ctx.ui.select(
			'Fleet Configuration',
			[...SECTIONS, 'Done'],
		)

		if (!choice || choice === 'Done') return

		switch (choice) {
			case 'Team settings':
				await editTeamSettings(ctx, piDir)
				break
			case 'Constraints (budget, time, concurrency)':
				await editConstraints(ctx, piDir)
				break
			case 'Agent roster':
				await editAgentRoster(ctx, piDir)
				break
			case 'Chain pipeline':
				await editChainPipeline(ctx, piDir)
				break
			case 'View current config':
				await viewCurrentConfig(ctx, piDir)
				break
		}
	}
}

// --- Team Settings ---

async function editTeamSettings(ctx: ExtensionCommandContext, piDir: string): Promise<void> {
	const teamsPath = path.join(piDir, 'teams.yaml')
	const config = await loadYaml(teamsPath)
	if (!config) {
		ctx.ui.notify('No teams.yaml found. Run /fleet first to scaffold config.', 'warning')
		return
	}

	const field = await ctx.ui.select('Edit team setting', [
		'team_id',
		'orchestrator model',
		'members',
		'Back',
	])

	if (!field || field === 'Back') return

	switch (field) {
		case 'team_id': {
			const current = String(config.team_id ?? 'default')
			const newVal = await ctx.ui.input(`Team ID (current: ${current}):`, current)
			if (newVal && newVal !== current) {
				config.team_id = newVal
				await saveYaml(teamsPath, config)
				ctx.ui.notify(`Team ID updated to "${newVal}".`, 'info')
			}
			break
		}
		case 'orchestrator model': {
			const orch = (config.orchestrator ?? {}) as Record<string, unknown>
			const current = String(orch.model ?? 'claude-sonnet-4-20250514')
			const newModel = await ctx.ui.select('Orchestrator model', [
				'claude-opus-4-20250514',
				'claude-sonnet-4-20250514',
				'claude-haiku-4-20250514',
			])
			if (newModel && newModel !== current) {
				orch.model = newModel
				config.orchestrator = orch
				await saveYaml(teamsPath, config)
				ctx.ui.notify(`Orchestrator model updated to "${newModel}".`, 'info')
			}
			break
		}
		case 'members': {
			await editMembers(ctx, piDir, config, teamsPath)
			break
		}
	}
}

async function editMembers(
	ctx: ExtensionCommandContext,
	piDir: string,
	config: Record<string, unknown>,
	teamsPath: string,
): Promise<void> {
	const currentMembers = (config.members as string[]) ?? []
	const agentsDir = path.join(piDir, 'agents')

	let availableAgents: string[] = []
	try {
		const files = await fs.readdir(agentsDir)
		availableAgents = files.filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', ''))
	} catch {
		ctx.ui.notify('No agents directory found.', 'warning')
		return
	}

	ctx.ui.notify(`Current members: ${currentMembers.join(', ') || '(none)'}`, 'info')

	const action = await ctx.ui.select('Members', [
		'Add agent to team',
		'Remove agent from team',
		'Back',
	])

	if (!action || action === 'Back') return

	if (action === 'Add agent to team') {
		const notInTeam = availableAgents.filter((a) => !currentMembers.includes(a))
		if (notInTeam.length === 0) {
			ctx.ui.notify('All available agents are already in the team.', 'info')
			return
		}
		const toAdd = await ctx.ui.select('Add agent', notInTeam)
		if (toAdd) {
			currentMembers.push(toAdd)
			config.members = currentMembers
			await saveYaml(teamsPath, config)
			ctx.ui.notify(`Added "${toAdd}" to team.`, 'info')
		}
	} else {
		if (currentMembers.length <= 1) {
			ctx.ui.notify('Cannot remove the last member.', 'warning')
			return
		}
		const toRemove = await ctx.ui.select('Remove agent', currentMembers)
		if (toRemove) {
			config.members = currentMembers.filter((m) => m !== toRemove)
			await saveYaml(teamsPath, config)
			ctx.ui.notify(`Removed "${toRemove}" from team.`, 'info')
		}
	}
}

// --- Constraints ---

async function editConstraints(ctx: ExtensionCommandContext, piDir: string): Promise<void> {
	const teamsPath = path.join(piDir, 'teams.yaml')
	const config = await loadYaml(teamsPath)
	if (!config) {
		ctx.ui.notify('No teams.yaml found.', 'warning')
		return
	}

	const constraints = (config.constraints ?? {}) as Record<string, unknown>

	const field = await ctx.ui.select('Edit constraint', [
		`Budget (max_usd: ${constraints.max_usd ?? 10})`,
		`Time limit (max_minutes: ${constraints.max_minutes ?? 30})`,
		`Task timeout (task_timeout_ms: ${constraints.task_timeout_ms ?? 120000})`,
		`Concurrency (max_concurrency: ${constraints.max_concurrency ?? 4})`,
		'Back',
	])

	if (!field || field === 'Back') return

	if (field.startsWith('Budget')) {
		const val = await ctx.ui.input('Max budget in USD:', String(constraints.max_usd ?? 10))
		const num = parseFloat(val ?? '')
		if (num > 0) {
			constraints.max_usd = num
			config.constraints = constraints
			await saveYaml(teamsPath, config)
			ctx.ui.notify(`Budget updated to $${num}.`, 'info')
		}
	} else if (field.startsWith('Time')) {
		const val = await ctx.ui.input('Max time in minutes:', String(constraints.max_minutes ?? 30))
		const num = parseFloat(val ?? '')
		if (num > 0) {
			constraints.max_minutes = num
			config.constraints = constraints
			await saveYaml(teamsPath, config)
			ctx.ui.notify(`Time limit updated to ${num} minutes.`, 'info')
		}
	} else if (field.startsWith('Task timeout')) {
		const val = await ctx.ui.input('Task timeout in ms:', String(constraints.task_timeout_ms ?? 120000))
		const num = parseInt(val ?? '', 10)
		if (num > 0) {
			constraints.task_timeout_ms = num
			config.constraints = constraints
			await saveYaml(teamsPath, config)
			ctx.ui.notify(`Task timeout updated to ${num}ms.`, 'info')
		}
	} else if (field.startsWith('Concurrency')) {
		const val = await ctx.ui.input('Max concurrent agents:', String(constraints.max_concurrency ?? 4))
		const num = parseInt(val ?? '', 10)
		if (num > 0) {
			constraints.max_concurrency = num
			config.constraints = constraints
			await saveYaml(teamsPath, config)
			ctx.ui.notify(`Concurrency updated to ${num}.`, 'info')
		}
	}
}

// --- Agent Roster ---

async function editAgentRoster(ctx: ExtensionCommandContext, piDir: string): Promise<void> {
	const agentsDir = path.join(piDir, 'agents')

	let existingAgents: string[] = []
	try {
		const files = await fs.readdir(agentsDir)
		existingAgents = files.filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', ''))
	} catch {
		// No agents directory
	}

	const action = await ctx.ui.select('Agent Roster', [
		'Edit existing agent',
		'Add new agent from template',
		'View agent details',
		'Back',
	])

	if (!action || action === 'Back') return

	if (action === 'View agent details') {
		if (existingAgents.length === 0) {
			ctx.ui.notify('No agents found.', 'info')
			return
		}
		const agent = await ctx.ui.select('View agent', existingAgents)
		if (agent) {
			const content = await fs.readFile(path.join(agentsDir, `${agent}.md`), 'utf-8')
			const preview = content.split('\n').slice(0, 15).join('\n')
			ctx.ui.notify(`--- ${agent}.md ---\n${preview}\n---`, 'info')
		}
	} else if (action === 'Edit existing agent') {
		if (existingAgents.length === 0) {
			ctx.ui.notify('No agents found.', 'info')
			return
		}
		const agent = await ctx.ui.select('Edit agent', existingAgents)
		if (agent) {
			await editAgentFrontmatter(ctx, path.join(agentsDir, `${agent}.md`))
		}
	} else if (action === 'Add new agent from template') {
		const notInstalled = AVAILABLE_AGENTS.filter((a) => !existingAgents.includes(a))
		if (notInstalled.length === 0) {
			ctx.ui.notify('All template agents are already installed.', 'info')
			return
		}
		const toAdd = await ctx.ui.select('Add agent template', [...notInstalled])
		if (toAdd) {
			const { scaffold } = await import('../setup/scaffolder.js')
			const repoRoot = path.resolve(piDir, '..')
			await scaffold({ repoRoot, agents: [toAdd as AgentTemplateName], teamId: 'default' })
			ctx.ui.notify(`Added "${toAdd}" agent template.`, 'info')
		}
	}
}

async function editAgentFrontmatter(ctx: ExtensionCommandContext, filePath: string): Promise<void> {
	const content = await fs.readFile(filePath, 'utf-8')

	// Parse front matter
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
	if (!fmMatch) {
		ctx.ui.notify('Agent file has no YAML front matter.', 'warning')
		return
	}

	const frontmatter = YAML.parse(fmMatch[1]) as Record<string, unknown>
	const body = fmMatch[2]

	const field = await ctx.ui.select('Edit agent field', [
		`name: ${frontmatter.name ?? '(not set)'}`,
		`model: ${frontmatter.model ?? '(not set)'}`,
		`thinking: ${frontmatter.thinking ?? '(not set)'}`,
		'Back',
	])

	if (!field || field === 'Back') return

	if (field.startsWith('name:')) {
		const val = await ctx.ui.input('Agent display name:', String(frontmatter.name ?? ''))
		if (val) {
			frontmatter.name = val
		}
	} else if (field.startsWith('model:')) {
		const val = await ctx.ui.select('Agent model', [
			'claude-opus-4-20250514',
			'claude-sonnet-4-20250514',
			'claude-haiku-4-20250514',
		])
		if (val) {
			frontmatter.model = val
		}
	} else if (field.startsWith('thinking:')) {
		const val = await ctx.ui.select('Thinking level', [
			'high',
			'medium',
			'low',
		])
		if (val) {
			frontmatter.thinking = val
		}
	}

	// Write back
	const newContent = `---\n${YAML.stringify(frontmatter).trim()}\n---\n${body}`
	await fs.writeFile(filePath, newContent, 'utf-8')
	ctx.ui.notify('Agent updated.', 'info')
}

// --- Chain Pipeline ---

async function editChainPipeline(ctx: ExtensionCommandContext, piDir: string): Promise<void> {
	const chainPath = path.join(piDir, 'agent-chain.yaml')
	const config = await loadYaml(chainPath)

	if (!config) {
		ctx.ui.notify('No agent-chain.yaml found.', 'warning')
		return
	}

	const steps = (config.steps as Array<Record<string, unknown>>) ?? []

	const action = await ctx.ui.select('Chain Pipeline', [
		`View pipeline (${steps.length} steps)`,
		'Edit step',
		'Add step',
		'Remove step',
		'Back',
	])

	if (!action || action === 'Back') return

	if (action.startsWith('View')) {
		const view = steps.map((s, i) => `  ${i + 1}. ${s.agent}`).join('\n')
		ctx.ui.notify(`Pipeline: ${config.name ?? 'unnamed'}\n${view || '  (empty)'}`, 'info')
	} else if (action === 'Edit step') {
		if (steps.length === 0) {
			ctx.ui.notify('No steps to edit.', 'info')
			return
		}
		const labels = steps.map((s, i) => `${i + 1}. ${s.agent}`)
		const selected = await ctx.ui.select('Edit step', labels)
		if (selected) {
			const idx = parseInt(selected, 10) - 1
			if (idx >= 0 && idx < steps.length) {
				const newPrompt = await ctx.ui.input(
					`Prompt for ${steps[idx].agent}:`,
					String(steps[idx].prompt ?? ''),
				)
				if (newPrompt !== undefined) {
					steps[idx].prompt = newPrompt
					config.steps = steps
					await saveYaml(chainPath, config)
					ctx.ui.notify('Step updated.', 'info')
				}
			}
		}
	} else if (action === 'Add step') {
		const agentsDir = path.join(piDir, 'agents')
		let available: string[] = []
		try {
			const files = await fs.readdir(agentsDir)
			available = files.filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', ''))
		} catch { /* empty */ }

		if (available.length === 0) {
			ctx.ui.notify('No agents available.', 'warning')
			return
		}

		const agent = await ctx.ui.select('Agent for new step', available)
		if (agent) {
			const prompt = await ctx.ui.input(`Prompt for ${agent}:`, '')
			steps.push({ agent, prompt: prompt ?? '' })
			config.steps = steps
			await saveYaml(chainPath, config)
			ctx.ui.notify(`Added step: ${agent}.`, 'info')
		}
	} else if (action === 'Remove step') {
		if (steps.length === 0) {
			ctx.ui.notify('No steps to remove.', 'info')
			return
		}
		const labels = steps.map((s, i) => `${i + 1}. ${s.agent}`)
		const selected = await ctx.ui.select('Remove step', labels)
		if (selected) {
			const idx = parseInt(selected, 10) - 1
			if (idx >= 0 && idx < steps.length) {
				steps.splice(idx, 1)
				config.steps = steps
				await saveYaml(chainPath, config)
				ctx.ui.notify('Step removed.', 'info')
			}
		}
	}
}

// --- View Config ---

async function viewCurrentConfig(ctx: ExtensionCommandContext, piDir: string): Promise<void> {
	const teamsPath = path.join(piDir, 'teams.yaml')
	const config = await loadYaml(teamsPath)

	if (!config) {
		ctx.ui.notify('No teams.yaml found. Run /fleet to scaffold.', 'info')
		return
	}

	const constraints = (config.constraints ?? {}) as Record<string, unknown>
	const members = (config.members as string[]) ?? []
	const orch = (config.orchestrator ?? {}) as Record<string, unknown>

	const summary = [
		`Team: ${config.team_id ?? 'default'}`,
		`Orchestrator: ${orch.model ?? '(not set)'}`,
		`Members: ${members.join(', ')}`,
		`Budget: $${constraints.max_usd ?? 10}`,
		`Time: ${constraints.max_minutes ?? 30}m`,
		`Timeout: ${constraints.task_timeout_ms ?? 120000}ms`,
		`Concurrency: ${constraints.max_concurrency ?? 4}`,
	].join('\n')

	ctx.ui.notify(summary, 'info')
}

// --- YAML helpers ---

async function loadYaml(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await fs.readFile(filePath, 'utf-8')
		return YAML.parse(raw) as Record<string, unknown>
	} catch {
		return null
	}
}

async function saveYaml(filePath: string, data: Record<string, unknown>): Promise<void> {
	const yaml = YAML.stringify(data, { lineWidth: 0 })
	await fs.writeFile(filePath, yaml, 'utf-8')
}
