import { diff3Merge } from 'node-diff3'

/**
 * Result of resolving a single file conflict.
 */
export interface ConflictResolution {
	filePath: string
	resolved: boolean
	/** Merged content when resolved via diff3 */
	content?: string
	/** Strategy used: 'diff3' for clean text merges, 'theirs' for binary, 'manual' for residual */
	strategy: 'diff3' | 'theirs' | 'manual'
}

/**
 * Three-way file versions extracted from git index stages during an active merge.
 */
export interface ThreeWayInput {
	filePath: string
	base: string
	ours: string
	theirs: string
	isBinary: boolean
}

export interface GitExec {
	(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>
}

/**
 * Extract the three versions (base, ours, theirs) from git index stages
 * during an active merge conflict.
 *
 * Git stores conflict stages as:
 *   :1:<path> = base (common ancestor)
 *   :2:<path> = ours (integration branch)
 *   :3:<path> = theirs (specialist branch)
 */
export async function extractThreeWayInput(
	git: GitExec,
	filePath: string
): Promise<ThreeWayInput> {
	const [baseResult, oursResult, theirsResult] = await Promise.all([
		git(['show', `:1:${filePath}`]),
		git(['show', `:2:${filePath}`]),
		git(['show', `:3:${filePath}`]),
	])

	if (baseResult.code !== 0 || oursResult.code !== 0 || theirsResult.code !== 0) {
		throw new Error(
			`Failed to extract three-way input for ${filePath}: ` +
				`base=${baseResult.code}, ours=${oursResult.code}, theirs=${theirsResult.code}`
		)
	}

	return {
		filePath,
		base: baseResult.stdout,
		ours: oursResult.stdout,
		theirs: theirsResult.stdout,
		isBinary: false,
	}
}

/**
 * Detect binary files from git diff --numstat output.
 * Binary files show "-" for both additions and deletions.
 */
export async function detectBinaryConflicts(
	git: GitExec,
	conflictPaths: string[]
): Promise<Set<string>> {
	if (conflictPaths.length === 0) return new Set()

	const result = await git(['diff', '--numstat', '--cached'])
	if (result.code !== 0) return new Set()

	const binaryPaths = new Set<string>()
	for (const line of result.stdout.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		// Binary files show: -\t-\t<path>
		if (trimmed.startsWith('-\t-\t')) {
			const filePath = trimmed.slice(4)
			if (conflictPaths.includes(filePath)) {
				binaryPaths.add(filePath)
			}
		}
	}

	return binaryPaths
}

/**
 * Attempt three-way merge of a text file using node-diff3.
 *
 * diff3Merge(theirs, base, ours) - argument ordering documented in
 * test/node-diff3-interop.test.ts.
 *
 * Returns resolved content if the merge is clean (no conflict blocks),
 * or null if conflicts remain.
 */
export function tryDiff3Merge(input: ThreeWayInput): string | null {
	const baseLines = input.base.split('\n')
	const oursLines = input.ours.split('\n')
	const theirsLines = input.theirs.split('\n')

	const result = diff3Merge(theirsLines, baseLines, oursLines)

	const hasConflict = result.some((block) => 'conflict' in block)
	if (hasConflict) return null

	// Reconstruct merged content from ok blocks
	const merged: string[] = []
	for (const block of result) {
		if ('ok' in block && block.ok) {
			merged.push(...block.ok)
		}
	}

	return merged.join('\n')
}

/**
 * Resolve a single conflicted file.
 *
 * Strategy:
 * 1. Binary files -> checkout --theirs (later specialist wins)
 * 2. Text files -> try diff3 merge
 * 3. If diff3 has remaining conflicts -> return unresolved for manual dispatch
 */
export async function resolveConflict(
	git: GitExec,
	filePath: string,
	isBinary: boolean
): Promise<ConflictResolution> {
	// Binary: default to theirs (later specialist's version)
	if (isBinary) {
		await git(['checkout', '--theirs', filePath])
		await git(['add', filePath])
		return { filePath, resolved: true, strategy: 'theirs' }
	}

	// Text: extract three-way input and try diff3
	const input = await extractThreeWayInput(git, filePath)
	const merged = tryDiff3Merge(input)

	if (merged !== null) {
		return { filePath, resolved: true, content: merged, strategy: 'diff3' }
	}

	// Residual conflict: needs manual/dispatcher resolution
	return { filePath, resolved: false, strategy: 'manual' }
}

/**
 * Resolve all conflicts for a merge, returning results per file.
 */
export async function resolveAllConflicts(
	git: GitExec,
	conflictPaths: string[],
	onConflict?: (filePath: string, resolution: ConflictResolution) => void
): Promise<ConflictResolution[]> {
	const binarySet = await detectBinaryConflicts(git, conflictPaths)
	const results: ConflictResolution[] = []

	for (const filePath of conflictPaths) {
		const resolution = await resolveConflict(git, filePath, binarySet.has(filePath))
		results.push(resolution)
		onConflict?.(filePath, resolution)
	}

	return results
}
