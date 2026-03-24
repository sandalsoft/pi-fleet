import path from 'node:path'
import fs from 'node:fs/promises'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { preflightBootstrap, preflightRunChecks } from './preflight.js'
import { runSetupWizard } from './setup/wizard.js'
import { handleSteer } from './steer/handler.js'
import { handleStatus, updateStatusLine } from './status/display.js'
import { getFleetState, setFleetState } from './session/runtime-store.js'
import {
	createEventLogWriter,
	createEventLogReader,
} from './session/event-log.js'
import { resume } from './session/resume.js'
import { emptyFleetState, reduceEvent } from './session/state.js'
import {
	createFleetEvent,
	type SessionCompleteEvent,
	type ConsolidationCompleteEvent,
} from './session/events.js'
import { loadTeam } from './config/teams.js'
import { loadAllAgents } from './config/agents.js'
import { loadChain } from './config/chains.js'
import { detectFleetMode } from './chain/detector.js'
import { runInterview } from './interview/interviewer.js'
import { selectTeam } from './interview/team-selector.js'
import { dispatch } from './dispatch/dispatcher.js'
import { runChain } from './chain/runner.js'
import { integrate, type SpecialistBranch } from './merge/integration.js'
import { createResourceTracker } from './resources/tracker.js'
import { createSessionTimer } from './resources/timer.js'
import { createLimitsMonitor } from './resources/limits.js'
import { WorktreeManager } from './worktree/manager.js'
import { WorktreePool } from './worktree/pool.js'

// Runtime-available APIs not yet in the ExtensionAPI type definitions.
type PiRuntime = ExtensionAPI & {
	sendMessage?: (opts: Record<string, unknown>) => void
}

// Node.js >= 20 runtime guard
const nodeMajor = parseInt(process.versions.node, 10)
if (nodeMajor < 20) {
	throw new Error(
		`pi-fleet requires Node.js >= 20 (found ${process.versions.node}). AbortSignal.any() and other modern APIs are required.`
	)
}

export default function piFleet(pi: ExtensionAPI): void {
	pi.registerCommand('fleet', {
		description: 'Start or resume a multi-agent fleet session',
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const flags = parseFleetArgs(args)

			// Always resolve repoRoot first
			const { repoRoot } = await preflightBootstrap({ pi })

			// Check if teams.yaml exists
			const teamsPath = path.join(repoRoot, '.pi', 'teams.yaml')
			let teamsExist = false
			try {
				await fs.access(teamsPath)
				teamsExist = true
			} catch {
				// Missing: setup wizard path
			}

			if (!teamsExist) {
				const wizardResult = await runSetupWizard(pi, ctx)
				if (wizardResult.skipped) return

				try {
					await fs.access(teamsPath)
				} catch {
					ctx.ui.notify('Setup did not create teams.yaml. Aborting.', 'warning')
					return
				}
			}

			// Dirty tree gating
			await preflightRunChecks({
				repoRoot,
				allowDirty: flags.allowDirty,
				pi,
				ctx,
			})

			// Build shared infrastructure
			const eventLog = createEventLogWriter(pi)
			const reader = createEventLogReader(() =>
				Promise.resolve(ctx.sessionManager.getEntries() as Array<{ customType?: string; data?: unknown }>)
			)

			// Resume check
			if (flags.resume) {
				const resumeResult = await resume(reader, { ui: ctx.ui })
				if (resumeResult.resumed && resumeResult.state) {
					setFleetState(resumeResult.state)
					ctx.ui.notify(
						`Resumed fleet session. Phase: ${resumeResult.state.phase}. ` +
						`${resumeResult.interruptedAgents.length} interrupted agent(s).`,
						'info'
					)
					// TODO: re-dispatch interrupted agents from resumed state
					return
				}
				// No incomplete session or user declined — fall through to normal flow
			}

			// Detect fleet mode (dispatcher vs chain)
			const mode = await detectFleetMode(repoRoot, ctx)
			if (mode === null) {
				ctx.ui.notify('No fleet configuration found. Run /fleet again after setup.', 'warning')
				return
			}

			// Load config
			const team = await loadTeam(repoRoot)
			const agents = await loadAllAgents(repoRoot)

			if (agents.length === 0) {
				ctx.ui.notify('No agent definitions found in .pi/agents/. Run setup first.', 'warning')
				return
			}

			const scratchpadDir = path.join(repoRoot, '.pi', 'scratchpads')
			const sessionId = Date.now().toString(36)

			// Initialize state
			let state = emptyFleetState()
			setFleetState(state)

			// Resource monitoring
			const timer = createSessionTimer()
			const tracker = createResourceTracker({
				eventLog,
				onCostUpdate: (_totalUsd, _agentName) => {
					const currentState = getFleetState()
					if (currentState) {
						updateStatusLine({ ui: ctx.ui }, currentState)
					}
				},
			})
			const limitsMonitor = createLimitsMonitor({
				maxUsd: team.constraints.maxUsd,
				maxMinutes: team.constraints.maxMinutes,
				timer,
				tracker,
				eventLog,
				scratchpadDir,
				onSoftWarning: (result) => {
					ctx.ui.notify(
						`Warning: ${result.kind} at ${Math.round(result.ratio * 100)}% (${result.current.toFixed(2)} / ${result.limit})`,
						'warning'
					)
				},
				onHardLimit: (result) => {
					ctx.ui.notify(
						`Hard limit reached: ${result.kind} at ${result.current.toFixed(2)} / ${result.limit}. Shutting down.`,
						'error'
					)
				},
			})

			// Initial limits check (also validates config)
			await limitsMonitor.check()

			if (mode === 'chain') {
				// Chain mode: sequential pipeline
				const chain = await loadChain(repoRoot)

				// Get task description from user
				const taskDesc = await ctx.ui.input('Describe the task for the chain pipeline:')
				if (!taskDesc) {
					ctx.ui.notify('No task description provided. Aborting.', 'warning')
					return
				}

				const result = await runChain({
					pi,
					ctx,
					chain,
					agents,
					repoRoot,
					worktreePath: repoRoot,
					eventLog,
					state,
					taskDescription: taskDesc,
					maxUsd: team.constraints.maxUsd,
					maxMinutes: team.constraints.maxMinutes,
					taskTimeoutMs: team.constraints.taskTimeoutMs,
				})

				setFleetState(result.state)
				ctx.ui.notify(
					`Chain complete. ${result.completedSteps}/${chain.steps.length} steps.` +
					(result.abortReason ? ` Aborted: ${result.abortReason}` : ''),
					result.abortReason ? 'warning' : 'info'
				)
				return
			}

			// Dispatcher mode: parallel DAG execution

			// Interview
			const interviewResult = await runInterview({
				pi,
				ctx,
				agents,
				repoRoot,
				eventLog,
			})

			if (interviewResult.cancelled) {
				ctx.ui.notify('Interview cancelled.', 'info')
				return
			}

			// Team selection and task assignment
			const selection = await selectTeam({
				answers: interviewResult.answers,
				agents,
				teamId: team.teamId,
				eventLog,
			})

			ctx.ui.notify(
				`Team selected: ${selection.selectedAgents.join(', ')}. ` +
				`${selection.waves.length} wave(s), ${selection.assignments.length} task(s).`,
				'info'
			)

			// Build dependency map from assignments
			const dependencies: Record<string, string[]> = {}
			for (const a of selection.assignments) {
				dependencies[a.agentId] = a.dependsOn
			}

			// Map TaskAssignment from interview to dispatch format
			const dispatchAssignments = selection.assignments.map((a) => ({
				agentName: a.agentId,
				brief: a.taskDescription,
				expectedPaths: a.expectedPaths,
			}))

			// Set up worktree pool
			const worktreeManager = new WorktreeManager({
				repoRoot,
				pi,
				sessionId,
				eventLog,
			})
			const pool = new WorktreePool({
				manager: worktreeManager,
				baseBranch: 'HEAD',
				pi,
			})

			// Pre-create worktrees for the first wave
			const firstWaveSize = selection.waves[0]?.length ?? 0
			if (firstWaveSize > 0) {
				await pool.preCreate(Math.min(firstWaveSize, team.constraints.maxConcurrency), ctx)
			}

			// Dispatch
			const dispatchResult = await dispatch({
				pi,
				ctx,
				team,
				agents,
				assignments: dispatchAssignments,
				dependencies,
				repoRoot,
				eventLog,
				state,
			})

			state = dispatchResult.state
			setFleetState(state)

			// Merge specialist branches back
			const specialistBranches: SpecialistBranch[] = []
			for (const [agentName, spec] of state.specialists) {
				if (spec.status === 'completed' && spec.worktreePath !== repoRoot) {
					try {
						const branchResult = await pi.exec('git', [
							'-C', spec.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD',
						])
						if (branchResult.stdout.trim()) {
							specialistBranches.push({
								agentName,
								branch: branchResult.stdout.trim(),
							})
						}
					} catch {
						// Worktree may have been cleaned up
					}
				}
			}

			if (specialistBranches.length > 0) {
				const gitExec = async (args: string[]) => {
					const result = await pi.exec('git', ['-C', repoRoot, ...args]) as { stdout: string; stderr?: string; code?: number }
					return {
						stdout: result.stdout,
						stderr: result.stderr ?? '',
						code: result.code ?? 0,
					}
				}

				try {
					const mergeResult = await integrate({
						git: gitExec,
						repoRoot,
						baseSha: state.baseSha ?? 'HEAD',
						specialists: specialistBranches,
						eventLog,
						sessionId,
					})

					if (mergeResult.failedAgents.length > 0) {
						ctx.ui.notify(
							`Merge completed with failures: ${mergeResult.failedAgents.join(', ')}`,
							'warning'
						)
					}
					if (mergeResult.drifted) {
						ctx.ui.notify(
							`Base drifted during execution. Rebase ${mergeResult.rebaseSucceeded ? 'succeeded' : 'failed — manual resolution needed'}.`,
							mergeResult.rebaseSucceeded ? 'info' : 'warning'
						)
					}
				} catch (err) {
					ctx.ui.notify(
						`Merge failed: ${err instanceof Error ? err.message : String(err)}`,
						'error'
					)
				}
			}

			// Consolidation event with final SHA
			const headAfterMerge = await pi.exec('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])
			const consolidationEvent = createFleetEvent<ConsolidationCompleteEvent>({
				type: 'consolidation_complete',
				finalSha: headAfterMerge.stdout.trim(),
			})
			await eventLog.append(consolidationEvent)
			state = reduceEvent(state, consolidationEvent)
			setFleetState(state)

			// Session complete
			const totalDurationMs = timer.elapsedMs()
			const completeEvent = createFleetEvent<SessionCompleteEvent>({
				type: 'session_complete',
				totalCostUsd: tracker.totalCostUsd(),
				totalDurationMs,
			})
			await eventLog.append(completeEvent)
			state = reduceEvent(state, completeEvent)
			setFleetState(state)

			// Clean up worktrees
			try {
				await pool.destroyAll()
			} catch {
				// Non-fatal
			}

			// Final status
			const failedCount = dispatchResult.failedAgents.length
			ctx.ui.notify(
				`Fleet session complete. ` +
				`${selection.assignments.length - failedCount} succeeded, ${failedCount} failed. ` +
				`Cost: $${tracker.totalCostUsd().toFixed(4)}. Time: ${(totalDurationMs / 1000).toFixed(0)}s.`,
				failedCount > 0 ? 'warning' : 'info'
			)
			updateStatusLine({ ui: ctx.ui }, state)
		},
	})

	pi.registerCommand('fleet-status', {
		description: 'Show current fleet session status',
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const reader = createEventLogReader(() =>
				Promise.resolve(ctx.sessionManager.getEntries() as Array<{ customType?: string; data?: unknown }>)
			)
			await handleStatus({ ctx, reader })
		},
	})

	pi.registerCommand('fleet-steer', {
		description: 'Send a steering message to a running agent',
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!args.trim()) {
				ctx.ui.notify('Usage: /fleet-steer <agent-name> <message>', 'warning')
				return
			}

			const state = getFleetState()
			if (!state || !state.repoRoot) {
				ctx.ui.notify('No active fleet session. Start one with /fleet first.', 'warning')
				return
			}

			const runtime = pi as PiRuntime
			await handleSteer(args, {
				repoRoot: state.repoRoot,
				state,
				ctx,
				sendMessage: runtime.sendMessage
					? async (opts) => { runtime.sendMessage!(opts) }
					: undefined,
			})
		},
	})
}

interface FleetFlags {
	resume: boolean
	allowDirty: boolean
}

function parseFleetArgs(args: string): FleetFlags {
	const parts = args.trim().split(/\s+/)
	return {
		resume: parts.includes('--resume'),
		allowDirty: parts.includes('--allow-dirty'),
	}
}
