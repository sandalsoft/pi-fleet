import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentDefinition } from '../config/schema.js'

export interface PromptComposerOpts {
	agent: AgentDefinition
	taskBrief: string
	repoRoot: string
	scratchpadDir: string
}

/**
 * Build the full system prompt for a specialist agent.
 *
 * Composes from:
 * 1. Agent definition body (the markdown content after frontmatter)
 * 2. Repo-root CLAUDE.md content (best-effort: if missing, skip)
 * 3. Repo-root AGENTS.md content (best-effort: if missing, skip; only repo-root)
 * 4. Task brief from the dispatcher
 * 5. Scratchpad instructions with absolute path
 */
export async function composePrompt(opts: PromptComposerOpts): Promise<string> {
	const { agent, taskBrief, repoRoot, scratchpadDir } = opts

	const sections: string[] = []

	// 1. Agent identity and instructions
	sections.push(`# Agent: ${agent.frontmatter.name}`)
	if (agent.frontmatter.expertise) {
		sections.push(`Expertise: ${agent.frontmatter.expertise}`)
	}
	if (agent.body.trim()) {
		sections.push(agent.body.trim())
	}

	// 2. Repo-root CLAUDE.md (best-effort)
	const claudeMd = await readFileSafe(path.join(repoRoot, 'CLAUDE.md'))
	if (claudeMd) {
		sections.push('# Project Instructions (CLAUDE.md)\n')
		sections.push(claudeMd)
	}

	// 3. Repo-root AGENTS.md (best-effort, repo-root only)
	const agentsMd = await readFileSafe(path.join(repoRoot, 'AGENTS.md'))
	if (agentsMd) {
		sections.push('# Agent Coordination (AGENTS.md)\n')
		sections.push(agentsMd)
	}

	// 4. Task brief
	sections.push('# Your Task\n')
	sections.push(taskBrief)

	// 5. Scratchpad (use agent.id — filename stem — not display name, so it matches /fleet-steer writes)
	const scratchpadPath = path.join(scratchpadDir, `${agent.id}.md`)
	sections.push('# Scratchpad\n')
	sections.push(
		`Write your working notes, intermediate findings, and status updates to: ${scratchpadPath}`
	)
	sections.push(
		'Update the scratchpad as you work so other agents and the orchestrator can track your progress.'
	)

	return sections.join('\n\n')
}

/**
 * Read a file, returning null if it doesn't exist or can't be read.
 */
async function readFileSafe(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf-8')
	} catch {
		return null
	}
}
