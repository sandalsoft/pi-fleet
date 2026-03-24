import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { composePrompt } from '../../src/dispatch/prompt-composer.js'
import type { AgentDefinition } from '../../src/config/schema.js'

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		id: 'developer',
		frontmatter: {
			name: 'developer',
			model: 'claude-sonnet-4-20250514',
			expertise: 'Full-stack TypeScript development',
		},
		body: 'You are a skilled developer. Write clean, tested code.',
		...overrides,
	}
}

describe('prompt-composer', () => {
	it('includes agent identity and body', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-prompt-'))

		const result = await composePrompt({
			agent: makeAgent(),
			taskBrief: 'Implement the login feature',
			repoRoot: tmpDir,
			scratchpadDir: path.join(tmpDir, '.pi', 'scratchpads'),
		})

		expect(result).toContain('# Agent: developer')
		expect(result).toContain('Full-stack TypeScript development')
		expect(result).toContain('You are a skilled developer')

		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it('includes task brief', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-prompt-'))

		const result = await composePrompt({
			agent: makeAgent(),
			taskBrief: 'Implement the login feature',
			repoRoot: tmpDir,
			scratchpadDir: path.join(tmpDir, '.pi', 'scratchpads'),
		})

		expect(result).toContain('# Your Task')
		expect(result).toContain('Implement the login feature')

		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it('includes scratchpad path', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-prompt-'))
		const scratchpadDir = path.join(tmpDir, '.pi', 'scratchpads')

		const result = await composePrompt({
			agent: makeAgent(),
			taskBrief: 'Do work',
			repoRoot: tmpDir,
			scratchpadDir,
		})

		expect(result).toContain('# Scratchpad')
		expect(result).toContain(path.join(scratchpadDir, 'developer.md'))

		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it('includes CLAUDE.md when present', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-prompt-'))
		await fs.writeFile(
			path.join(tmpDir, 'CLAUDE.md'),
			'# Project Rules\nUse tabs for indentation.'
		)

		const result = await composePrompt({
			agent: makeAgent(),
			taskBrief: 'Do work',
			repoRoot: tmpDir,
			scratchpadDir: path.join(tmpDir, '.pi', 'scratchpads'),
		})

		expect(result).toContain('# Project Instructions (CLAUDE.md)')
		expect(result).toContain('Use tabs for indentation')

		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it('skips CLAUDE.md when not present', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-prompt-'))

		const result = await composePrompt({
			agent: makeAgent(),
			taskBrief: 'Do work',
			repoRoot: tmpDir,
			scratchpadDir: path.join(tmpDir, '.pi', 'scratchpads'),
		})

		expect(result).not.toContain('# Project Instructions (CLAUDE.md)')

		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it('includes AGENTS.md when present', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-prompt-'))
		await fs.writeFile(
			path.join(tmpDir, 'AGENTS.md'),
			'# Agent Coordination\nUse scratchpads to communicate.'
		)

		const result = await composePrompt({
			agent: makeAgent(),
			taskBrief: 'Do work',
			repoRoot: tmpDir,
			scratchpadDir: path.join(tmpDir, '.pi', 'scratchpads'),
		})

		expect(result).toContain('# Agent Coordination (AGENTS.md)')
		expect(result).toContain('Use scratchpads to communicate')

		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it('skips AGENTS.md when not present', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-prompt-'))

		const result = await composePrompt({
			agent: makeAgent(),
			taskBrief: 'Do work',
			repoRoot: tmpDir,
			scratchpadDir: path.join(tmpDir, '.pi', 'scratchpads'),
		})

		expect(result).not.toContain('# Agent Coordination (AGENTS.md)')

		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it('handles agent with no expertise or body', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-prompt-'))

		const result = await composePrompt({
			agent: makeAgent({
				frontmatter: { name: 'minimal', model: 'claude-sonnet-4-20250514' },
				body: '',
			}),
			taskBrief: 'Do work',
			repoRoot: tmpDir,
			scratchpadDir: path.join(tmpDir, '.pi', 'scratchpads'),
		})

		expect(result).toContain('# Agent: minimal')
		expect(result).toContain('# Your Task')
		expect(result).not.toContain('Expertise:')

		await fs.rm(tmpDir, { recursive: true, force: true })
	})
})
