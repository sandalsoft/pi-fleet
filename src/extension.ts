import path from 'node:path'
import fs from 'node:fs/promises'
import type { ExtensionAPI, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { preflightBootstrap, preflightRunChecks } from './preflight.js'

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
				ctx.ui.notify(
					'No .pi/teams.yaml found. Run the setup wizard to create a team configuration.',
					'info'
				)
				// Setup wizard will be wired in task 2
				return
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
			ctx.ui.notify('Fleet status: no active session', 'info')
			// Wired in task 10
		},
	})

	pi.registerCommand('fleet-steer', {
		description: 'Send a steering message to a running agent',
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!args.trim()) {
				ctx.ui.notify('Usage: /fleet-steer <agent-name> <message>', 'warning')
				return
			}
			ctx.ui.notify(`Steering: ${args}`, 'info')
			// Wired in task 10
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
