import path from 'node:path'
import fs from 'node:fs/promises'
import type { FleetState, SpecialistRecord } from '../session/state.js'

/**
 * Standardized scratchpad steer entry format.
 * Multiple steers produce parseable, ordered content separated by `---`.
 */
function formatSteerEntry(message: string, source: string): string {
	const timestamp = new Date().toISOString()
	return `\n\n---\n\n[STEER ${timestamp} from=${source}]\n${message}`
}

/**
 * Validate that an agent name is safe for path construction.
 * Rejects path traversal attempts and characters outside alphanumeric + hyphen + underscore.
 */
function isValidAgentName(name: string): boolean {
	if (!name || name.length > 128) return false
	if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
	return /^[a-zA-Z0-9_-]+$/.test(name)
}

export interface SteerContext {
	ui: {
		notify(message: string, level: 'info' | 'warning' | 'error'): void
	}
}

export interface SendMessageFn {
	(opts: { to: string; content: string; deliverAs: string }): Promise<void>
}

export interface SteerOpts {
	repoRoot: string
	state: FleetState
	ctx: SteerContext
	sendMessage?: SendMessageFn
	source?: string
}

export interface SteerResult {
	delivered: boolean
	targets: string[]
	method: 'scratchpad' | 'sendMessage' | 'mixed'
	errors: string[]
}

/**
 * Parse /fleet-steer args into agent name and message.
 * Format: "<agent-name> <message>"
 */
export function parseSteerArgs(args: string): { agentName: string; message: string } | null {
	const trimmed = args.trim()
	const spaceIdx = trimmed.indexOf(' ')
	if (spaceIdx === -1) return null

	const agentName = trimmed.slice(0, spaceIdx)
	const message = trimmed.slice(spaceIdx + 1).trim()
	if (!message) return null

	return { agentName, message }
}

/**
 * Resolve target agents from a name string.
 * Handles "all" (all running), "dispatcher" (the orchestrator), or a specific agent name.
 */
export function resolveTargets(
	agentName: string,
	state: FleetState
): { targets: SpecialistRecord[]; error: string | null } {
	if (agentName === 'all') {
		const running = Array.from(state.specialists.values()).filter((s) => s.status === 'running')
		if (running.length === 0) {
			return { targets: [], error: 'No agents are currently running' }
		}
		return { targets: running, error: null }
	}

	if (agentName === 'dispatcher') {
		// Dispatcher is the orchestrator, not a specialist in the roster.
		// Steer via scratchpad using the name "dispatcher".
		return {
			targets: [
				{
					agentName: 'dispatcher',
					runId: 'dispatcher',
					pid: process.pid,
					worktreePath: '',
					model: 'dispatcher',
					status: 'running',
				},
			],
			error: null,
		}
	}

	const specialist = state.specialists.get(agentName)
	if (!specialist) {
		const available = Array.from(state.specialists.keys())
		const hint = available.length > 0 ? ` Available: ${available.join(', ')}` : ''
		return { targets: [], error: `Agent "${agentName}" not found.${hint}` }
	}

	if (specialist.status !== 'running') {
		return {
			targets: [],
			error: `Agent "${agentName}" has already ${specialist.status}. Steering only applies to running agents.`,
		}
	}

	return { targets: [specialist], error: null }
}

/**
 * Append a steer message to an agent's scratchpad file.
 */
async function writeScratchpad(
	repoRoot: string,
	agentName: string,
	message: string,
	source: string
): Promise<void> {
	const scratchpadDir = path.join(repoRoot, '.pi', 'scratchpads')
	await fs.mkdir(scratchpadDir, { recursive: true })
	const filePath = path.join(scratchpadDir, `${agentName}.md`)
	const entry = formatSteerEntry(message, source)
	await fs.appendFile(filePath, entry, 'utf-8')
}

/**
 * Handle a /fleet-steer command.
 * Routes a message to one or more agents via scratchpad (primary) or sendMessage (upgrade path).
 */
export async function handleSteer(args: string, opts: SteerOpts): Promise<SteerResult> {
	const { repoRoot, state, ctx, sendMessage, source = 'user' } = opts

	const parsed = parseSteerArgs(args)
	if (!parsed) {
		ctx.ui.notify('Usage: /fleet-steer <agent-name> <message>', 'warning')
		return { delivered: false, targets: [], method: 'scratchpad', errors: ['Invalid arguments'] }
	}

	const { agentName, message } = parsed

	// Path traversal protection
	if (agentName !== 'all' && agentName !== 'dispatcher' && !isValidAgentName(agentName)) {
		ctx.ui.notify(`Invalid agent name: "${agentName}". Names must be alphanumeric with hyphens/underscores.`, 'error')
		return { delivered: false, targets: [], method: 'scratchpad', errors: ['Invalid agent name'] }
	}

	const { targets, error } = resolveTargets(agentName, state)
	if (error) {
		ctx.ui.notify(error, 'warning')
		return { delivered: false, targets: [], method: 'scratchpad', errors: [error] }
	}

	const targetNames: string[] = []
	const errors: string[] = []
	let usedScratchpad = false
	let usedSendMessage = false

	for (const target of targets) {
		// Validate each target name before constructing scratchpad path
		if (!isValidAgentName(target.agentName)) {
			errors.push(`Skipping agent with invalid name: "${target.agentName}"`)
			continue
		}

		// Upgrade path: use sendMessage if hostRoutableId is available
		if (target.hostRoutableId && sendMessage) {
			try {
				await sendMessage({
					to: target.hostRoutableId,
					content: message,
					deliverAs: 'steer',
				})
				targetNames.push(target.agentName)
				usedSendMessage = true
				continue
			} catch {
				// Fall through to scratchpad if sendMessage fails
			}
		}

		// Primary v1 mechanism: scratchpad steering
		try {
			await writeScratchpad(repoRoot, target.agentName, message, source)
			targetNames.push(target.agentName)
			usedScratchpad = true
		} catch (err) {
			const msg = `Failed to write scratchpad for ${target.agentName}: ${err instanceof Error ? err.message : String(err)}`
			errors.push(msg)
			ctx.ui.notify(msg, 'error')
		}
	}

	if (targetNames.length === 0) {
		return { delivered: false, targets: targetNames, method: 'scratchpad', errors }
	}

	// Notify user of delivery semantics
	const nameList = targetNames.join(', ')
	if (usedSendMessage && !usedScratchpad) {
		ctx.ui.notify(`Steer sent to ${nameList} via direct message. Agent will see it after current tool execution completes.`, 'info')
	} else if (usedScratchpad && !usedSendMessage) {
		ctx.ui.notify(`Steer written to scratchpad for ${nameList}. Agent will see it on next scratchpad read (best-effort cooperative).`, 'info')
	} else {
		ctx.ui.notify(`Steer delivered to ${nameList} via mixed channels. Scratchpad is best-effort; direct message arrives after tool execution.`, 'info')
	}

	const method = usedSendMessage && usedScratchpad ? 'mixed' : usedSendMessage ? 'sendMessage' : 'scratchpad'

	return { delivered: true, targets: targetNames, method, errors }
}
