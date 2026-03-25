import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
	SpecialistRuntime,
	SpawnResult,
	Usage,
	PromptMode,
	SmokeResults,
} from './types.js'
import { normalizeUsage, emptyUsage, addUsage } from './types.js'

export interface SpawnSpecialistOpts {
	agentName: string
	model: string
	worktreePath: string
	prompt: string
	timeoutMs: number
	repoRoot: string
	cancelSignal?: AbortSignal
	/** Called with each JSONL line as it streams from the subprocess */
	onStreamLine?: (line: string) => void
}

/**
 * Read the preferred prompt mode from .pi/smoke-results.json.
 * Returns null if the file is missing or unparseable.
 */
export async function readSmokeResults(repoRoot: string): Promise<SmokeResults | null> {
	const filePath = path.join(repoRoot, '.pi', 'smoke-results.json')
	try {
		const raw = await fs.readFile(filePath, 'utf-8')
		const data = JSON.parse(raw)
		return {
			preferredPromptMode: data.preferredPromptMode ?? null,
			canWriteToRepoScratchpadFromSiblingCwd: data.canWriteToRepoScratchpadFromSiblingCwd,
		}
	} catch {
		return null
	}
}

/**
 * Decide which prompt delivery mode to use.
 * If smoke-results has a preference, honor it.
 * Otherwise default to trailing-arg (with fallback handled by caller).
 */
export function resolvePromptMode(smokeResults: SmokeResults | null): PromptMode {
	if (smokeResults?.preferredPromptMode) {
		return smokeResults.preferredPromptMode
	}
	return 'trailing-arg'
}

/**
 * Parse a complete JSONL stream from pi's JSON mode output.
 *
 * Tolerant parsing:
 * - Accepts event type variants (message_end, assistant_message_end)
 * - Ignores unknown event types
 * - Buffers partial lines
 * - Extracts last assistant message content as the specialist report
 * - Normalizes usage data from both snake_case and camelCase
 */
export interface ParsedStream {
	report: string
	usage: Usage
	/** Error messages extracted from error events and failed tool results. */
	errorDetails: string[]
}

export function parseJsonlStream(raw: string): ParsedStream {
	const lines = raw.split('\n').filter((l) => l.trim().length > 0)
	let lastAssistantContent = ''
	let totalUsage = emptyUsage()
	const errorDetails: string[] = []

	for (const line of lines) {
		let parsed: Record<string, unknown>
		try {
			parsed = JSON.parse(line)
		} catch {
			// Partial or malformed line, skip
			continue
		}

		const type = parsed.type as string | undefined
		if (!type) continue

		// Extract assistant message content (take the last one)
		if (type === 'assistant_message' || type === 'assistant_message_end') {
			const msg = parsed.message as Record<string, unknown> | undefined
			if (msg) {
				const content = extractTextContent(msg.content)
				if (content) lastAssistantContent = content
			}
			// Check for usage on the message
			const msgUsage = msg?.usage as Record<string, unknown> | undefined
			if (msgUsage) {
				totalUsage = addUsage(totalUsage, normalizeUsage(msgUsage))
			}
		}

		// Also check for subtype=end pattern from the fixture
		if (type === 'assistant_message' && parsed.subtype === 'end') {
			const msg = parsed.message as Record<string, unknown> | undefined
			if (msg) {
				const content = extractTextContent(msg.content)
				if (content) lastAssistantContent = content
			}
			const msgUsage = (msg?.usage ?? parsed.usage) as Record<string, unknown> | undefined
			if (msgUsage) {
				totalUsage = addUsage(totalUsage, normalizeUsage(msgUsage))
			}
		}

		// Pi SDK "done" event — contains final AssistantMessage with usage
		if (type === 'done' || type === 'error') {
			const msg = (parsed.message ?? parsed.error) as Record<string, unknown> | undefined
			if (msg) {
				const content = extractTextContent(msg.content)
				if (content) lastAssistantContent = content
				const msgUsage = msg.usage as Record<string, unknown> | undefined
				if (msgUsage) {
					totalUsage = addUsage(totalUsage, normalizeUsage(msgUsage))
				}
				// Capture error message
				if (type === 'error') {
					const errMsg = typeof msg.errorMessage === 'string' ? msg.errorMessage : ''
					if (errMsg) errorDetails.push(errMsg)
					if (content) errorDetails.push(content)
				}
			}
		}

		// Capture failed tool results
		if (type === 'tool_result' || type === 'tool_execution_end') {
			const isError = parsed.is_error === true || parsed.isError === true
			if (isError) {
				const content = extractTextContent(parsed.content)
				const result = typeof parsed.result === 'string' ? parsed.result : ''
				const detail = content || result
				if (detail) errorDetails.push(`Tool error: ${detail.slice(0, 500)}`)
			}
		}

		// Top-level usage events (message_end, result, etc.)
		if (type === 'message_end' || type === 'result') {
			const evtUsage = parsed.usage as Record<string, unknown> | undefined
			if (evtUsage) {
				totalUsage = addUsage(totalUsage, normalizeUsage(evtUsage))
			}
		}

		// Skip tool_use, tool_result, system, and other types silently
	}

	return { report: lastAssistantContent, usage: totalUsage, errorDetails }
}

/**
 * Extract text content from a pi message content array or string.
 */
function extractTextContent(content: unknown): string {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''

	const textParts: string[] = []
	for (const part of content) {
		if (typeof part === 'string') {
			textParts.push(part)
		} else if (part && typeof part === 'object' && 'type' in part) {
			const obj = part as Record<string, unknown>
			if (obj.type === 'text' && typeof obj.text === 'string') {
				textParts.push(obj.text)
			}
		}
	}
	return textParts.join('')
}

/**
 * Extract usage data from a streaming JSONL line.
 * Returns normalized usage if the line contains usage info, null otherwise.
 *
 * Usage appears in:
 * - assistant_message with subtype "end" → message.usage
 * - done/error events → message.usage
 * - message_end events → usage
 */
export function extractStreamingUsage(line: string): Usage | null {
	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(line)
	} catch {
		return null
	}

	const type = parsed.type as string | undefined
	if (!type) return null

	// assistant_message subtype end — has per-turn usage
	if (type === 'assistant_message' && parsed.subtype === 'end') {
		const msg = parsed.message as Record<string, unknown> | undefined
		const usage = (msg?.usage ?? parsed.usage) as Record<string, unknown> | undefined
		if (usage) return normalizeUsage(usage)
	}

	// assistant_message_end variant
	if (type === 'assistant_message_end') {
		const msg = parsed.message as Record<string, unknown> | undefined
		const usage = msg?.usage as Record<string, unknown> | undefined
		if (usage) return normalizeUsage(usage)
	}

	// done/error events — final usage
	if (type === 'done' || type === 'error') {
		const msg = (parsed.message ?? parsed.error) as Record<string, unknown> | undefined
		const usage = msg?.usage as Record<string, unknown> | undefined
		if (usage) return normalizeUsage(usage)
	}

	// message_end — top-level usage
	if (type === 'message_end' || type === 'result') {
		const usage = parsed.usage as Record<string, unknown> | undefined
		if (usage) return normalizeUsage(usage)
	}

	// turn_end — agent-level usage
	if (type === 'turn_end') {
		const msg = parsed.message as Record<string, unknown> | undefined
		const usage = msg?.usage as Record<string, unknown> | undefined
		if (usage) return normalizeUsage(usage)
	}

	return null
}

/**
 * Extract a human-readable activity description from a JSONL streaming line.
 * Returns null if the line doesn't contain actionable information.
 */
export function extractActivity(line: string): string | null {
	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(line)
	} catch {
		return null
	}

	const type = parsed.type as string | undefined
	if (!type) return null

	// Top-level tool_use event (pi emits these as standalone events)
	if (type === 'tool_use') {
		return formatToolActivity(
			parsed.name as string,
			parsed.input as Record<string, unknown>,
		)
	}

	// Pi agent tool_execution_start event
	if (type === 'tool_execution_start') {
		return formatToolActivity(
			parsed.toolName as string,
			parsed.args as Record<string, unknown>,
		)
	}

	// Assistant message with content blocks (tool_use or text inside content array)
	if (type === 'assistant_message' || type === 'message_update' || type === 'content_block_start') {
		const content = extractContentBlocks(parsed)
		for (const block of content) {
			if (block.type === 'tool_use') {
				return formatToolActivity(block.name as string, block.input as Record<string, unknown>)
			}
		}
		// Text blocks — short snippet of what the agent is saying
		for (const block of content) {
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
				return truncate(block.text.trim(), 60)
			}
		}
	}

	// Pi SDK toolcall_start event
	if (type === 'toolcall_start') {
		const toolCall = parsed.toolCall as Record<string, unknown> | undefined
		if (toolCall) {
			return formatToolActivity(
				toolCall.name as string,
				toolCall.arguments as Record<string, unknown>,
			)
		}
	}

	// Content block with tool_use type directly
	if (type === 'content_block_start') {
		const block = parsed.content_block as Record<string, unknown> | undefined
		if (block?.type === 'tool_use') {
			return formatToolActivity(block.name as string, block.input as Record<string, unknown>)
		}
	}

	// Tool result — brief indication
	if (type === 'tool_result' || type === 'tool_execution_end') {
		return 'processing tool result...'
	}

	return null
}

function extractContentBlocks(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
	// Direct content array on the event
	const content = parsed.content as unknown
	if (Array.isArray(content)) return content

	// Nested under message.content
	const msg = parsed.message as Record<string, unknown> | undefined
	if (msg) {
		const msgContent = msg.content as unknown
		if (Array.isArray(msgContent)) return msgContent
	}

	return []
}

function formatToolActivity(toolName: string, input: Record<string, unknown> | null | undefined): string {
	if (!toolName) return 'using tool...'

	// Map tool names to friendly descriptions
	const pathArg = input?.file_path ?? input?.path ?? input?.pattern ?? input?.command
	const shortPath = typeof pathArg === 'string' ? truncate(pathArg, 40) : ''

	switch (toolName.toLowerCase()) {
		case 'read': return `reading ${shortPath}`
		case 'edit': return `editing ${shortPath}`
		case 'write': return `writing ${shortPath}`
		case 'bash': return `running ${shortPath || 'command'}`
		case 'grep': return `searching ${shortPath || 'codebase'}`
		case 'glob': return `finding ${shortPath || 'files'}`
		case 'agent': return 'spawning subagent...'
		default: return `${toolName} ${shortPath}`.trim()
	}
}

function truncate(text: string, maxLen: number): string {
	const oneLine = text.replace(/\n/g, ' ')
	if (oneLine.length <= maxLen) return oneLine
	return oneLine.slice(0, maxLen - 1) + '\u2026'
}

/**
 * Spawn a pi subprocess in JSON mode as a specialist agent.
 *
 * Uses Node.js child_process.spawn() (NOT pi.exec()) for JSONL streaming.
 * Implements dual-mode prompt delivery: trailing arg first, stdin pipe fallback.
 *
 * Returns a SpawnResult with the SpecialistRuntime, extracted report, and usage.
 */
export async function spawnSpecialist(opts: SpawnSpecialistOpts): Promise<SpawnResult> {
	const {
		agentName,
		model,
		worktreePath,
		prompt,
		timeoutMs,
		repoRoot,
		cancelSignal,
		onStreamLine,
	} = opts

	const runId = crypto.randomUUID()

	// Read smoke results for prompt mode preference
	const smokeResults = await readSmokeResults(repoRoot)
	const promptMode = resolvePromptMode(smokeResults)

	// Build abort controller combining user cancel and timeout
	const abortController = new AbortController()
	const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

	const signals = cancelSignal
		? [abortController.signal, cancelSignal]
		: [abortController.signal]
	const combinedSignal = signals.length > 1
		? AbortSignal.any(signals)
		: signals[0]

	try {
		const result = await spawnWithMode(promptMode, {
			model,
			worktreePath,
			prompt,
			signal: combinedSignal,
			abortController,
			runId,
			agentName,
			onStreamLine,
		})

		// If trailing-arg mode failed and we haven't tried stdin yet, retry
		if (result.exitCode !== 0 && promptMode === 'trailing-arg' && !smokeResults?.preferredPromptMode) {
			const stderrLower = result.stderr.toLowerCase()
			if (stderrLower.includes('unknown') || stderrLower.includes('unrecognized')) {
				const fallbackResult = await spawnWithMode('stdin-pipe', {
					model,
					worktreePath,
					prompt,
					signal: combinedSignal,
					abortController,
					runId,
					agentName,
					onStreamLine,
				})
				return buildSpawnResult(fallbackResult, runId, agentName, worktreePath, model, abortController)
			}
		}

		return buildSpawnResult(result, runId, agentName, worktreePath, model, abortController)
	} finally {
		clearTimeout(timeoutId)
	}
}

interface InternalSpawnOpts {
	model: string
	worktreePath: string
	prompt: string
	signal: AbortSignal
	abortController: AbortController
	runId: string
	agentName: string
	onStreamLine?: (line: string) => void
}

interface RawSpawnResult {
	stdout: string
	stderr: string
	exitCode: number
	process: import('node:child_process').ChildProcess
}

async function spawnWithMode(
	mode: PromptMode,
	opts: InternalSpawnOpts
): Promise<RawSpawnResult> {
	const baseArgs = ['--mode', 'json', '-p', '--no-session', '--model', opts.model]

	const args = mode === 'trailing-arg'
		? [...baseArgs, opts.prompt]
		: baseArgs

	const child = spawn('pi', args, {
		cwd: opts.worktreePath,
		stdio: mode === 'stdin-pipe' ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
		signal: opts.signal,
	})

	if (mode === 'stdin-pipe' && child.stdin) {
		child.stdin.write(opts.prompt)
		child.stdin.end()
	}

	const allLines: string[] = []
	let lineBuffer = ''
	let stderr = ''

	child.stdout?.on('data', (chunk: Buffer) => {
		lineBuffer += chunk.toString()
		const parts = lineBuffer.split('\n')
		lineBuffer = parts.pop()! // Keep incomplete last line in buffer
		for (const line of parts) {
			const trimmed = line.trim()
			if (trimmed) {
				allLines.push(trimmed)
				opts.onStreamLine?.(trimmed)
			}
		}
	})

	child.stderr?.on('data', (chunk: Buffer) => {
		stderr += chunk.toString()
	})

	const exitCode = await new Promise<number>((resolve) => {
		child.on('close', (code) => resolve(code ?? 1))
		child.on('error', () => resolve(1))
	})

	// Flush any remaining buffered content
	if (lineBuffer.trim()) {
		allLines.push(lineBuffer.trim())
		opts.onStreamLine?.(lineBuffer.trim())
	}

	return { stdout: allLines.join('\n'), stderr, exitCode, process: child }
}

function buildSpawnResult(
	raw: RawSpawnResult,
	runId: string,
	agentName: string,
	worktreePath: string,
	model: string,
	abortController: AbortController
): SpawnResult {
	const { report, usage, errorDetails } = parseJsonlStream(raw.stdout)

	const runtime: SpecialistRuntime = {
		runId,
		pid: raw.process.pid ?? 0,
		agentName,
		worktreePath,
		model,
		status: raw.exitCode === 0 ? 'completed' : 'failed',
		abortController,
		process: raw.process,
	}

	return { runtime, report, usage, exitCode: raw.exitCode, stderr: raw.stderr, errorDetails }
}
