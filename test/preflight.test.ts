import { describe, it, expect, vi, beforeEach } from 'vitest'
import { preflightBootstrap, preflightRunChecks } from '../src/preflight.js'
import fs from 'node:fs/promises'

vi.mock('node:fs/promises')

const mockedFs = vi.mocked(fs)

function mockPi(overrides: Record<string, { stdout?: string; stderr?: string; code?: number; killed?: boolean }> = {}) {
	return {
		exec: vi.fn(async (cmd: string, args: string[]) => {
			const key = `${cmd} ${args.join(' ')}`

			// Check overrides
			for (const [pattern, result] of Object.entries(overrides)) {
				if (key.includes(pattern)) {
					return {
						stdout: result.stdout ?? '',
						stderr: result.stderr ?? '',
						code: result.code ?? 0,
						killed: result.killed ?? false,
					}
				}
			}

			// Defaults
			if (key.includes('--git-dir')) return { stdout: '.git', stderr: '', code: 0, killed: false }
			if (key.includes('--is-shallow-repository')) return { stdout: 'false', stderr: '', code: 0, killed: false }
			if (key.includes('--show-toplevel')) return { stdout: '/test/repo', stderr: '', code: 0, killed: false }
			if (key.includes('--porcelain')) return { stdout: '', stderr: '', code: 0, killed: false }

			return { stdout: '', stderr: '', code: 0, killed: false }
		}),
	} as unknown as Parameters<typeof preflightBootstrap>[0]['pi']
}

function mockCtx() {
	return {
		ui: {
			confirm: vi.fn(async () => true),
			notify: vi.fn(),
			select: vi.fn(),
			input: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			setWorkingMessage: vi.fn(),
		},
	} as unknown as Parameters<typeof preflightRunChecks>[0]['ctx']
}

describe('preflightBootstrap', () => {
	it('returns repoRoot from git rev-parse', async () => {
		const pi = mockPi()
		const result = await preflightBootstrap({ pi })
		expect(result.repoRoot).toBe('/test/repo')
	})

	it('throws when not in a git repo', async () => {
		const pi = mockPi({ '--git-dir': { code: 128, stderr: 'not a git repo' } })
		await expect(preflightBootstrap({ pi })).rejects.toThrow('Not inside a git repository')
	})

	it('throws on shallow clone', async () => {
		const pi = mockPi({ '--is-shallow-repository': { stdout: 'true' } })
		await expect(preflightBootstrap({ pi })).rejects.toThrow('Shallow clone')
	})

	it('throws when rev-parse fails', async () => {
		const pi = mockPi({ '--show-toplevel': { code: 1 } })
		await expect(preflightBootstrap({ pi })).rejects.toThrow('Failed to resolve')
	})
})

describe('preflightRunChecks', () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	it('passes when teams.yaml exists and tree is clean', async () => {
		mockedFs.access.mockResolvedValue(undefined)
		const pi = mockPi()
		const ctx = mockCtx()

		await expect(
			preflightRunChecks({ repoRoot: '/repo', allowDirty: false, pi, ctx })
		).resolves.toBeUndefined()
	})

	it('throws when teams.yaml is missing', async () => {
		mockedFs.access.mockRejectedValue(new Error('ENOENT'))
		const pi = mockPi()
		const ctx = mockCtx()

		await expect(
			preflightRunChecks({ repoRoot: '/repo', allowDirty: false, pi, ctx })
		).rejects.toThrow('Missing config')
	})

	it('prompts confirmation on dirty tree', async () => {
		mockedFs.access.mockResolvedValue(undefined)
		const pi = mockPi({ '--porcelain': { stdout: 'M src/file.ts' } })
		const ctx = mockCtx()
		vi.mocked(ctx.ui.confirm).mockResolvedValue(true)

		await preflightRunChecks({ repoRoot: '/repo', allowDirty: false, pi, ctx })

		expect(ctx.ui.confirm).toHaveBeenCalledWith(
			'Dirty working tree',
			expect.stringContaining('uncommitted changes')
		)
	})

	it('throws when user declines dirty tree confirmation', async () => {
		mockedFs.access.mockResolvedValue(undefined)
		const pi = mockPi({ '--porcelain': { stdout: 'M src/file.ts' } })
		const ctx = mockCtx()
		vi.mocked(ctx.ui.confirm).mockResolvedValue(false)

		await expect(
			preflightRunChecks({ repoRoot: '/repo', allowDirty: false, pi, ctx })
		).rejects.toThrow('dirty working tree')
	})

	it('skips dirty check when allowDirty is true', async () => {
		mockedFs.access.mockResolvedValue(undefined)
		const pi = mockPi({ '--porcelain': { stdout: 'M src/file.ts' } })
		const ctx = mockCtx()

		await preflightRunChecks({ repoRoot: '/repo', allowDirty: true, pi, ctx })

		expect(ctx.ui.confirm).not.toHaveBeenCalled()
	})
})
