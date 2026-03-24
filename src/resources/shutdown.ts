import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { EventLogWriter } from '../session/event-log.js'
import type { SessionAbortedEvent } from '../session/events.js'
import { createFleetEvent } from '../session/events.js'
import type { WorktreeManager } from '../worktree/manager.js'

const SIGTERM_GRACE_MS = 60_000
const MERGE_SAFE_WINDOW_MS = 30_000

export interface ShutdownOpts {
	/** All active child processes to terminate. */
	processes: ChildProcess[]
	/** Scratchpad directory for wrap-up instructions. */
	scratchpadDir: string
	/** Event log for recording session_aborted. */
	eventLog: EventLogWriter
	/** Worktree manager for cleanup. */
	worktreeManager?: WorktreeManager
	/** Session ID for worktree cleanup scoping. */
	sessionId?: string
	/** Reason for shutdown (budget, time, or manual signal). */
	reason: string
	/** Whether a merge is currently in progress. */
	isMergeInProgress: () => boolean
}

export interface ShutdownResult {
	terminated: number
	killed: number
	mergeWaited: boolean
	worktreesCleaned: boolean
}

/**
 * Two-phase graceful shutdown.
 *
 * Phase 1: Send SIGTERM to all child processes, write "wrap up immediately"
 * to scratchpads, and wait up to 60 seconds for them to exit.
 *
 * Phase 2: SIGKILL any processes still alive after the grace period.
 *
 * Bounded merge safe window: if a merge is in progress, wait up to 30s
 * for it to finish before proceeding. Prevents mid-merge branch corruption
 * without risking deadlock from an unbounded wait.
 *
 * Uses process.once() for signal handlers to prevent double-fire on rapid Ctrl+C.
 */
export async function gracefulShutdown(opts: ShutdownOpts): Promise<ShutdownResult> {
	const {
		processes,
		scratchpadDir,
		eventLog,
		worktreeManager,
		reason,
		isMergeInProgress,
	} = opts

	let terminated = 0
	let killed = 0
	let mergeWaited = false
	let worktreesCleaned = false

	// --- Merge safe window ---
	if (isMergeInProgress()) {
		mergeWaited = true
		const mergeStart = Date.now()
		while (isMergeInProgress() && Date.now() - mergeStart < MERGE_SAFE_WINDOW_MS) {
			await sleep(500)
		}
		if (isMergeInProgress()) {
			console.warn(
				'[pi-fleet] Merge still in progress after 30s safe window. Proceeding with shutdown. ' +
				'Integration branch left for manual inspection.'
			)
		}
	}

	// --- Write wrap-up instructions to scratchpads ---
	await writeShutdownScratchpad(scratchpadDir, reason)

	// --- Phase 1: SIGTERM ---
	const aliveProcesses: ChildProcess[] = []
	for (const proc of processes) {
		if (proc.exitCode !== null || proc.killed) continue
		try {
			proc.kill('SIGTERM')
			terminated++
			aliveProcesses.push(proc)
		} catch {
			// Process already exited
		}
	}

	// Wait for graceful exit
	if (aliveProcesses.length > 0) {
		await Promise.race([
			Promise.all(aliveProcesses.map(waitForExit)),
			sleep(SIGTERM_GRACE_MS),
		])
	}

	// --- Phase 2: SIGKILL survivors ---
	for (const proc of aliveProcesses) {
		if (proc.exitCode !== null || proc.killed) continue
		try {
			proc.kill('SIGKILL')
			killed++
		} catch {
			// Already dead
		}
	}

	// --- Emit session_aborted event ---
	const event = createFleetEvent<SessionAbortedEvent>({
		type: 'session_aborted',
		reason,
	})
	try {
		await eventLog.append(event)
	} catch {
		console.warn('[pi-fleet] Could not write session_aborted event during shutdown')
	}

	// --- Worktree cleanup ---
	if (worktreeManager) {
		try {
			await worktreeManager.pruneStaleWorktrees()
			worktreesCleaned = true
		} catch {
			console.warn('[pi-fleet] Worktree cleanup failed during shutdown')
		}
	}

	return { terminated, killed, mergeWaited, worktreesCleaned }
}

/**
 * Install process signal handlers for graceful shutdown.
 *
 * Uses process.once() to prevent double-fire when the user
 * presses Ctrl+C multiple times in quick succession.
 */
export function installSignalHandlers(
	triggerShutdown: (reason: string) => Promise<void>
): () => void {
	let shutdownTriggered = false

	const handler = (signal: string) => {
		if (shutdownTriggered) return
		shutdownTriggered = true
		triggerShutdown(`Received ${signal}`).catch((err) => {
			console.error('[pi-fleet] Shutdown error:', err)
			process.exit(1)
		})
	}

	const sigintHandler = () => handler('SIGINT')
	const sigtermHandler = () => handler('SIGTERM')

	process.once('SIGINT', sigintHandler)
	process.once('SIGTERM', sigtermHandler)

	// Return a cleanup function to remove handlers
	return () => {
		process.removeListener('SIGINT', sigintHandler)
		process.removeListener('SIGTERM', sigtermHandler)
	}
}

function waitForExit(proc: ChildProcess): Promise<void> {
	if (proc.exitCode !== null) return Promise.resolve()
	return new Promise((resolve) => {
		proc.once('exit', () => resolve())
		proc.once('error', () => resolve())
	})
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeShutdownScratchpad(scratchpadDir: string, reason: string): Promise<void> {
	const filePath = path.join(scratchpadDir, 'fleet-shutdown.md')
	const content = [
		'# Shutdown In Progress',
		'',
		`Reason: ${reason}`,
		'',
		'**Wrap up immediately.** Save your current work, commit if possible,',
		'and exit cleanly. Do not start new tasks.',
	].join('\n')

	try {
		await fs.mkdir(scratchpadDir, { recursive: true })
		await fs.writeFile(filePath, content, 'utf-8')
	} catch {
		// Non-fatal
	}
}
