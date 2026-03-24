import { describe, it, expect } from 'vitest'
import { diff3Merge } from 'node-diff3'

/**
 * Verifies ESM interop with node-diff3 (CJS package).
 * Documents the argument ordering for task 8's merge engine.
 *
 * diff3Merge(theirs, base, ours) — this is the canonical call signature.
 * "ours" is the third argument; "theirs" is the first.
 *
 * NOTE: node-diff3 is a CJS package. In ESM context (vitest), use named
 * imports: `import { diff3Merge } from 'node-diff3'`. The default import
 * (`import diff3 from 'node-diff3'`) works in esbuild bundles thanks to
 * esModuleInterop but NOT in vitest's native ESM transform. Production
 * code (task 8) should use the same named import style for consistency.
 */
describe('node-diff3 ESM interop', () => {
	it('imports and calls diff3Merge successfully', () => {
		const base = ['line 1', 'line 2', 'line 3']
		const ours = ['line 1', 'our change', 'line 3']
		const theirs = ['line 1', 'their change', 'line 3']

		// diff3Merge(a, o, b) where a=theirs, o=base, b=ours
		const result = diff3Merge(theirs, base, ours)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	})

	it('detects conflicts between ours and theirs', () => {
		const base = ['line 1', 'original', 'line 3']
		const ours = ['line 1', 'our version', 'line 3']
		const theirs = ['line 1', 'their version', 'line 3']

		// diff3Merge(a=theirs, o=base, b=ours)
		const result = diff3Merge(theirs, base, ours)

		// Find the conflict block
		const conflictBlock = result.find(
			(block) => 'conflict' in block
		) as { conflict: { a: string[]; b: string[] } } | undefined

		expect(conflictBlock).toBeDefined()
		if (!conflictBlock) return

		// Verify argument ordering:
		// First arg (a) = theirs, Third arg (b) = ours
		// conflict.a contains the first argument's version (theirs)
		// conflict.b contains the third argument's version (ours)
		expect(conflictBlock.conflict.a).toEqual(['their version'])
		expect(conflictBlock.conflict.b).toEqual(['our version'])
	})

	it('produces clean merge when changes do not overlap', () => {
		const base = ['line 1', 'line 2', 'line 3']
		const ours = ['line 1', 'line 2', 'our line 3']
		const theirs = ['their line 1', 'line 2', 'line 3']

		const result = diff3Merge(theirs, base, ours)
		const hasConflict = result.some(
			(block) => 'conflict' in block
		)
		expect(hasConflict).toBe(false)
	})

	/**
	 * DOCUMENTED ORDERING for task 8:
	 *
	 * Call: diff3Merge(theirs, base, ours)
	 *   - Argument 1 (a): "theirs" — the incoming changes
	 *   - Argument 2 (o): "base" — the common ancestor
	 *   - Argument 3 (b): "ours" — the current branch changes
	 *
	 * In conflict blocks:
	 *   - conflict.a = theirs (first argument)
	 *   - conflict.b = ours (third argument)
	 *   - conflict.o = base (second argument)
	 *
	 * Production code (task 8) MUST use named import:
	 *   import { diff3Merge } from 'node-diff3'
	 */
})
