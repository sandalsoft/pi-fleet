import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from '@mariozechner/pi-coding-agent'
import { AgentFrontmatterSchema, type AgentDefinition } from './schema.js'

export async function loadAgent(repoRoot: string, filename: string): Promise<AgentDefinition> {
	const filePath = path.join(repoRoot, '.pi', 'agents', filename)
	const id = path.basename(filename, '.md')

	let raw: string
	try {
		raw = await fs.readFile(filePath, 'utf-8')
	} catch {
		throw new Error(`Could not read agent definition: ${filePath}`)
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw)

	const result = AgentFrontmatterSchema.safeParse(frontmatter)
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
			.join('\n')
		throw new Error(`Invalid agent front matter in ${filePath}:\n${issues}`)
	}

	return { id, frontmatter: result.data, body }
}

export async function loadAllAgents(repoRoot: string): Promise<AgentDefinition[]> {
	const agentsDir = path.join(repoRoot, '.pi', 'agents')

	let entries: string[]
	try {
		entries = await fs.readdir(agentsDir)
	} catch {
		return []
	}

	const mdFiles = entries.filter((e) => e.endsWith('.md'))
	return Promise.all(mdFiles.map((f) => loadAgent(repoRoot, f)))
}
