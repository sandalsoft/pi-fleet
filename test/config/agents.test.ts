import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadAgent, loadAllAgents } from '../../src/config/agents.js'
import fs from 'node:fs/promises'

vi.mock('node:fs/promises')
vi.mock('@mariozechner/pi-coding-agent', () => ({
	parseFrontmatter: (content: string) => {
		// Simple frontmatter parser for tests
		const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
		if (!match) return { frontmatter: {}, body: content }
		const lines = match[1].split('\n')
		const fm: Record<string, unknown> = {}
		for (const line of lines) {
			const [key, ...rest] = line.split(':')
			if (key && rest.length) {
				const val = rest.join(':').trim()
				if (val.startsWith('[')) {
					fm[key.trim()] = JSON.parse(val.replace(/'/g, '"'))
				} else {
					fm[key.trim()] = val
				}
			}
		}
		return { frontmatter: fm, body: match[2] }
	},
}))

const mockedFs = vi.mocked(fs)

const VALID_AGENT_MD = `---
name: Architect
model: claude-sonnet-4-20250514
skills: ['planning', 'design']
expertise: System architecture
thinking: high
---
You are a senior architect responsible for system design decisions.
`

describe('loadAgent', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('loads agent with correct id from filename stem', async () => {
		mockedFs.readFile.mockResolvedValue(VALID_AGENT_MD)
		const agent = await loadAgent('/repo', 'architect.md')
		expect(agent.id).toBe('architect')
	})

	it('parses frontmatter fields correctly', async () => {
		mockedFs.readFile.mockResolvedValue(VALID_AGENT_MD)
		const agent = await loadAgent('/repo', 'architect.md')
		expect(agent.frontmatter.name).toBe('Architect')
		expect(agent.frontmatter.model).toBe('claude-sonnet-4-20250514')
	})

	it('extracts body content', async () => {
		mockedFs.readFile.mockResolvedValue(VALID_AGENT_MD)
		const agent = await loadAgent('/repo', 'architect.md')
		expect(agent.body).toContain('senior architect')
	})

	it('reads from .pi/agents/ relative to repoRoot', async () => {
		mockedFs.readFile.mockResolvedValue(VALID_AGENT_MD)
		await loadAgent('/my/repo', 'dev.md')
		expect(mockedFs.readFile).toHaveBeenCalledWith(
			expect.stringContaining('.pi/agents/dev.md'),
			'utf-8'
		)
	})

	it('throws on missing file', async () => {
		mockedFs.readFile.mockRejectedValue(new Error('ENOENT'))
		await expect(loadAgent('/repo', 'missing.md')).rejects.toThrow('Could not read agent')
	})

	it('throws on invalid frontmatter (missing name)', async () => {
		const noName = `---\nmodel: sonnet\n---\nBody`
		mockedFs.readFile.mockResolvedValue(noName)
		await expect(loadAgent('/repo', 'bad.md')).rejects.toThrow('Invalid agent front matter')
	})
})

describe('loadAllAgents', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('returns empty array when agents dir missing', async () => {
		mockedFs.readdir.mockRejectedValue(new Error('ENOENT'))
		const agents = await loadAllAgents('/repo')
		expect(agents).toEqual([])
	})

	it('filters to .md files only', async () => {
		mockedFs.readdir.mockResolvedValue(['architect.md', 'readme.txt', 'dev.md'] as unknown as import('node:fs').Dirent[])
		mockedFs.readFile.mockResolvedValue(VALID_AGENT_MD)
		const agents = await loadAllAgents('/repo')
		expect(agents).toHaveLength(2)
	})
})
