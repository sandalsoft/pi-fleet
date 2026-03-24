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
export function parseJsonlStream(raw: string): { report: string; usage: Usage } {
	const lines = raw.split('\n').filter((l) => l.trim().length > 0)
	let lastAssistantContent = ''
	let totalUsage = emptyUsage()

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

		// Top-level usage events (message_end, result, etc.)
		if (type === 'message_end' || type === 'result') {
			const evtUsage = parsed.usage as Record<string, unknown> | undefined
			if (evtUsage) {
				totalUsage = addUsage(totalUsage, normalizeUsage(evtUsage))
			}
		}

		// Skip tool_use, tool_result, system, and other types silently
	}

	return { report: lastAssistantContent, usage: totalUsage }
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

	let stdout = ''
	let stderr = ''

	child.stdout?.on('data', (chunk: Buffer) => {
		stdout += chunk.toString()
	})

	child.stderr?.on('data', (chunk: Buffer) => {
		stderr += chunk.toString()
	})

	const exitCode = await new Promise<number>((resolve) => {
		child.on('close', (code) => resolve(code ?? 1))
		child.on('error', () => resolve(1))
	})

	return { stdout, stderr, exitCode, process: child }
}

function buildSpawnResult(
	raw: RawSpawnResult,
	runId: string,
	agentName: string,
	worktreePath: string,
	model: string,
	abortController: AbortController
): SpawnResult {
	const { report, usage } = parseJsonlStream(raw.stdout)

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

	return { runtime, report, usage }
}
