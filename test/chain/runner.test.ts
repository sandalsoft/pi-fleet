import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import type { AgentDefinition } from '../../src/config/schema.js'
import type { EventLogWriter } from '../../src/session/event-log.js'
import { emptyFleetState } from '../../src/session/state.js'
import { runChain, type ChainRunnerOpts } from '../../src/chain/runner.js'
import type { SpawnResult } from '../../src/dispatch/types.js'

// Mock the spawner module
vi.mock('../../src/dispatch/spawner.js', () => ({
	spawnSpecialist: vi.fn(),
	readSmokeResults: vi.fn().mockResolvedValue(null),
}))

// Mock prompt-composer to avoid filesystem reads
vi.mock('../../src/dispatch/prompt-composer.js', () => ({
	composePrompt: vi.fn().mockImplementation(async (opts: { taskBrief: string }) => opts.taskBrief),
}))

import { spawnSpecialist } from '../../src/dispatch/spawner.js'

const mockSpawn = vi.mocked(spawnSpecialist)

function makeAgent(id: string, name?: string): AgentDefinition {
	return {
		id,
		frontmatter: {
			name: name ?? id,
			model: 'sonnet',
		},
		body: `You are ${id}.`,
	}
}

function makeSpawnResult(report: string, status: 'completed' | 'failed' = 'completed'): SpawnResult {
	return {
		runtime: {
			runId: `run-${Math.random().toString(36).slice(2, 8)}`,
			pid: 1234,
			agentName: 'test',
			worktreePath: '/tmp/wt',
			model: 'sonnet',
			status,
			startedAt: null,
			completedAt: null,
			abortController: new AbortController(),
			process: {} as never,
			turnCount: 0,
		},
		report,
		usage: {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0.001,
		},
	}
}

function makeOpts(overrides?: Partial<ChainRunnerOpts>): ChainRunnerOpts {
	const appendedEvents: unknown[] = []

	return {
		pi: {
			exec: vi.fn().mockResolvedValue({ stdout: 'abc123\n', code: 0 }),
			appendEntry: vi.fn(),
		} as unknown as ExtensionAPI,
		ctx: {
			ui: {
				select: vi.fn(),
				confirm: vi.fn(),
				input: vi.fn(),
				notify: vi.fn(),
				setStatus: vi.fn(),
				setWidget: vi.fn(),
				setWorkingMessage: vi.fn(),
			},
			sessionManager: { getEntries: vi.fn().mockResolvedValue([]) },
		} as unknown as ExtensionCommandContext,
		chain: {
			name: 'test-chain',
			steps: [
				{ agent: 'planner', prompt: 'Plan this: $INPUT' },
				{ agent: 'coder', prompt: 'Implement based on: $INPUT' },
			],
		},
		agents: [makeAgent('planner'), makeAgent('coder')],
		repoRoot: '/tmp/repo',
		worktreePath: '/tmp/wt',
		eventLog: {
			append: vi.fn().mockImplementation(async (e) => {
				appendedEvents.push(e)
			}),
		} as unknown as EventLogWriter,
		state: emptyFleetState(),
		taskDescription: 'Build a REST API',
		maxUsd: 10,
		maxMinutes: 30,
		taskTimeoutMs: 60_000,
		...overrides,
	}
}

describe('chain runner', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('executes steps sequentially, passing output as $INPUT to next step', async () => {
		mockSpawn
			.mockResolvedValueOnce(makeSpawnResult('Here is the plan'))
			.mockResolvedValueOnce(makeSpawnResult('Implementation complete'))

		const opts = makeOpts()
		const result = await runChain(opts)

		expect(result.completedSteps).toBe(2)
		expect(result.abortReason).toBeNull()
		expect(result.finalOutput).toBe('Implementation complete')

		// First step receives user's task description
		expect(mockSpawn).toHaveBeenCalledTimes(2)
		const firstCall = mockSpawn.mock.calls[0][0]
		expect(firstCall.prompt).toContain('Build a REST API')

		// Second step receives first step's output
		const secondCall = mockSpawn.mock.calls[1][0]
		expect(secondCall.prompt).toContain('Here is the plan')
	})

	it('aborts chain when a step fails', async () => {
		mockSpawn
			.mockResolvedValueOnce(makeSpawnResult('Plan output'))
			.mockResolvedValueOnce(makeSpawnResult('', 'failed'))

		const opts = makeOpts()
		const result = await runChain(opts)

		expect(result.completedSteps).toBe(1)
		expect(result.abortReason).toContain('failed')
		expect(result.state.sessionAborted).toBe(true)
	})

	it('aborts chain when agent definition is not found', async () => {
		const opts = makeOpts({
			chain: {
				name: 'missing-agent',
				steps: [{ agent: 'nonexistent' }],
			},
		})

		const result = await runChain(opts)

		expect(result.completedSteps).toBe(0)
		expect(result.abortReason).toContain('agent definition not found')
		expect(mockSpawn).not.toHaveBeenCalled()
	})

	it('respects budget limits', async () => {
		// First step succeeds but uses all the budget
		const expensiveResult = makeSpawnResult('expensive output')
		expensiveResult.usage.cost = 15 // exceeds maxUsd of 10
		mockSpawn.mockResolvedValueOnce(expensiveResult)

		const opts = makeOpts({
			chain: {
				name: 'expensive-chain',
				steps: [
					{ agent: 'planner', prompt: '$INPUT' },
					{ agent: 'coder', prompt: '$INPUT' },
				],
			},
		})
		const result = await runChain(opts)

		// First step completes, second is skipped due to budget
		expect(result.completedSteps).toBe(1)
		expect(result.abortReason).toContain('Budget exceeded')
	})

	it('respects time limits', async () => {
		// First step takes long enough to exceed the time limit
		mockSpawn.mockImplementationOnce(async () => {
			await new Promise((r) => setTimeout(r, 30))
			return makeSpawnResult('step 1 done')
		})

		const opts = makeOpts({
			maxMinutes: 0.0001, // ~6ms — will be exceeded after first step's 30ms
			chain: {
				name: 'slow-chain',
				steps: [
					{ agent: 'planner', prompt: '$INPUT' },
					{ agent: 'coder', prompt: '$INPUT' },
				],
			},
		})

		const result = await runChain(opts)

		expect(result.completedSteps).toBe(1)
		expect(result.abortReason).toContain('Time limit exceeded')
	})

	it('respects cancel signal', async () => {
		const abortController = new AbortController()
		abortController.abort()

		const opts = makeOpts({
			cancelSignal: abortController.signal,
			maxMinutes: 9999, // large limit so time check doesn't fire
		})
		const result = await runChain(opts)

		expect(result.completedSteps).toBe(0)
		expect(result.abortReason).toBe('Chain cancelled by user')
		expect(mockSpawn).not.toHaveBeenCalled()
	})

	it('emits specialist_started and specialist_completed events per step', async () => {
		mockSpawn
			.mockResolvedValueOnce(makeSpawnResult('output 1'))
			.mockResolvedValueOnce(makeSpawnResult('output 2'))

		const opts = makeOpts()
		await runChain(opts)

		const eventLog = opts.eventLog as { append: ReturnType<typeof vi.fn> }
		const events = eventLog.append.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type)

		// session_start, specialist_started, specialist_completed (x2 steps), session_complete
		expect(events).toContain('session_start')
		expect(events.filter((t: string) => t === 'specialist_started')).toHaveLength(2)
		expect(events.filter((t: string) => t === 'specialist_completed')).toHaveLength(2)
		expect(events).toContain('session_complete')
	})

	it('emits specialist_failed and session_aborted events on step failure', async () => {
		mockSpawn.mockResolvedValueOnce(makeSpawnResult('', 'failed'))

		const opts = makeOpts({
			chain: {
				name: 'fail-chain',
				steps: [{ agent: 'planner', prompt: '$INPUT' }],
			},
		})
		await runChain(opts)

		const eventLog = opts.eventLog as { append: ReturnType<typeof vi.fn> }
		const events = eventLog.append.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type)

		expect(events).toContain('specialist_failed')
		expect(events).toContain('session_aborted')
	})

	it('accumulates usage across steps', async () => {
		const result1 = makeSpawnResult('out 1')
		result1.usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, cost: 0.01 }
		const result2 = makeSpawnResult('out 2')
		result2.usage = { inputTokens: 200, outputTokens: 75, cacheReadTokens: 20, cacheWriteTokens: 10, cost: 0.02 }

		mockSpawn
			.mockResolvedValueOnce(result1)
			.mockResolvedValueOnce(result2)

		const opts = makeOpts()
		const result = await runChain(opts)

		expect(result.totalUsage.inputTokens).toBe(300)
		expect(result.totalUsage.outputTokens).toBe(125)
		expect(result.totalUsage.cost).toBeCloseTo(0.03)
	})

	it('handles step with no prompt template (pass-through)', async () => {
		mockSpawn.mockResolvedValueOnce(makeSpawnResult('done'))

		const opts = makeOpts({
			chain: {
				name: 'no-template',
				steps: [{ agent: 'planner' }],
			},
		})
		const result = await runChain(opts)

		expect(result.completedSteps).toBe(1)
		// The prompt should be the raw task description
		const call = mockSpawn.mock.calls[0][0]
		expect(call.prompt).toContain('Build a REST API')
	})

	it('handles spawn throwing an exception', async () => {
		mockSpawn.mockRejectedValueOnce(new Error('spawn ENOENT'))

		const opts = makeOpts({
			chain: {
				name: 'crash-chain',
				steps: [{ agent: 'planner', prompt: '$INPUT' }],
			},
		})
		const result = await runChain(opts)

		expect(result.completedSteps).toBe(0)
		expect(result.abortReason).toContain('spawn ENOENT')
		expect(result.state.sessionAborted).toBe(true)
	})

	it('uses agent id for lookup when step references by id', async () => {
		mockSpawn.mockResolvedValueOnce(makeSpawnResult('done'))

		const opts = makeOpts({
			chain: {
				name: 'by-id',
				steps: [{ agent: 'planner' }],
			},
			agents: [makeAgent('planner', 'The Planner')],
		})
		const result = await runChain(opts)

		expect(result.completedSteps).toBe(1)
	})
})
