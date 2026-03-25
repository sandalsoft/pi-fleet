import path from 'node:path'
import fs from 'node:fs/promises'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { preflightBootstrap, preflightRunChecks } from './preflight.js'
import { runSetupWizard } from './setup/wizard.js'
import { handleSteer } from './steer/handler.js'
import { runConfigEditor } from './config/editor.js'
import { FleetLogOverlay } from './status/log-overlay.js'
import { handleStatus, updateProgressWidget, clearProgressWidget } from './status/display.js'
import { getFleetState, setFleetState, setFleetErrors, getFleetErrors, setActivityStore, getActivityStore, setLogDir, setLogPaths, getLogPaths } from './session/runtime-store.js'
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
import { installSignalHandlers, gracefulShutdown } from './resources/shutdown.js'
import { fullCleanup } from './worktree/cleanup.js'
import { rotateSessionLogs, KEEP_LOG_SESSIONS } from './dispatch/agent-logger.js'

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

				// Auto-commit scaffolded config so the worktree is clean and
				// agents in worktrees (created from HEAD) have access to their config.
				await pi.exec('git', ['-C', repoRoot, 'add', '.pi/'])
				const statusAfterAdd = await pi.exec('git', ['-C', repoRoot, 'diff', '--cached', '--quiet'])
				if (statusAfterAdd.code !== 0) {
					await pi.exec('git', ['-C', repoRoot, 'commit', '-m', 'chore: scaffold pi-fleet config'])
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
						`${resumeResult.interruptedAgents.length} interrupted agent(s). ` +
						'Re-running from the beginning of the current phase.',
						'info'
					)
					// Fall through to normal flow — the resumed state informs
					// which phase we're in, and the normal flow will re-execute
					// from the current phase. A full re-dispatch of interrupted
					// agents requires more granular state tracking (future work).
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
				// Widget updates are handled by the dispatcher's commitState/refreshWidget.
				// Updating here without the activities map would erase live activity lines.
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
					cancelController.abort()
				},
			})

			// Cancellation and shutdown wiring
			const cancelController = new AbortController()

			const removeSignalHandlers = installSignalHandlers(async (reason) => {
				cancelController.abort()
				await gracefulShutdown({
					processes: [],
					scratchpadDir,
					eventLog,
					worktreeManager,
					sessionId,
					reason,
					isMergeInProgress: () => getFleetState()?.mergeInProgress ?? false,
				})
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

			// Populate members in state so the widget shows queued agents.
			// selectTeam emitted team_selected to the event log but the
			// in-memory state was not reduced — set it directly.
			state.members = selection.selectedAgents
			setFleetState(state)

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

			// Create log directory for persistent agent logging
			const logsRootDir = path.join(repoRoot, '.pi', 'logs')
			let logDir: string | undefined
			try {
				logDir = path.join(logsRootDir, sessionId)
				await fs.mkdir(logDir, { recursive: true })
				setLogDir(logDir)
			} catch {
				console.warn('[pi-fleet] Log dir creation failed')
				logDir = undefined
				setLogDir(null)
			}
			if (logDir) {
				try { await rotateSessionLogs(logsRootDir, KEEP_LOG_SESSIONS) } catch { console.warn('[pi-fleet] Rotation failed') }
			}

			// Dispatch with worktree pool and cost tracking
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
				cancelSignal: cancelController.signal,
				acquireWorktree: async (agentName) => {
					const info = await pool.acquire(agentName, ctx)
					return { worktreePath: info.worktreePath, branch: info.branch }
				},
				releaseWorktree: (worktreePath) => pool.release(worktreePath),
				onUsage: (agentName, modelId, usage) => {
					tracker.recordUsage(agentName, modelId, usage)
					limitsMonitor.check()
				},
				analysisModel: ctx.model,
				logDir,
			})

			state = dispatchResult.state
			setFleetState(state)
			setFleetErrors(dispatchResult.errors)
			setLogPaths(dispatchResult.logPaths)
			setActivityStore(dispatchResult.activityStore)
			updateProgressWidget({ ui: ctx.ui }, state, undefined, undefined, dispatchResult.errors)

			// Merge specialist branches back
			const specialistBranches: SpecialistBranch[] = dispatchResult.completedBranches.map(
				(b) => ({ agentName: b.agentName, branch: b.branch })
			)

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
			updateProgressWidget({ ui: ctx.ui }, state)

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
			updateProgressWidget({ ui: ctx.ui }, state)

			// Clean up worktrees and signal handlers
			removeSignalHandlers()
			try {
				await fullCleanup(worktreeManager, sessionId)
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
			clearProgressWidget({ ui: ctx.ui })
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

	pi.registerCommand('fleet-log', {
		description: 'Show scrollable fleet activity log',
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const store = getActivityStore()
			if (!store || store.getFullHistory().length === 0) {
				ctx.ui.notify('No fleet activity recorded. Start a fleet session first.', 'info')
				return
			}

			const state = getFleetState()
			const sessionStart = state?.startedAt ? new Date(state.startedAt).getTime() : Date.now()

			if (!ctx.hasUI) {
				// Headless fallback
				const entries = store.getFullHistory().slice(-20)
				const lines = entries.map((e) => {
					const elapsed = Math.floor((e.timestamp - sessionStart) / 1000)
					return `[${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}] ${e.agentName}: ${e.text}`
				})
				ctx.ui.notify(lines.join('\n'), 'info')
				return
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new FleetLogOverlay(theme, store.getFullHistory(), sessionStart, () => done())
			}, {
				overlay: true,
				overlayOptions: { maxHeight: '70%', width: '90%', anchor: 'center' },
			})
		},
	})

	pi.registerCommand('fleet-errors', {
		description: 'Show error details for failed agents',
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const errors = getFleetErrors()
			if (errors.size === 0) {
				ctx.ui.notify('No agent errors recorded.', 'info')
				return
			}

			const paths = getLogPaths()
			const lines: string[] = []
			for (const [agent, error] of errors) {
				lines.push(`--- ${agent} ---`)
				lines.push(error)
				const lp = paths.get(agent)
				if (lp) {
					lines.push(`Log: ${lp}`)
				}
				lines.push('')
			}
			ctx.ui.setWidget('fleet-errors', lines, { placement: 'aboveEditor' })
		},
	})

	pi.registerCommand('fleet-config', {
		description: 'Configure fleet settings (team, agents, constraints, chain)',
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const { repoRoot } = await preflightBootstrap({ pi })
			await runConfigEditor({ ctx, repoRoot })
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
