import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dispatch, type DispatcherOpts } from '../../src/dispatch/dispatcher.js'
import { emptyFleetState, type FleetState } from '../../src/session/state.js'
import { clearFleetState, getFleetState } from '../../src/session/runtime-store.js'
import { calculateCost } from '../../src/resources/pricing.js'
import type { SpawnResult } from '../../src/dispatch/types.js'
import type { TaskAssignment } from '../../src/dispatch/types.js'
import type { Team } from '../../src/config/schema.js'
import type { AgentDefinition } from '../../src/config/schema.js'
import type { EventLogWriter } from '../../src/session/event-log.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// --- Partial mock: spawner (keep extractActivity/extractStreamingUsage real) ---
vi.mock('../../src/dispatch/spawner.js', async () => {
	const actual = await vi.importActual('../../src/dispatch/spawner.js')
	return {
		...actual,
		spawnSpecialist: vi.fn(),
		readSmokeResults: vi.fn().mockResolvedValue(null),
	}
})

// --- Stub display to avoid component factory ---
vi.mock('../../src/status/display.js', () => ({
	updateProgressWidget: vi.fn(),
	clearProgressWidget: vi.fn(),
}))

// --- Stub prompt-composer to avoid filesystem reads ---
vi.mock('../../src/dispatch/prompt-composer.js', () => ({
	composePrompt: vi.fn().mockResolvedValue('test prompt'),
}))

// --- Stub agent-logger to avoid filesystem writes ---
vi.mock('../../src/dispatch/agent-logger.js', () => ({
	AgentLogger: {
		create: vi.fn().mockResolvedValue(null),
	},
}))

// --- Stub failure-analyzer ---
vi.mock('../../src/dispatch/failure-analyzer.js', () => ({
	analyzeFailure: vi.fn().mockResolvedValue('failure analysis'),
}))

// Import mocked spawnSpecialist for controlling behavior
import { spawnSpecialist } from '../../src/dispatch/spawner.js'

const mockedSpawnSpecialist = vi.mocked(spawnSpecialist)

function makeTeam(overrides: Partial<Team> = {}): Team {
	return {
		id: 'test-team',
		name: 'Test Team',
		members: ['agent-a'],
		strategy: 'parallel',
		constraints: {
			maxUsd: 10,
			maxMinutes: 30,
			taskTimeoutMs: 60_000,
			maxConcurrency: 2,
		},
		...overrides,
	}
}

function makeAgent(name: string): AgentDefinition {
	return {
		id: name,
		filePath: `/agents/${name}.md`,
		frontmatter: {
			name,
			model: 'sonnet',
			role: 'developer',
		},
		systemPrompt: `You are ${name}`,
	}
}

function makeAssignment(agentName: string, brief = 'do the thing'): TaskAssignment {
	return { agentName, brief, expectedPaths: [] }
}

function makeSpawnResult(
	agentName: string,
	status: 'completed' | 'failed',
	usage: { inputTokens: number; outputTokens: number }
): SpawnResult {
	return {
		runtime: {
			runId: `${agentName}-run1`,
			pid: 1234,
			agentName,
			worktreePath: '/tmp/test',
			model: 'sonnet',
			status,
			abortController: new AbortController(),
			process: {} as any,
		},
		report: `${agentName} report`,
		usage: {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0,
		},
		exitCode: status === 'completed' ? 0 : 1,
		stderr: status === 'failed' ? 'something failed' : '',
		errorDetails: status === 'failed' ? ['error detail'] : [],
	}
}

function makeCtx() {
	return {
		ui: {
			setWidget: vi.fn(),
			setStatus: vi.fn(),
			setWorkingMessage: vi.fn(),
			notify: vi.fn(),
		},
	}
}

function makePi() {
	return {
		exec: vi.fn().mockResolvedValue({ stdout: 'abc123\n', stderr: '' }),
	}
}

function makeEventLog(): EventLogWriter {
	return {
		append: vi.fn().mockResolvedValue(undefined),
	} as unknown as EventLogWriter
}

describe('dispatcher', () => {
	let tmpDir: string

	beforeEach(async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-dispatch-'))
		await fs.mkdir(path.join(tmpDir, '.pi', 'scratchpads'), { recursive: true })
	})

	afterEach(async () => {
		vi.useRealTimers()
		clearFleetState()
		vi.restoreAllMocks()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	describe('cost tracking', () => {
		it('final costs match calculateCost(result.usage) exactly, not 2x', async () => {
			const agentName = 'agent-a'
			const finalUsage = { inputTokens: 1000, outputTokens: 500 }

			// The spawn result returns the authoritative usage from parseJsonlStream
			const spawnResult = makeSpawnResult(agentName, 'completed', finalUsage)

			// Simulate streaming: onStreamLine will be called with usage events
			// that would normally accumulate via extractStreamingUsage.
			// The mock captures onStreamLine and calls it with streaming events.
			mockedSpawnSpecialist.mockImplementation(async (opts) => {
				// Simulate streaming cost events (same data that parseJsonlStream
				// will later re-parse — this is what causes double counting)
				const streamLine1 = JSON.stringify({
					type: 'assistant_message',
					subtype: 'end',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'working...' }],
						usage: { input_tokens: 600, output_tokens: 300 },
					},
				})
				const streamLine2 = JSON.stringify({
					type: 'assistant_message',
					subtype: 'end',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'done' }],
						usage: { input_tokens: 400, output_tokens: 200 },
					},
				})

				// Fire streaming lines (these would accumulate to 1000/500 in old code)
				opts.onStreamLine?.(streamLine1)
				opts.onStreamLine?.(streamLine2)

				return spawnResult
			})

			const result = await dispatch({
				pi: makePi() as any,
				ctx: makeCtx() as any,
				team: makeTeam(),
				agents: [makeAgent(agentName)],
				assignments: [makeAssignment(agentName)],
				dependencies: {},
				repoRoot: tmpDir,
				eventLog: makeEventLog(),
				state: emptyFleetState(),
			})

			// The authoritative cost from calculateCost
			const expectedCost = calculateCost(spawnResult.usage, 'sonnet')

			const agentCost = result.state.costs.get(agentName)
			expect(agentCost).toBeDefined()
			// Must match final values exactly — NOT streaming + final (2x)
			expect(agentCost!.inputTokens).toBe(finalUsage.inputTokens)
			expect(agentCost!.outputTokens).toBe(finalUsage.outputTokens)
			expect(agentCost!.costUsd).toBeCloseTo(expectedCost.costUsd)
			// totalCostUsd must match the single agent's cost
			expect(result.state.totalCostUsd).toBeCloseTo(expectedCost.costUsd)
		})

		it('streaming costs update live during execution', async () => {
			const agentName = 'agent-a'
			const capturedStates: FleetState[] = []

			mockedSpawnSpecialist.mockImplementation(async (opts) => {
				// Emit a streaming usage line
				const streamLine = JSON.stringify({
					type: 'assistant_message',
					subtype: 'end',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'step 1' }],
						usage: { input_tokens: 200, output_tokens: 100 },
					},
				})
				opts.onStreamLine?.(streamLine)

				// Capture state after streaming update
				const stateSnapshot = getFleetState()
				if (stateSnapshot) capturedStates.push(stateSnapshot)

				return makeSpawnResult(agentName, 'completed', { inputTokens: 200, outputTokens: 100 })
			})

			await dispatch({
				pi: makePi() as any,
				ctx: makeCtx() as any,
				team: makeTeam(),
				agents: [makeAgent(agentName)],
				assignments: [makeAssignment(agentName)],
				dependencies: {},
				repoRoot: tmpDir,
				eventLog: makeEventLog(),
				state: emptyFleetState(),
			})

			// During streaming, costs should have been non-zero
			expect(capturedStates.length).toBeGreaterThan(0)
			const midStreamCost = capturedStates[0].costs.get(agentName)
			expect(midStreamCost).toBeDefined()
			expect(midStreamCost!.inputTokens).toBeGreaterThan(0)
		})

		it('totalCostUsd matches sum of all agent costs after multi-agent completion', async () => {
			const agents = ['agent-a', 'agent-b']
			const usages = [
				{ inputTokens: 1000, outputTokens: 500 },
				{ inputTokens: 2000, outputTokens: 800 },
			]

			let callIdx = 0
			mockedSpawnSpecialist.mockImplementation(async () => {
				const idx = callIdx++
				const name = agents[idx]
				return makeSpawnResult(name, 'completed', usages[idx])
			})

			const team = makeTeam({ members: agents })
			const result = await dispatch({
				pi: makePi() as any,
				ctx: makeCtx() as any,
				team,
				agents: agents.map(makeAgent),
				assignments: agents.map((a) => makeAssignment(a)),
				dependencies: {},
				repoRoot: tmpDir,
				eventLog: makeEventLog(),
				state: emptyFleetState(),
			})

			// Sum individual costs
			let expectedTotal = 0
			for (let i = 0; i < agents.length; i++) {
				const { costUsd } = calculateCost(
					{ ...usages[i], cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
					'sonnet'
				)
				const agentCost = result.state.costs.get(agents[i])
				expect(agentCost).toBeDefined()
				expect(agentCost!.inputTokens).toBe(usages[i].inputTokens)
				expect(agentCost!.outputTokens).toBe(usages[i].outputTokens)
				expect(agentCost!.costUsd).toBeCloseTo(costUsd)
				expectedTotal += costUsd
			}
			expect(result.state.totalCostUsd).toBeCloseTo(expectedTotal)
		})

		it('cost reset + final cost committed in single commitState for failed agents', async () => {
			const agentName = 'agent-a'
			const finalUsage = { inputTokens: 500, outputTokens: 200 }

			mockedSpawnSpecialist.mockImplementation(async (opts) => {
				// Simulate streaming cost that would be double-counted
				const streamLine = JSON.stringify({
					type: 'message_end',
					usage: { input_tokens: 500, output_tokens: 200 },
				})
				opts.onStreamLine?.(streamLine)
				return makeSpawnResult(agentName, 'failed', finalUsage)
			})

			const result = await dispatch({
				pi: makePi() as any,
				ctx: makeCtx() as any,
				team: makeTeam(),
				agents: [makeAgent(agentName)],
				assignments: [makeAssignment(agentName)],
				dependencies: {},
				repoRoot: tmpDir,
				eventLog: makeEventLog(),
				state: emptyFleetState(),
			})

			const expectedCost = calculateCost(
				{ ...finalUsage, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
				'sonnet'
			)

			const agentCost = result.state.costs.get(agentName)
			expect(agentCost).toBeDefined()
			// Even for failed agents: no double counting
			expect(agentCost!.inputTokens).toBe(finalUsage.inputTokens)
			expect(agentCost!.outputTokens).toBe(finalUsage.outputTokens)
			expect(agentCost!.costUsd).toBeCloseTo(expectedCost.costUsd)
		})

		it('onUsage callback receives correct usage data', async () => {
			const agentName = 'agent-a'
			const finalUsage = { inputTokens: 750, outputTokens: 300 }
			const onUsage = vi.fn()

			mockedSpawnSpecialist.mockResolvedValue(
				makeSpawnResult(agentName, 'completed', finalUsage)
			)

			await dispatch({
				pi: makePi() as any,
				ctx: makeCtx() as any,
				team: makeTeam(),
				agents: [makeAgent(agentName)],
				assignments: [makeAssignment(agentName)],
				dependencies: {},
				repoRoot: tmpDir,
				eventLog: makeEventLog(),
				state: emptyFleetState(),
				onUsage,
			})

			expect(onUsage).toHaveBeenCalledOnce()
			expect(onUsage).toHaveBeenCalledWith(
				agentName,
				'sonnet',
				expect.objectContaining({
					inputTokens: finalUsage.inputTokens,
					outputTokens: finalUsage.outputTokens,
				})
			)
		})
	})
})
