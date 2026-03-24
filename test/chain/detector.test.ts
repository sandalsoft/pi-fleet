import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { hasChainConfig, detectFleetMode } from '../../src/chain/detector.js'
import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent'

async function makeTmpRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-chain-'))
	await fs.mkdir(path.join(dir, '.pi'), { recursive: true })
	return dir
}

function mockCtx(selectReturn?: string): ExtensionCommandContext {
	return {
		ui: {
			select: async () => selectReturn,
			confirm: async () => true,
			input: async () => '',
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingMessage: () => {},
		},
		sessionManager: {
			getEntries: async () => [],
		},
	} as unknown as ExtensionCommandContext
}

describe('detector', () => {
	describe('hasChainConfig', () => {
		it('returns true when agent-chain.yaml exists', async () => {
			const dir = await makeTmpRepo()
			await fs.writeFile(path.join(dir, '.pi', 'agent-chain.yaml'), 'name: test\nsteps: []')

			expect(await hasChainConfig(dir)).toBe(true)
			await fs.rm(dir, { recursive: true, force: true })
		})

		it('returns false when agent-chain.yaml is missing', async () => {
			const dir = await makeTmpRepo()
			expect(await hasChainConfig(dir)).toBe(false)
			await fs.rm(dir, { recursive: true, force: true })
		})

		it('returns false for nonexistent repo root', async () => {
			expect(await hasChainConfig('/no/such/path')).toBe(false)
		})
	})

	describe('detectFleetMode', () => {
		it('returns null when neither config exists', async () => {
			const dir = await makeTmpRepo()
			const result = await detectFleetMode(dir, mockCtx())
			expect(result).toBeNull()
			await fs.rm(dir, { recursive: true, force: true })
		})

		it('returns dispatcher when only teams.yaml exists', async () => {
			const dir = await makeTmpRepo()
			await fs.writeFile(path.join(dir, '.pi', 'teams.yaml'), 'team_id: test')

			const result = await detectFleetMode(dir, mockCtx())
			expect(result).toBe('dispatcher')
			await fs.rm(dir, { recursive: true, force: true })
		})

		it('returns chain when only agent-chain.yaml exists', async () => {
			const dir = await makeTmpRepo()
			await fs.writeFile(path.join(dir, '.pi', 'agent-chain.yaml'), 'name: test\nsteps: []')

			const result = await detectFleetMode(dir, mockCtx())
			expect(result).toBe('chain')
			await fs.rm(dir, { recursive: true, force: true })
		})

		it('prompts user when both configs exist and returns selection', async () => {
			const dir = await makeTmpRepo()
			await fs.writeFile(path.join(dir, '.pi', 'teams.yaml'), 'team_id: test')
			await fs.writeFile(path.join(dir, '.pi', 'agent-chain.yaml'), 'name: test\nsteps: []')

			const result = await detectFleetMode(dir, mockCtx('Chain mode (sequential pipeline)'))
			expect(result).toBe('chain')
			await fs.rm(dir, { recursive: true, force: true })
		})

		it('returns null when user cancels selection', async () => {
			const dir = await makeTmpRepo()
			await fs.writeFile(path.join(dir, '.pi', 'teams.yaml'), 'team_id: test')
			await fs.writeFile(path.join(dir, '.pi', 'agent-chain.yaml'), 'name: test\nsteps: []')

			const result = await detectFleetMode(dir, mockCtx(undefined))
			expect(result).toBeNull()
			await fs.rm(dir, { recursive: true, force: true })
		})
	})
})
