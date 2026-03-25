import fs from 'node:fs/promises'
import path from 'node:path'
import { getFleetState, getLogDir } from '../session/runtime-store.js'
import { preflightBootstrap } from '../preflight.js'
import { tailLines, type AgentMeta } from '../dispatch/agent-logger.js'
import { extractActivity } from '../dispatch/spawner.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'

/** Maximum JSONL lines to show in the default (non-raw) view. */
const TAIL_LINES = 30
/** Maximum JSONL lines to show in raw mode. */
const RAW_TAIL_LINES = 200

interface SessionSummary {
	sessionId: string
	dirPath: string
	agents: string[]
	status: 'active' | 'completed' | 'interrupted'
}

/**
 * Determine whether a session directory represents an active session.
 * Active means: the runtime-store's logDir basename matches AND the
 * fleet state phase is not 'complete'.
 */
function isActiveSession(sessionId: string): boolean {
	const logDir = getLogDir()
	if (!logDir) return false
	if (path.basename(logDir) !== sessionId) return false
	const state = getFleetState()
	return state != null && state.phase !== 'complete'
}

/**
 * Derive a display status for a session based on its agent meta files.
 * - If any agent has status 'running' and the session is not active, it was interrupted.
 * - If all agents completed or failed normally, it's completed.
 */
async function deriveSessionStatus(
	sessionId: string,
	dirPath: string,
): Promise<'active' | 'completed' | 'interrupted'> {
	if (isActiveSession(sessionId)) return 'active'

	try {
		const entries = await fs.readdir(dirPath)
		const metaFiles = entries.filter((e) => e.endsWith('.meta.json'))

		for (const file of metaFiles) {
			try {
				const raw = await fs.readFile(path.join(dirPath, file), 'utf-8')
				const meta = JSON.parse(raw) as AgentMeta
				if (meta.status === 'running') return 'interrupted'
			} catch {
				// Unreadable meta = treat as interrupted
				return 'interrupted'
			}
		}
	} catch {
		return 'interrupted'
	}

	return 'completed'
}

/**
 * List all session directories under `.pi/logs/`.
 * Sorted newest-first.
 */
async function listSessions(logsRootDir: string): Promise<SessionSummary[]> {
	let entries: string[]
	try {
		entries = await fs.readdir(logsRootDir)
	} catch {
		return []
	}

	const base36Pattern = /^[0-9a-z]+$/i
	const sessionDirs = entries.filter((name) => base36Pattern.test(name))

	// Sort newest-first (descending by base36 value)
	sessionDirs.sort((a, b) => parseInt(b, 36) - parseInt(a, 36))

	const summaries: SessionSummary[] = []
	for (const sessionId of sessionDirs) {
		const dirPath = path.join(logsRootDir, sessionId)
		try {
			const stat = await fs.stat(dirPath)
			if (!stat.isDirectory()) continue

			const dirEntries = await fs.readdir(dirPath)
			const agents = dirEntries
				.filter((e) => e.endsWith('.jsonl'))
				.map((e) => e.replace(/\.jsonl$/, ''))

			const status = await deriveSessionStatus(sessionId, dirPath)
			summaries.push({ sessionId, dirPath, agents, status })
		} catch {
			continue
		}
	}

	return summaries
}

/**
 * Format agent meta for display.
 */
function formatMeta(meta: AgentMeta): string[] {
	const lines: string[] = []
	lines.push(`Agent: ${meta.agentName}`)
	lines.push(`Status: ${meta.status}`)
	lines.push(`Model: ${meta.model}`)
	lines.push(`Started: ${meta.startedAt}`)
	if (meta.completedAt) lines.push(`Completed: ${meta.completedAt}`)
	if (meta.durationMs != null) lines.push(`Duration: ${(meta.durationMs / 1000).toFixed(1)}s`)
	if (meta.exitCode != null) lines.push(`Exit code: ${meta.exitCode}`)
	if (meta.usage) {
		const { inputTokens, outputTokens } = meta.usage
		lines.push(`Tokens: ${inputTokens} in / ${outputTokens} out`)
	}
	return lines
}

/**
 * Extract activity summaries from raw JSONL lines.
 * Returns the human-readable activity strings (tool names, text snippets).
 */
function extractActivities(jsonlLines: string[]): string[] {
	const activities: string[] = []
	for (const line of jsonlLines) {
		const activity = extractActivity(line)
		if (activity) activities.push(activity)
	}
	return activities
}

/**
 * Handle the /fleet-logs command.
 *
 * Usage:
 *   /fleet-logs              - List all sessions
 *   /fleet-logs <agent>      - Show agent's log from the most recent session
 *   /fleet-logs <agent> --raw - Show raw JSONL output
 */
export async function handleFleetLogs(
	args: string,
	opts: { pi: ExtensionAPI; ctx: ExtensionCommandContext },
): Promise<void> {
	const { pi, ctx } = opts
	const state = getFleetState()
	const repoRoot = state?.repoRoot ?? (await preflightBootstrap({ pi })).repoRoot
	const logsRootDir = path.join(repoRoot, '.pi', 'logs')

	const parts = args.trim().split(/\s+/).filter(Boolean)
	const isRaw = parts.includes('--raw')
	const agentArg = parts.find((p) => !p.startsWith('--'))

	if (!agentArg) {
		// List sessions
		const sessions = await listSessions(logsRootDir)
		if (sessions.length === 0) {
			ctx.ui.notify('No log sessions found in .pi/logs/.', 'info')
			return
		}

		const lines: string[] = ['Fleet Log Sessions:', '']
		for (const s of sessions) {
			const statusLabel =
				s.status === 'active' ? ' (active)' :
				s.status === 'interrupted' ? ' (interrupted)' : ''
			const agentList = s.agents.length > 0 ? s.agents.join(', ') : 'no agents'
			lines.push(`  ${s.sessionId}${statusLabel}  ${agentList}`)
		}
		lines.push('')
		lines.push('Usage: /fleet-logs <agent> [--raw]')
		ctx.ui.notify(lines.join('\n'), 'info')
		return
	}

	// Find the most recent session that has this agent
	const sessions = await listSessions(logsRootDir)
	const session = sessions.find((s) => s.agents.includes(agentArg))

	if (!session) {
		ctx.ui.notify(`No logs found for agent "${agentArg}".`, 'warning')
		return
	}

	const jsonlPath = path.join(session.dirPath, `${agentArg}.jsonl`)
	const metaPath = path.join(session.dirPath, `${agentArg}.meta.json`)
	const stderrPath = path.join(session.dirPath, `${agentArg}.stderr.log`)

	if (isRaw) {
		// Raw JSONL output
		const rawLines = await tailLines(jsonlPath, RAW_TAIL_LINES)
		if (rawLines.length === 0) {
			ctx.ui.notify(`Log file is empty: ${jsonlPath}`, 'info')
			return
		}
		const output = [`--- ${agentArg} raw JSONL (last ${rawLines.length} lines) ---`, '', ...rawLines]
		ctx.ui.notify(output.join('\n'), 'info')
		return
	}

	// Default view: meta + activities + stderr + path
	const output: string[] = []

	// Meta
	try {
		const raw = await fs.readFile(metaPath, 'utf-8')
		const meta = JSON.parse(raw) as AgentMeta
		output.push(...formatMeta(meta))
	} catch {
		output.push(`Agent: ${agentArg}`)
		output.push('Meta: unavailable')
	}
	output.push('')

	// Activity extracted from JSONL
	const jsonlLines = await tailLines(jsonlPath, TAIL_LINES)
	const activities = extractActivities(jsonlLines)
	if (activities.length > 0) {
		output.push('Recent activity:')
		// Show last 15 unique activities
		const unique = [...new Set(activities)].slice(-15)
		for (const a of unique) {
			output.push(`  ${a}`)
		}
	} else {
		output.push('No activity extracted from log.')
	}
	output.push('')

	// Stderr
	try {
		const stderr = await fs.readFile(stderrPath, 'utf-8')
		const trimmed = stderr.trim()
		if (trimmed) {
			output.push('Stderr:')
			const stderrLines = trimmed.split('\n').slice(-10)
			for (const line of stderrLines) {
				output.push(`  ${line}`)
			}
			output.push('')
		}
	} catch {
		// No stderr file
	}

	// Path
	const relPath = `.pi/logs/${session.sessionId}/${agentArg}.jsonl`
	output.push(`Log: ${relPath}`)

	ctx.ui.notify(output.join('\n'), 'info')
}
