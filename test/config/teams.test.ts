import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadTeam } from '../../src/config/teams.js'
import fs from 'node:fs/promises'

vi.mock('node:fs/promises')

const mockedFs = vi.mocked(fs)

const VALID_YAML = `
team_id: dev-squad
orchestrator:
  model: claude-sonnet-4-20250514
  skills:
    - planning
members:
  - architect
  - developer
constraints:
  max_usd: 5.0
  max_minutes: 30
  max_concurrency: 3
`

describe('loadTeam', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('loads and transforms a valid teams.yaml', async () => {
		mockedFs.readFile.mockResolvedValue(VALID_YAML)

		const team = await loadTeam('/repo')
		expect(team.teamId).toBe('dev-squad')
		expect(team.orchestrator.model).toBe('claude-sonnet-4-20250514')
		expect(team.members).toEqual(['architect', 'developer'])
		expect(team.constraints.maxUsd).toBe(5.0)
		expect(team.constraints.taskTimeoutMs).toBe(120000)
	})

	it('reads from .pi/teams.yaml relative to repoRoot', async () => {
		mockedFs.readFile.mockResolvedValue(VALID_YAML)
		await loadTeam('/my/repo')
		expect(mockedFs.readFile).toHaveBeenCalledWith(
			expect.stringContaining('.pi/teams.yaml'),
			'utf-8'
		)
	})

	it('throws on missing file', async () => {
		mockedFs.readFile.mockRejectedValue(new Error('ENOENT'))
		await expect(loadTeam('/repo')).rejects.toThrow('Could not read teams config')
	})

	it('throws on invalid YAML', async () => {
		mockedFs.readFile.mockResolvedValue('{ invalid yaml :::')
		await expect(loadTeam('/repo')).rejects.toThrow('Invalid YAML')
	})

	it('throws on schema validation failure with path context', async () => {
		mockedFs.readFile.mockResolvedValue('team_id: test\n')
		await expect(loadTeam('/repo')).rejects.toThrow('Invalid teams config')
	})

	it('rejects unknown keys with clear error', async () => {
		const withPaths = VALID_YAML + '\npaths:\n  agents: ./agents\n'
		mockedFs.readFile.mockResolvedValue(withPaths)
		await expect(loadTeam('/repo')).rejects.toThrow('Invalid teams config')
	})
})
