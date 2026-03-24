import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parse as parseYaml } from 'yaml'
import { parseFrontmatter } from '@mariozechner/pi-coding-agent'
import {
	AVAILABLE_AGENTS,
	detectConfigState,
	scaffold,
	type AgentTemplateName,
} from '../../src/setup/scaffolder.js'
import {
	AgentFrontmatterSchema,
	TeamSchema,
	ChainSchema,
} from '../../src/config/schema.js'

let tmpDir: string

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-scaffold-'))
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AVAILABLE_AGENTS', () => {
	it('contains all 6 expected agents', () => {
		expect(AVAILABLE_AGENTS).toEqual([
			'architect',
			'developer',
			'reviewer',
			'researcher',
			'qa',
			'devops',
		])
	})
})

describe('detectConfigState', () => {
	it('detects empty state when .pi/ does not exist', async () => {
		const state = await detectConfigState(tmpDir)
		expect(state.hasTeamsYaml).toBe(false)
		expect(state.hasAgentsDir).toBe(false)
		expect(state.agentFiles).toEqual([])
		expect(state.hasChainYaml).toBe(false)
	})

	it('detects teams.yaml without agents', async () => {
		const piDir = path.join(tmpDir, '.pi')
		await fs.mkdir(piDir, { recursive: true })
		await fs.writeFile(path.join(piDir, 'teams.yaml'), 'team_id: test\n')

		const state = await detectConfigState(tmpDir)
		expect(state.hasTeamsYaml).toBe(true)
		expect(state.hasAgentsDir).toBe(false)
	})

	it('detects agents without teams.yaml', async () => {
		const agentsDir = path.join(tmpDir, '.pi', 'agents')
		await fs.mkdir(agentsDir, { recursive: true })
		await fs.writeFile(path.join(agentsDir, 'developer.md'), '---\nname: Dev\nmodel: sonnet\n---\n')

		const state = await detectConfigState(tmpDir)
		expect(state.hasTeamsYaml).toBe(false)
		expect(state.hasAgentsDir).toBe(true)
		expect(state.agentFiles).toEqual(['developer.md'])
	})

	it('detects complete state', async () => {
		const piDir = path.join(tmpDir, '.pi')
		const agentsDir = path.join(piDir, 'agents')
		await fs.mkdir(agentsDir, { recursive: true })
		await fs.writeFile(path.join(piDir, 'teams.yaml'), 'team_id: test\n')
		await fs.writeFile(path.join(piDir, 'agent-chain.yaml'), 'name: test\n')
		await fs.writeFile(path.join(agentsDir, 'arch.md'), '---\n---\n')

		const state = await detectConfigState(tmpDir)
		expect(state.hasTeamsYaml).toBe(true)
		expect(state.hasAgentsDir).toBe(true)
		expect(state.agentFiles).toEqual(['arch.md'])
		expect(state.hasChainYaml).toBe(true)
	})
})

describe('scaffold', () => {
	it('creates .pi/ directory structure with all agents', async () => {
		const result = await scaffold({
			repoRoot: tmpDir,
			agents: [...AVAILABLE_AGENTS],
		})

		expect(result.agentPaths).toHaveLength(6)
		expect(result.teamsYamlPath).toBe(path.join(tmpDir, '.pi', 'teams.yaml'))
		expect(result.chainYamlPath).toBe(path.join(tmpDir, '.pi', 'agent-chain.yaml'))

		// Verify all files exist
		for (const p of result.agentPaths) {
			await expect(fs.access(p)).resolves.toBeUndefined()
		}
		await expect(fs.access(result.teamsYamlPath)).resolves.toBeUndefined()
		await expect(fs.access(result.chainYamlPath)).resolves.toBeUndefined()
	})

	it('creates scratchpads directory', async () => {
		await scaffold({ repoRoot: tmpDir, agents: ['developer'] })
		const scratchpadsDir = path.join(tmpDir, '.pi', 'scratchpads')
		await expect(fs.access(scratchpadsDir)).resolves.toBeUndefined()
	})

	it('creates a subset of agents when not all are selected', async () => {
		const selected: AgentTemplateName[] = ['architect', 'developer']
		const result = await scaffold({ repoRoot: tmpDir, agents: selected })

		expect(result.agentPaths).toHaveLength(2)

		// Only selected agents should exist
		const agentsDir = path.join(tmpDir, '.pi', 'agents')
		const entries = await fs.readdir(agentsDir)
		expect(entries.sort()).toEqual(['architect.md', 'developer.md'])
	})

	it('uses custom team_id in teams.yaml', async () => {
		await scaffold({ repoRoot: tmpDir, agents: ['developer'], teamId: 'my-team' })

		const raw = await fs.readFile(path.join(tmpDir, '.pi', 'teams.yaml'), 'utf-8')
		const parsed = parseYaml(raw)
		expect(parsed.team_id).toBe('my-team')
	})

	it('teams.yaml only includes selected agents as members', async () => {
		const selected: AgentTemplateName[] = ['architect', 'reviewer']
		await scaffold({ repoRoot: tmpDir, agents: selected })

		const raw = await fs.readFile(path.join(tmpDir, '.pi', 'teams.yaml'), 'utf-8')
		const parsed = parseYaml(raw)
		expect(parsed.members).toEqual(['architect', 'reviewer'])
	})

	it('does not overwrite existing agent files', async () => {
		const agentsDir = path.join(tmpDir, '.pi', 'agents')
		await fs.mkdir(agentsDir, { recursive: true })

		const customContent = '---\nname: Custom Architect\nmodel: custom-model\n---\nMy custom agent.'
		await fs.writeFile(path.join(agentsDir, 'architect.md'), customContent)

		await scaffold({ repoRoot: tmpDir, agents: ['architect', 'developer'] })

		// architect.md should retain custom content
		const preserved = await fs.readFile(path.join(agentsDir, 'architect.md'), 'utf-8')
		expect(preserved).toBe(customContent)

		// developer.md should be the template
		const dev = await fs.readFile(path.join(agentsDir, 'developer.md'), 'utf-8')
		expect(dev).toContain('Full-stack implementation')
	})

	it('does not overwrite existing teams.yaml', async () => {
		const piDir = path.join(tmpDir, '.pi')
		await fs.mkdir(piDir, { recursive: true })

		const customTeams = 'team_id: existing\nmembers:\n  - custom\n'
		await fs.writeFile(path.join(piDir, 'teams.yaml'), customTeams)

		await scaffold({ repoRoot: tmpDir, agents: ['developer'] })

		const preserved = await fs.readFile(path.join(piDir, 'teams.yaml'), 'utf-8')
		expect(preserved).toBe(customTeams)
	})

	it('does not overwrite existing agent-chain.yaml', async () => {
		const piDir = path.join(tmpDir, '.pi')
		await fs.mkdir(piDir, { recursive: true })

		const customChain = 'name: custom-chain\nsteps:\n  - agent: custom\n'
		await fs.writeFile(path.join(piDir, 'agent-chain.yaml'), customChain)

		await scaffold({ repoRoot: tmpDir, agents: ['developer'] })

		const preserved = await fs.readFile(path.join(piDir, 'agent-chain.yaml'), 'utf-8')
		expect(preserved).toBe(customChain)
	})
})

describe('agent template front matter validates against Zod schemas', () => {
	for (const agentName of AVAILABLE_AGENTS) {
		it(`${agentName}.md has valid front matter`, async () => {
			await scaffold({ repoRoot: tmpDir, agents: [agentName] })

			const content = await fs.readFile(
				path.join(tmpDir, '.pi', 'agents', `${agentName}.md`),
				'utf-8'
			)
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content)

			const result = AgentFrontmatterSchema.safeParse(frontmatter)
			expect(result.success, `${agentName} front matter validation failed: ${
				!result.success ? result.error.issues.map((i) => i.message).join(', ') : ''
			}`).toBe(true)

			// Verify required fields are present and non-empty
			if (result.success) {
				expect(result.data.name.length).toBeGreaterThan(0)
				expect(result.data.model.length).toBeGreaterThan(0)
			}

			// Body should have meaningful content
			expect(body.trim().length).toBeGreaterThan(100)
		})
	}
})

describe('template teams.yaml validates against TeamSchema', () => {
	it('default template passes Zod validation', async () => {
		await scaffold({ repoRoot: tmpDir, agents: [...AVAILABLE_AGENTS] })

		const raw = await fs.readFile(path.join(tmpDir, '.pi', 'teams.yaml'), 'utf-8')
		const parsed = parseYaml(raw)
		const result = TeamSchema.safeParse(parsed)

		expect(result.success, `teams.yaml validation failed: ${
			!result.success ? result.error.issues.map((i) => i.message).join(', ') : ''
		}`).toBe(true)

		if (result.success) {
			expect(result.data.teamId).toBe('default')
			expect(result.data.members).toHaveLength(6)
			expect(result.data.constraints.maxUsd).toBe(10)
			expect(result.data.constraints.maxMinutes).toBe(30)
			expect(result.data.constraints.taskTimeoutMs).toBe(120000)
			expect(result.data.constraints.maxConcurrency).toBe(4)
		}
	})

	it('subset template passes Zod validation', async () => {
		await scaffold({ repoRoot: tmpDir, agents: ['developer', 'reviewer'], teamId: 'small-team' })

		const raw = await fs.readFile(path.join(tmpDir, '.pi', 'teams.yaml'), 'utf-8')
		const parsed = parseYaml(raw)
		const result = TeamSchema.safeParse(parsed)

		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.teamId).toBe('small-team')
			expect(result.data.members).toEqual(['developer', 'reviewer'])
		}
	})
})

describe('template agent-chain.yaml validates against ChainSchema', () => {
	it('default template passes Zod validation', async () => {
		await scaffold({ repoRoot: tmpDir, agents: [...AVAILABLE_AGENTS] })

		const raw = await fs.readFile(path.join(tmpDir, '.pi', 'agent-chain.yaml'), 'utf-8')
		const parsed = parseYaml(raw)
		const result = ChainSchema.safeParse(parsed)

		expect(result.success, `agent-chain.yaml validation failed: ${
			!result.success ? result.error.issues.map((i) => i.message).join(', ') : ''
		}`).toBe(true)

		if (result.success) {
			expect(result.data.name).toBe('research-build-review')
			expect(result.data.steps.length).toBeGreaterThanOrEqual(2)
		}
	})
})

describe('agent templates include scratchpad instructions', () => {
	for (const agentName of AVAILABLE_AGENTS) {
		it(`${agentName}.md mentions scratchpad path`, async () => {
			await scaffold({ repoRoot: tmpDir, agents: [agentName] })

			const content = await fs.readFile(
				path.join(tmpDir, '.pi', 'agents', `${agentName}.md`),
				'utf-8'
			)

			expect(content).toContain('.pi/scratchpads/')
			expect(content).toContain(`${agentName}.md`)
		})
	}
})

describe('agent templates use skills plural (string[])', () => {
	for (const agentName of AVAILABLE_AGENTS) {
		it(`${agentName}.md uses skills array in front matter`, async () => {
			await scaffold({ repoRoot: tmpDir, agents: [agentName] })

			const content = await fs.readFile(
				path.join(tmpDir, '.pi', 'agents', `${agentName}.md`),
				'utf-8'
			)
			const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content)

			// skills should be present and be an array
			expect(frontmatter).toHaveProperty('skills')
			expect(Array.isArray(frontmatter.skills)).toBe(true)
			expect((frontmatter.skills as string[]).length).toBeGreaterThan(0)
		})
	}
})
