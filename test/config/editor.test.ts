import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runConfigEditor } from '../../src/config/editor.js'
import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'

function makeMockCtx() {
	const ui = {
		input: vi.fn(),
		select: vi.fn(),
		confirm: vi.fn(),
		notify: vi.fn(),
		setStatus: vi.fn(),
		setWidget: vi.fn(),
		setWorkingMessage: vi.fn(),
	}
	return { ctx: { ui } as unknown as ExtensionCommandContext, ui }
}

async function scaffoldConfig(repoRoot: string) {
	const piDir = path.join(repoRoot, '.pi')
	const agentsDir = path.join(piDir, 'agents')
	await fs.mkdir(agentsDir, { recursive: true })

	await fs.writeFile(path.join(piDir, 'teams.yaml'), YAML.stringify({
		team_id: 'default',
		orchestrator: { model: 'claude-sonnet-4-20250514', skills: [] },
		members: ['developer', 'reviewer'],
		constraints: { max_usd: 10, max_minutes: 30, task_timeout_ms: 120000, max_concurrency: 4 },
	}))

	await fs.writeFile(path.join(agentsDir, 'developer.md'), [
		'---',
		'name: Developer',
		'model: claude-sonnet-4-20250514',
		'thinking: medium',
		'---',
		'You are a developer.',
	].join('\n'))

	await fs.writeFile(path.join(agentsDir, 'reviewer.md'), [
		'---',
		'name: Reviewer',
		'model: claude-opus-4-20250514',
		'thinking: high',
		'---',
		'You are a reviewer.',
	].join('\n'))

	await fs.writeFile(path.join(piDir, 'agent-chain.yaml'), YAML.stringify({
		name: 'default-chain',
		steps: [
			{ agent: 'developer', prompt: 'Build $INPUT' },
			{ agent: 'reviewer', prompt: 'Review changes' },
		],
	}))
}

describe('runConfigEditor', () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-config-'))
		await scaffoldConfig(tmpDir)
	})

	it('exits when user selects Done', async () => {
		const { ctx, ui } = makeMockCtx()
		ui.select.mockResolvedValueOnce('Done')

		await runConfigEditor({ ctx, repoRoot: tmpDir })

		expect(ui.select).toHaveBeenCalledTimes(1)
	})

	it('exits when user cancels', async () => {
		const { ctx, ui } = makeMockCtx()
		ui.select.mockResolvedValueOnce(undefined)

		await runConfigEditor({ ctx, repoRoot: tmpDir })

		expect(ui.select).toHaveBeenCalledTimes(1)
	})

	it('shows current config via View', async () => {
		const { ctx, ui } = makeMockCtx()
		ui.select
			.mockResolvedValueOnce('View current config')
			.mockResolvedValueOnce('Done')

		await runConfigEditor({ ctx, repoRoot: tmpDir })

		const notifyCall = ui.notify.mock.calls.find(
			(c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('Team: default')
		)
		expect(notifyCall).toBeDefined()
	})

	it('edits budget constraint', async () => {
		const { ctx, ui } = makeMockCtx()
		ui.select
			.mockResolvedValueOnce('Constraints (budget, time, concurrency)')
			.mockResolvedValueOnce('Budget (max_usd: 10)')
			.mockResolvedValueOnce('Done')
		ui.input.mockResolvedValueOnce('25')

		await runConfigEditor({ ctx, repoRoot: tmpDir })

		// Verify file was updated
		const raw = await fs.readFile(path.join(tmpDir, '.pi', 'teams.yaml'), 'utf-8')
		const config = YAML.parse(raw)
		expect(config.constraints.max_usd).toBe(25)
	})

	it('edits concurrency constraint', async () => {
		const { ctx, ui } = makeMockCtx()
		ui.select
			.mockResolvedValueOnce('Constraints (budget, time, concurrency)')
			.mockResolvedValueOnce('Concurrency (max_concurrency: 4)')
			.mockResolvedValueOnce('Done')
		ui.input.mockResolvedValueOnce('8')

		await runConfigEditor({ ctx, repoRoot: tmpDir })

		const raw = await fs.readFile(path.join(tmpDir, '.pi', 'teams.yaml'), 'utf-8')
		const config = YAML.parse(raw)
		expect(config.constraints.max_concurrency).toBe(8)
	})

	it('edits team_id', async () => {
		const { ctx, ui } = makeMockCtx()
		ui.select
			.mockResolvedValueOnce('Team settings')
			.mockResolvedValueOnce('team_id')
			.mockResolvedValueOnce('Done')
		ui.input.mockResolvedValueOnce('my-team')

		await runConfigEditor({ ctx, repoRoot: tmpDir })

		const raw = await fs.readFile(path.join(tmpDir, '.pi', 'teams.yaml'), 'utf-8')
		const config = YAML.parse(raw)
		expect(config.team_id).toBe('my-team')
	})

	it('edits agent model', async () => {
		const { ctx, ui } = makeMockCtx()
		ui.select
			.mockResolvedValueOnce('Agent roster')
			.mockResolvedValueOnce('Edit existing agent')
			.mockResolvedValueOnce('developer')
			.mockResolvedValueOnce('model: claude-sonnet-4-20250514')
			.mockResolvedValueOnce('claude-opus-4-20250514')
			.mockResolvedValueOnce('Done')

		await runConfigEditor({ ctx, repoRoot: tmpDir })

		const content = await fs.readFile(path.join(tmpDir, '.pi', 'agents', 'developer.md'), 'utf-8')
		expect(content).toContain('claude-opus-4-20250514')
	})

	it('views chain pipeline', async () => {
		const { ctx, ui } = makeMockCtx()
		ui.select
			.mockResolvedValueOnce('Chain pipeline')
			.mockResolvedValueOnce('View pipeline (2 steps)')
			.mockResolvedValueOnce('Done')

		await runConfigEditor({ ctx, repoRoot: tmpDir })

		const viewCall = ui.notify.mock.calls.find(
			(c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('developer')
		)
		expect(viewCall).toBeDefined()
	})
})
