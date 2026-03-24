import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadChain } from '../../src/config/chains.js'
import fs from 'node:fs/promises'

vi.mock('node:fs/promises')

const mockedFs = vi.mocked(fs)

const VALID_CHAIN_YAML = `
name: review-pipeline
steps:
  - agent: architect
    prompt: Review the high-level design
  - agent: developer
  - agent: reviewer
    prompt: Final review pass
`

describe('loadChain', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('loads a valid chain config', async () => {
		mockedFs.readFile.mockResolvedValue(VALID_CHAIN_YAML)
		const chain = await loadChain('/repo')
		expect(chain.name).toBe('review-pipeline')
		expect(chain.steps).toHaveLength(3)
		expect(chain.steps[0].agent).toBe('architect')
		expect(chain.steps[0].prompt).toBe('Review the high-level design')
		expect(chain.steps[1].prompt).toBeUndefined()
	})

	it('reads from .pi/agent-chain.yaml (canonical path)', async () => {
		mockedFs.readFile.mockResolvedValue(VALID_CHAIN_YAML)
		await loadChain('/my/repo')
		expect(mockedFs.readFile).toHaveBeenCalledWith(
			expect.stringContaining('.pi/agent-chain.yaml'),
			'utf-8'
		)
	})

	it('throws on missing file', async () => {
		mockedFs.readFile.mockRejectedValue(new Error('ENOENT'))
		await expect(loadChain('/repo')).rejects.toThrow('Could not read chain config')
	})

	it('throws on invalid YAML', async () => {
		mockedFs.readFile.mockResolvedValue('{{{{ bad yaml')
		await expect(loadChain('/repo')).rejects.toThrow('Invalid YAML')
	})

	it('throws on schema failure (missing steps)', async () => {
		mockedFs.readFile.mockResolvedValue('name: test\nsteps: []\n')
		await expect(loadChain('/repo')).rejects.toThrow('Invalid chain config')
	})
})
