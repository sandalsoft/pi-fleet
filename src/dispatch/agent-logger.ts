import fs from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import path from 'node:path'
import type { Usage } from './types.js'

export const KEEP_LOG_SESSIONS = 5

/** Validate agent name: alphanumeric + hyphen + underscore, capped at 128 chars. */
function isValidAgentName(name: string): boolean {
	if (!name || name.length > 128) return false
	if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
	return /^[a-zA-Z0-9_-]+$/.test(name)
}

export type AgentStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface AgentMeta {
	agentName: string
	startedAt: string
	model: string
	worktreePath: string
	status: AgentStatus
	exitCode?: number
	durationMs?: number
	usage?: Usage
	completedAt?: string
}

export interface AgentLoggerCreateOpts {
	logDir: string
	agentName: string
	model: string
	worktreePath: string
}

export interface AgentLoggerCloseOpts {
	exitCode?: number
	usage?: Usage
	status?: 'completed' | 'failed' | 'aborted'
}

export class AgentLogger {
	private _stream: WriteStream
	private _disabled = false
	private _closed = false
	private _startedAtMs: number
	private _logDir: string
	private _agentName: string
	private _model: string
	private _worktreePath: string

	private constructor(
		stream: WriteStream,
		logDir: string,
		agentName: string,
		model: string,
		worktreePath: string,
		startedAtMs: number
	) {
		this._stream = stream
		this._logDir = logDir
		this._agentName = agentName
		this._model = model
		this._worktreePath = worktreePath
		this._startedAtMs = startedAtMs

		this._stream.on('error', () => {
			this._disabled = true
		})
	}

	/**
	 * Create a new AgentLogger. Never throws -- returns null on any failure.
	 * Creates the log directory, writes initial meta.json, empty stderr.log,
	 * and opens a WriteStream for the JSONL file.
	 */
	static async create(opts: AgentLoggerCreateOpts): Promise<AgentLogger | null> {
		try {
			const { logDir, agentName, model, worktreePath } = opts

			if (!isValidAgentName(agentName)) {
				console.warn(`[fleet-logger] Invalid agent name: "${agentName}", skipping logger`)
				return null
			}

			await fs.mkdir(logDir, { recursive: true })

			const startedAtMs = Date.now()

			// Write initial meta.json
			const meta: AgentMeta = {
				agentName,
				startedAt: new Date(startedAtMs).toISOString(),
				model,
				worktreePath,
				status: 'running',
			}
			await fs.writeFile(
				path.join(logDir, `${agentName}.meta.json`),
				JSON.stringify(meta, null, '\t') + '\n',
				'utf-8'
			)

			// Write empty stderr.log
			await fs.writeFile(path.join(logDir, `${agentName}.stderr.log`), '', 'utf-8')

			// Open JSONL write stream
			const stream = createWriteStream(path.join(logDir, `${agentName}.jsonl`), {
				flags: 'a',
				encoding: 'utf-8',
			})

			return new AgentLogger(stream, logDir, agentName, model, worktreePath, startedAtMs)
		} catch (err) {
			console.warn(`[fleet-logger] Failed to create logger: ${err instanceof Error ? err.message : String(err)}`)
			return null
		}
	}

	/** Append a normalized JSONL line to the agent's log file. Never throws. */
	appendLine(line: string): void {
		if (this._disabled || this._closed) return
		try {
			const ok = this._stream.write(line + '\n')
			if (!ok) {
				// Backpressure -- Node buffers internally. Fine for diagnostic logs.
			}
		} catch {
			this._disabled = true
		}
	}

	/** Write stderr content to the agent's stderr.log file. Never throws. */
	async writeStderr(content: string): Promise<void> {
		try {
			await fs.writeFile(
				path.join(this._logDir, `${this._agentName}.stderr.log`),
				content,
				'utf-8'
			)
		} catch {
			// Best effort -- don't crash the process
		}
	}

	/**
	 * Close the logger: finalize meta.json and flush the write stream.
	 * Idempotent -- second call is a no-op. Never throws.
	 */
	async close(opts?: AgentLoggerCloseOpts): Promise<void> {
		if (this._closed) return
		this._closed = true

		try {
			const now = Date.now()
			const durationMs = now - this._startedAtMs

			const status: AgentStatus = opts?.status
				?? (opts?.exitCode === 0 ? 'completed' : 'failed')

			const meta: AgentMeta = {
				agentName: this._agentName,
				startedAt: new Date(this._startedAtMs).toISOString(),
				model: this._model,
				worktreePath: this._worktreePath,
				status,
				exitCode: opts?.exitCode,
				durationMs,
				usage: opts?.usage,
				completedAt: new Date(now).toISOString(),
			}

			await fs.writeFile(
				path.join(this._logDir, `${this._agentName}.meta.json`),
				JSON.stringify(meta, null, '\t') + '\n',
				'utf-8'
			)
		} catch {
			// Best effort
		}

		try {
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					this._stream.destroy()
					resolve()
				}, 5000)
				this._stream.on('error', () => {
					clearTimeout(timeout)
					resolve()
				})
				this._stream.end(() => {
					clearTimeout(timeout)
					resolve()
				})
			})
		} catch {
			// Best effort
		}
	}

	/** Get the agent name associated with this logger. */
	get agentName(): string {
		return this._agentName
	}
}

/**
 * Rotate session log directories, keeping only the most recent `keepCount`.
 * Session dirs are named as base-36 timestamps (e.g., "m1a2b3c").
 * Filters with exact base36 regex, sorts numerically, removes oldest.
 * Never throws.
 */
export async function rotateSessionLogs(logsRootDir: string, keepCount: number): Promise<void> {
	try {
		let entries: string[]
		try {
			entries = await fs.readdir(logsRootDir)
		} catch {
			return // Directory doesn't exist yet, nothing to rotate
		}

		// Filter to valid base36 session directory names
		const base36Pattern = /^[0-9a-z]+$/i
		const sessionDirs = entries.filter((name) => base36Pattern.test(name))

		if (sessionDirs.length <= keepCount) return

		// Sort numerically by base36 value (ascending = oldest first)
		sessionDirs.sort((a, b) => parseInt(a, 36) - parseInt(b, 36))

		// Remove the oldest entries beyond keepCount
		const toRemove = sessionDirs.slice(0, sessionDirs.length - keepCount)
		for (const dir of toRemove) {
			await fs.rm(path.join(logsRootDir, dir), { recursive: true, force: true })
		}
	} catch {
		// Best effort -- don't crash over log rotation
	}
}

/**
 * Read the last N lines from a file. Returns empty array on ENOENT or n <= 0.
 * Normalizes CRLF to LF. Handles files with no trailing newline (includes partial last line).
 * Never throws.
 */
export async function tailLines(filePath: string, n: number): Promise<string[]> {
	if (n <= 0) return []
	try {
		const buf = await fs.readFile(filePath)
		const content = buf.toString('utf-8').replace(/\r\n/g, '\n')
		if (content.length === 0) return []

		// Split, but handle missing trailing newline
		const lines = content.endsWith('\n')
			? content.slice(0, -1).split('\n')
			: content.split('\n')

		return lines.slice(-n)
	} catch (err: unknown) {
		if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
			return []
		}
		return []
	}
}
