import fs from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { TeamSchema, type Team } from './schema.js'

export async function loadTeam(repoRoot: string): Promise<Team> {
	const filePath = path.join(repoRoot, '.pi', 'teams.yaml')

	let raw: string
	try {
		raw = await fs.readFile(filePath, 'utf-8')
	} catch {
		throw new Error(`Could not read teams config: ${filePath}`)
	}

	let parsed: unknown
	try {
		parsed = parseYaml(raw)
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		throw new Error(`Invalid YAML in ${filePath}: ${msg}`)
	}

	const result = TeamSchema.safeParse(parsed)
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
			.join('\n')
		throw new Error(`Invalid teams config in ${filePath}:\n${issues}`)
	}

	return result.data
}
