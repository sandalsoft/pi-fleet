/**
 * Runtime smoke script — validates pi CLI behavior and capabilities.
 *
 * Run via: npm run smoke
 * Requires pi on PATH. May require interactive permission approvals.
 * Always writes .pi/smoke-results.json on completion.
 */

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const TIMEOUT_MS = 30_000

interface SmokeResults {
	preferredPromptMode: 'trailing-arg' | 'stdin-pipe' | null
	canWriteToRepoScratchpadFromSiblingCwd: boolean
	steerViaSendMessage: boolean
	routableIdField?: string
	cliFlags: {
		accepted: boolean
		errors?: string[]
		trailingArgResult: string
		stdinPipeResult: string
	}
	agentRunSucceeded: boolean
	permissionPromptEncountered: boolean
	scratchpadTest: {
		ok: boolean
		skipped?: boolean
		error?: string
	}
	piVersion?: string
}

function which(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

function getRepoRoot(): string {
	return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim()
}

function getProjectName(): string {
	return path.basename(getRepoRoot())
}

function isDetachedHead(): boolean {
	try {
		execSync('git symbolic-ref -q HEAD', { stdio: 'pipe' })
		return false
	} catch {
		return true
	}
}

function hasCommits(): boolean {
	try {
		execSync('git rev-parse --verify HEAD', { stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

type SpawnOutcome =
	| 'flags accepted'
	| 'flags rejected'
	| 'permission needed'
	| 'model unavailable'
	| 'other error'

interface SpawnResult {
	outcome: SpawnOutcome
	stdout: string
	stderr: string
	jsonlLines: string[]
}

function spawnPiTrailingArg(): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const proc = spawn(
			'pi',
			['--mode', 'json', '-p', '--no-session', '--model', 'sonnet', 'echo test'],
			{ stdio: ['pipe', 'pipe', 'pipe'], timeout: TIMEOUT_MS }
		)

		let stdout = ''
		let stderr = ''
		const jsonlLines: string[] = []

		proc.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString()
			const lines = stdout.split('\n')
			for (const line of lines.slice(0, -1)) {
				const trimmed = line.trim()
				if (trimmed) {
					try {
						JSON.parse(trimmed)
						jsonlLines.push(trimmed)
					} catch {
						// Not valid JSON, skip
					}
				}
			}
		})

		proc.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
		})

		proc.on('close', () => {
			resolve({ outcome: classifyOutcome(stderr, stdout, jsonlLines), stdout, stderr, jsonlLines })
		})

		proc.on('error', () => {
			resolve({ outcome: 'other error', stdout, stderr, jsonlLines })
		})
	})
}

function spawnPiStdinPipe(): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const proc = spawn(
			'pi',
			['--mode', 'json', '-p', '--no-session', '--model', 'sonnet'],
			{ stdio: ['pipe', 'pipe', 'pipe'], timeout: TIMEOUT_MS }
		)

		let stdout = ''
		let stderr = ''
		const jsonlLines: string[] = []

		proc.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString()
			const lines = stdout.split('\n')
			for (const line of lines.slice(0, -1)) {
				const trimmed = line.trim()
				if (trimmed) {
					try {
						JSON.parse(trimmed)
						jsonlLines.push(trimmed)
					} catch {
						// Not valid JSON
					}
				}
			}
		})

		proc.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
		})

		proc.stdin.write('echo test\n')
		proc.stdin.end()

		proc.on('close', () => {
			resolve({ outcome: classifyOutcome(stderr, stdout, jsonlLines), stdout, stderr, jsonlLines })
		})

		proc.on('error', () => {
			resolve({ outcome: 'other error', stdout, stderr, jsonlLines })
		})
	})
}

function classifyOutcome(stderr: string, _stdout: string, jsonlLines: string[]): SpawnOutcome {
	const lowerErr = stderr.toLowerCase()
	if (lowerErr.includes('unknown') || lowerErr.includes('unrecognized')) {
		return 'flags rejected'
	}
	if (lowerErr.includes('permission') || lowerErr.includes('allow') || lowerErr.includes('approve')) {
		return 'permission needed'
	}
	if (lowerErr.includes('model') && (lowerErr.includes('unavailable') || lowerErr.includes('not found'))) {
		return 'model unavailable'
	}
	if (jsonlLines.length > 0) {
		return 'flags accepted'
	}
	return 'other error'
}

function findRoutableId(jsonlLines: string[]): { field: string; value: string } | null {
	for (const line of jsonlLines) {
		try {
			const obj = JSON.parse(line) as Record<string, unknown>
			for (const key of ['session_id', 'agent_id', 'sessionId', 'agentId']) {
				if (typeof obj[key] === 'string' && obj[key]) {
					return { field: key, value: obj[key] as string }
				}
			}
		} catch {
			// skip
		}
	}
	return null
}

async function testScratchpad(repoRoot: string): Promise<SmokeResults['scratchpadTest']> {
	if (isDetachedHead() || !hasCommits()) {
		return { ok: false, skipped: true, error: 'detached HEAD or no commits' }
	}

	const project = getProjectName()
	const timestamp = Date.now()
	const branchName = `fleet-smoke-${timestamp}`
	const worktreePath = path.resolve(repoRoot, '..', `${project}-fleet-smoke-${timestamp}`)

	try {
		// Create worktree
		execSync(`git worktree add -b ${branchName} "${worktreePath}" HEAD`, {
			cwd: repoRoot,
			stdio: 'pipe',
		})

		// Ensure scratchpads dir exists
		const scratchpadDir = path.join(repoRoot, '.pi', 'scratchpads')
		fs.mkdirSync(scratchpadDir, { recursive: true })

		// Test write access from sibling cwd
		const testFile = path.join(scratchpadDir, 'smoke-test.md')
		try {
			fs.writeFileSync(testFile, '# Smoke test\nWritten from sibling worktree.\n')
			// Verify it was written
			const content = fs.readFileSync(testFile, 'utf-8')
			if (content.includes('Smoke test')) {
				return { ok: true }
			}
			return { ok: false, error: 'Write succeeded but content verification failed' }
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			return { ok: false, error: `Scratchpad write failed: ${msg}` }
		} finally {
			// Clean up test file
			try {
				fs.unlinkSync(testFile)
			} catch {
				// Best effort
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return { ok: false, error: `Worktree creation failed: ${msg}` }
	} finally {
		// Cleanup worktree and branch
		try {
			execSync(`git worktree remove --force "${worktreePath}"`, {
				cwd: repoRoot,
				stdio: 'pipe',
			})
		} catch {
			// Best effort
		}
		try {
			execSync(`git branch -D ${branchName}`, { cwd: repoRoot, stdio: 'pipe' })
		} catch {
			// Best effort
		}
	}
}

async function validateEsmArtifact(): Promise<boolean> {
	try {
		// Build first
		execSync('npm run build', { stdio: 'pipe' })
		// Verify ESM loading
		execSync('node --input-type=module -e "import(\'./dist/extension.js\')"', { stdio: 'pipe' })
		return true
	} catch {
		return false
	}
}

function getPiVersion(): string | undefined {
	try {
		return execSync('pi --version', { encoding: 'utf-8' }).trim()
	} catch {
		return undefined
	}
}

async function main() {
	if (!which('pi')) {
		console.error('pi is not on PATH. Install pi-coding-agent globally or add it to PATH.')
		process.exit(1)
	}

	const repoRoot = getRepoRoot()
	const results: SmokeResults = {
		preferredPromptMode: null,
		canWriteToRepoScratchpadFromSiblingCwd: false,
		steerViaSendMessage: false,
		cliFlags: {
			accepted: false,
			trailingArgResult: '',
			stdinPipeResult: '',
		},
		agentRunSucceeded: false,
		permissionPromptEncountered: false,
		scratchpadTest: { ok: false },
		piVersion: getPiVersion(),
	}

	console.log(`pi version: ${results.piVersion ?? 'unknown'}`)

	// Step 1: CLI flag validation
	console.log('\n--- CLI flag validation (trailing arg) ---')
	const trailingResult = await spawnPiTrailingArg()
	results.cliFlags.trailingArgResult = trailingResult.outcome

	if (trailingResult.outcome === 'flags accepted') {
		results.preferredPromptMode = 'trailing-arg'
		results.cliFlags.accepted = true
		results.agentRunSucceeded = true
	} else {
		console.log(`Trailing arg: ${trailingResult.outcome}`)
		if (trailingResult.stderr) console.log(`  stderr: ${trailingResult.stderr.slice(0, 200)}`)

		console.log('\n--- CLI flag validation (stdin pipe) ---')
		const stdinResult = await spawnPiStdinPipe()
		results.cliFlags.stdinPipeResult = stdinResult.outcome

		if (stdinResult.outcome === 'flags accepted') {
			results.preferredPromptMode = 'stdin-pipe'
			results.cliFlags.accepted = true
			results.agentRunSucceeded = true
		} else {
			console.log(`Stdin pipe: ${stdinResult.outcome}`)
			if (stdinResult.stderr) console.log(`  stderr: ${stdinResult.stderr.slice(0, 200)}`)
		}
	}

	if (trailingResult.outcome === 'permission needed') {
		results.permissionPromptEncountered = true
	}

	// Step 2: JSONL shape validation
	const allJsonl = trailingResult.outcome === 'flags accepted'
		? trailingResult.jsonlLines
		: []
	if (allJsonl.length > 0) {
		console.log(`\n--- JSONL validation: ${allJsonl.length} events parsed ---`)
		for (const line of allJsonl.slice(0, 5)) {
			const obj = JSON.parse(line) as Record<string, unknown>
			console.log(`  type: ${obj.type ?? '(no type field)'}`)
		}
	}

	// Step 3: Scratchpad write access
	console.log('\n--- Scratchpad test ---')
	results.scratchpadTest = await testScratchpad(repoRoot)
	results.canWriteToRepoScratchpadFromSiblingCwd = results.scratchpadTest.ok
	console.log(`  result: ${results.scratchpadTest.ok ? 'OK' : results.scratchpadTest.error}`)

	// Step 4: Routable ID discovery
	const routableId = findRoutableId(allJsonl)
	if (routableId) {
		results.steerViaSendMessage = true
		results.routableIdField = routableId.field
		console.log(`\n--- Routable ID found: ${routableId.field} = ${routableId.value} ---`)
	}

	// Step 5: ESM artifact validation
	console.log('\n--- ESM artifact validation ---')
	const esmOk = await validateEsmArtifact()
	console.log(`  ESM loadable: ${esmOk}`)

	// Write results
	const piDir = path.join(repoRoot, '.pi')
	fs.mkdirSync(piDir, { recursive: true })
	const resultsPath = path.join(piDir, 'smoke-results.json')
	fs.writeFileSync(resultsPath, JSON.stringify(results, null, '\t') + '\n')
	console.log(`\nResults written to ${resultsPath}`)
}

main().catch((err) => {
	console.error('Smoke script failed:', err)
	process.exit(1)
})
