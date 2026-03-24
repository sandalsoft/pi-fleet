import path from 'node:path'
import fs from 'node:fs/promises'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { preflightBootstrap, preflightRunChecks } from './preflight.js'
import { runSetupWizard } from './setup/wizard.js'
import { handleSteer } from './steer/handler.js'
import { handleStatus } from './status/display.js'
import { getFleetState } from './session/runtime-store.js'
import { createEventLogReader } from './session/event-log.js'

// Runtime-available APIs not yet in the ExtensionAPI type definitions.
// These are documented in pi SDK examples (bookmark.ts, plan-mode/index.ts).
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

			// Always resolve repoRoot first (cheap: git checks only)
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

				// After wizard, teams.yaml now exists. Re-check before continuing.
				try {
					await fs.access(teamsPath)
				} catch {
					ctx.ui.notify('Setup did not create teams.yaml. Aborting.', 'warning')
					return
				}
			}

			// Dirty tree gating (separate function, reuses repoRoot)
			await preflightRunChecks({
				repoRoot,
				allowDirty: flags.allowDirty,
				pi,
				ctx,
			})

			// Resume check
			if (flags.resume) {
				ctx.ui.notify('Resume mode: replaying session events...', 'info')
				// Resume behavior wired in task 3
				return
			}

			// Dispatch (wired in task 6)
			ctx.ui.notify('Fleet dispatch starting...', 'info')
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
