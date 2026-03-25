import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Resolve the templates directory (works from both src/ and dist/) */
function templatesDir(): string {
	// When bundled by esbuild into dist/extension.js, __dirname = dist/.
	// Templates are copied to dist/templates/ at build time.
	const bundled = path.resolve(__dirname, 'templates')
	if (fsSync.existsSync(bundled)) return bundled

	// When running from source (vitest), __dirname = src/setup/.
	return path.resolve(__dirname, '..', '..', 'templates')
}

export const AVAILABLE_AGENTS = [
	'architect',
	'developer',
	'reviewer',
	'researcher',
	'qa',
	'devops',
] as const

export type AgentTemplateName = (typeof AVAILABLE_AGENTS)[number]

export interface ScaffoldOptions {
	repoRoot: string
	agents: AgentTemplateName[]
	teamId?: string
}

export interface ScaffoldResult {
	teamsYamlPath: string
	agentPaths: string[]
	chainYamlPath: string
}

/**
 * Detect which config pieces already exist.
 * Returns flags for partial-state handling.
 */
export async function detectConfigState(repoRoot: string): Promise<{
	hasTeamsYaml: boolean
	hasAgentsDir: boolean
	agentFiles: string[]
	hasChainYaml: boolean
}> {
	const piDir = path.join(repoRoot, '.pi')
	const agentsDir = path.join(piDir, 'agents')

	let hasTeamsYaml = false
	try {
		await fs.access(path.join(piDir, 'teams.yaml'))
		hasTeamsYaml = true
	} catch {
		// missing
	}

	let hasAgentsDir = false
	let agentFiles: string[] = []
	try {
		const entries = await fs.readdir(agentsDir)
		hasAgentsDir = true
		agentFiles = entries.filter((e) => e.endsWith('.md'))
	} catch {
		// missing
	}

	let hasChainYaml = false
	try {
		await fs.access(path.join(piDir, 'agent-chain.yaml'))
		hasChainYaml = true
	} catch {
		// missing
	}

	return { hasTeamsYaml, hasAgentsDir, agentFiles, hasChainYaml }
}

/**
 * Scaffold .pi/ config from templates.
 * Creates directories as needed; does not overwrite existing files.
 */
export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
	const { repoRoot, agents, teamId = 'default' } = opts
	const piDir = path.join(repoRoot, '.pi')
	const agentsDir = path.join(piDir, 'agents')
	const scratchpadsDir = path.join(piDir, 'scratchpads')
	const tplDir = templatesDir()

	// Ensure directories exist
	await fs.mkdir(agentsDir, { recursive: true })
	await fs.mkdir(scratchpadsDir, { recursive: true })

	// Copy selected agent templates
	const agentPaths: string[] = []
	for (const agentName of agents) {
		const src = path.join(tplDir, 'agents', `${agentName}.md`)
		const dest = path.join(agentsDir, `${agentName}.md`)

		// Skip if already exists (preserve user customizations)
		try {
			await fs.access(dest)
			agentPaths.push(dest)
			continue
		} catch {
			// Does not exist, will copy
		}

		const content = await fs.readFile(src, 'utf-8')
		await fs.writeFile(dest, content, 'utf-8')
		agentPaths.push(dest)
	}

	// Generate teams.yaml from template, substituting team_id and members
	const teamsYamlPath = path.join(piDir, 'teams.yaml')
	let writeTeams = true
	try {
		await fs.access(teamsYamlPath)
		writeTeams = false // Don't overwrite existing
	} catch {
		// Missing, will create
	}

	if (writeTeams) {
		const teamsTemplate = await fs.readFile(path.join(tplDir, 'teams.yaml'), 'utf-8')
		// Replace team_id and members list with user's selections
		const membersYaml = agents.map((a) => `  - ${a}`).join('\n')
		const customized = teamsTemplate
			.replace(/^team_id: .+$/m, `team_id: ${teamId}`)
			.replace(/^members:\n((?:  - .+\n?)+)/m, `members:\n${membersYaml}\n`)
		await fs.writeFile(teamsYamlPath, customized, 'utf-8')
	}

	// Copy agent-chain.yaml template
	const chainYamlPath = path.join(piDir, 'agent-chain.yaml')
	let writeChain = true
	try {
		await fs.access(chainYamlPath)
		writeChain = false
	} catch {
		// Missing
	}

	if (writeChain) {
		const chainTemplate = await fs.readFile(path.join(tplDir, 'agent-chain.yaml'), 'utf-8')
		await fs.writeFile(chainYamlPath, chainTemplate, 'utf-8')
	}

	return { teamsYamlPath, agentPaths, chainYamlPath }
}
