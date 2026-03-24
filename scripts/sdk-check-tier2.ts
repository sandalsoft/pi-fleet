/**
 * SDK Surface Validation — Tier 2 (nice-to-have, non-gating)
 *
 * Compiled via tsconfig.tier2.json. Allowed to fail (|| true).
 * tsc error output serves as diagnostic for which tier-2 methods
 * are available in the current SDK version.
 */

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'

function _tier2Check(pi: ExtensionAPI, _ctx: ExtensionContext): void {
	// session_shutdown event — cleanup fallback: process signal handling
	pi.on('session_shutdown', async () => {
		// Extension would do cleanup here
	})

	// sendMessage — steering fallback: scratchpad-based
	pi.sendMessage(
		{
			customType: 'fleet-steer',
			content: 'test steering message',
			display: false,
		},
		{ deliverAs: 'steer' }
	)

	// setThinkingLevel — omit if unavailable
	pi.setThinkingLevel('high')
}

void _tier2Check
