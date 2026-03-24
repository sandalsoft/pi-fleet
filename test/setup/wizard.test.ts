import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { parse as parseYaml } from 'yaml'
import { runSetupWizard } from '../../src/setup/wizard.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'

let tmpDir: string

function mockPi(repoRoot: string): ExtensionAPI {
	return {
		exec: vi.fn(async (cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-dir') {
				return { stdout: '.git\n', code: 0 }
			}
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
				return { stdout: 'false\n', code: 0 }
			}
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
				return { stdout: repoRoot + '\n', code: 0 }
			}
			return { stdout: '', code: 1 }
		}),
	} as unknown as ExtensionAPI
}

interface MockUiOptions {
	inputValues?: Record<string, string>
	confirmValues?: Record<string, boolean>
}

function mockCtx(opts: MockUiOptions = {}): ExtensionCommandContext {
	const { inputValues = {}, confirmValues = {} } = opts

	const inputCalls: string[] = []
	const confirmCalls: string[] = []
	const notifications: Array<{ msg: string; level: string }> = []

	return {
		ui: {
			input: vi.fn(async (title: string, _desc: string, defaultVal?: string) => {
				inputCalls.push(title)
				return inputValues[title] ?? defaultVal ?? ''
			}),
			confirm: vi.fn(async (title: string) => {
				confirmCalls.push(title)
				return confirmValues[title] ?? false
			}),
			notify: vi.fn((msg: string, level: string) => {
				notifications.push({ msg, level })
			}),
			select: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			setWorkingMessage: vi.fn(),
		},
		_inputCalls: inputCalls,
		_confirmCalls: confirmCalls,
		_notifications: notifications,
	} as unknown as ExtensionCommandContext & {
		_inputCalls: string[]
		_confirmCalls: string[]
		_notifications: Array<{ msg: string; level: string }>
	}
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-wizard-'))
})

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('runSetupWizard', () => {
	it('creates config when user selects all agents', async () => {
		const pi = mockPi(tmpDir)
		const ctx = mockCtx({
			inputValues: { 'Team ID': 'test-team' },
			confirmValues: {
				'Agent selection': true, // use all agents
				'Confirm setup': true,
			},
		})

		const result = await runSetupWizard(pi, ctx)

		expect(result.skipped).toBe(false)
		expect(result.teamId).toBe('test-team')
		expect(result.agents).toHaveLength(6)

		// Verify files were created
		const teamsRaw = await fs.readFile(path.join(tmpDir, '.pi', 'teams.yaml'), 'utf-8')
		const teams = parseYaml(teamsRaw)
		expect(teams.team_id).toBe('test-team')
		expect(teams.members).toHaveLength(6)
	})

	it('creates config with a subset of agents', async () => {
		const pi = mockPi(tmpDir)
		const ctx = mockCtx({
			inputValues: { 'Team ID': 'small-team' },
			confirmValues: {
				'Agent selection': false, // don't use all
				// Individual agent confirms - only architect and developer
				'Include agent': false, // first call gets the default false
				'Confirm setup': true,
			},
		})

		// Override confirm to selectively include agents
		let confirmCallCount = 0
		;(ctx.ui.confirm as ReturnType<typeof vi.fn>).mockImplementation(
			async (title: string) => {
				confirmCallCount++
				if (title === 'Agent selection') return false
				if (title === 'Include agent') {
					// Include architect (1st) and developer (2nd), skip rest
					return confirmCallCount <= 3
				}
				if (title === 'Confirm setup') return true
				return false
			}
		)

		const result = await runSetupWizard(pi, ctx)

		expect(result.skipped).toBe(false)
		expect(result.agents).toEqual(['architect', 'developer'])
	})

	it('returns skipped when user cancels at team ID', async () => {
		const pi = mockPi(tmpDir)
		const ctx = mockCtx({
			inputValues: { 'Team ID': '' }, // empty = cancel
		})

		const result = await runSetupWizard(pi, ctx)
		expect(result.skipped).toBe(true)
	})

	it('returns skipped when no agents are selected', async () => {
		const pi = mockPi(tmpDir)
		const ctx = mockCtx({
			inputValues: { 'Team ID': 'test' },
			confirmValues: {
				'Agent selection': false,
				'Include agent': false,
			},
		})

		const result = await runSetupWizard(pi, ctx)
		expect(result.skipped).toBe(true)
	})

	it('returns skipped when user declines confirmation', async () => {
		const pi = mockPi(tmpDir)
		const ctx = mockCtx({
			inputValues: { 'Team ID': 'test' },
			confirmValues: {
				'Agent selection': true,
				'Confirm setup': false,
			},
		})

		const result = await runSetupWizard(pi, ctx)
		expect(result.skipped).toBe(true)
	})

	it('returns skipped when teams.yaml already exists', async () => {
		const piDir = path.join(tmpDir, '.pi')
		await fs.mkdir(piDir, { recursive: true })
		await fs.writeFile(path.join(piDir, 'teams.yaml'), 'team_id: existing\n')

		const pi = mockPi(tmpDir)
		const ctx = mockCtx()

		const result = await runSetupWizard(pi, ctx)
		expect(result.skipped).toBe(true)
	})

	it('preserves existing agent files during setup', async () => {
		const agentsDir = path.join(tmpDir, '.pi', 'agents')
		await fs.mkdir(agentsDir, { recursive: true })

		const customContent = '---\nname: My Architect\nmodel: opus\n---\nCustom.'
		await fs.writeFile(path.join(agentsDir, 'architect.md'), customContent)

		const pi = mockPi(tmpDir)
		const ctx = mockCtx({
			inputValues: { 'Team ID': 'test' },
			confirmValues: {
				'Agent selection': true,
				'Confirm setup': true,
			},
		})

		await runSetupWizard(pi, ctx)

		// Custom architect should be preserved
		const preserved = await fs.readFile(path.join(agentsDir, 'architect.md'), 'utf-8')
		expect(preserved).toBe(customContent)

		// Notification should mention existing files
		const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls
		const partialStateNotice = notifyCalls.find(
			(c: [string, string]) => typeof c[0] === 'string' && c[0].includes('existing agent file')
		)
		expect(partialStateNotice).toBeDefined()
	})
})
