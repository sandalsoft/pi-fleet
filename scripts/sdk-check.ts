/**
 * SDK Surface Validation — Tier 1 (must-compile, hard-fail)
 *
 * This file is included in the main tsconfig.json for typecheck but
 * NOT bundled by esbuild (entry is src/extension.ts only).
 *
 * Constructs representative typed calls for every method the extension
 * cannot function without. Catches argument count, type, and return
 * shape mismatches at compile time.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExecResult,
	SessionEntry,
} from '@mariozechner/pi-coding-agent'

// This function is never called at runtime. It exists purely to verify
// that the SDK types match our expectations at compile time.
function _sdkSurfaceCheck(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	// --- registerCommand: typed handler signature ---
	pi.registerCommand('test-cmd', {
		description: 'test',
		handler: async (_args: string, _ctx: ExtensionCommandContext): Promise<void> => {},
	})

	// --- exec: verify return shape has stdout, stderr, code ---
	const _execPromise: Promise<ExecResult> = pi.exec('git', ['status'])
	void _execPromise.then((result) => {
		const _stdout: string = result.stdout
		const _code: number = result.code
		const _stderr: string = result.stderr
		void [_stdout, _code, _stderr]
	})

	// --- appendEntry: typed data argument ---
	pi.appendEntry('fleet-event', { type: 'test', timestamp: new Date().toISOString() })

	// --- ctx.ui methods: verify argument types ---
	void ctx.ui.select('Pick one', ['a', 'b'])
	void ctx.ui.confirm('Title', 'Message body')
	void ctx.ui.input('Enter value', 'placeholder')
	ctx.ui.notify('Hello', 'info')
	ctx.ui.setWidget('fleet-widget', ['line 1', 'line 2'])
	ctx.ui.setStatus('fleet-status', 'active')

	// --- sessionManager.getEntries: verify array with customType field ---
	const _entries: SessionEntry[] = ctx.sessionManager.getEntries()
	for (const entry of _entries) {
		if (entry.type === 'custom') {
			const _customType: string = entry.customType
			void _customType
		}
	}
}

// Prevent "unused" errors
void _sdkSurfaceCheck
