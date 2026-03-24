/**
 * $INPUT variable substitution for agent-chain pipeline steps.
 *
 * Handles:
 * - Multiple occurrences of $INPUT in a single prompt
 * - Multi-line contexts
 * - First step receives the user's original task description (no prior output)
 * - Oversized output truncation with warning at configurable token limit
 */

/** Default truncation limit in characters (rough proxy for ~50k tokens). */
const DEFAULT_MAX_INPUT_CHARS = 200_000

export interface SubstituteOpts {
	/** The prompt template containing $INPUT placeholders. */
	template: string
	/** The value to substitute for $INPUT. */
	input: string
	/**
	 * Maximum character length for the input value before truncation.
	 * Defaults to 200,000 chars (~50k tokens).
	 */
	maxInputChars?: number
}

export interface SubstituteResult {
	/** The prompt with $INPUT replaced. */
	prompt: string
	/** True if the input was truncated before substitution. */
	truncated: boolean
	/** Original input length in characters (before truncation). */
	originalLength: number
}

/**
 * Replace all occurrences of `$INPUT` in the template with the provided input.
 *
 * If `input` exceeds `maxInputChars`, it is truncated and a warning marker
 * is appended so the downstream agent knows the context was cut short.
 */
export function substituteInput(opts: SubstituteOpts): SubstituteResult {
	const { template, maxInputChars = DEFAULT_MAX_INPUT_CHARS } = opts
	let { input } = opts
	const originalLength = input.length
	let truncated = false

	if (input.length > maxInputChars) {
		truncated = true
		input =
			input.slice(0, maxInputChars) +
			'\n\n[TRUNCATED: output exceeded ' +
			maxInputChars.toLocaleString() +
			' characters. The above is a partial result.]'
	}

	const prompt = template.replace(/\$INPUT/g, input)

	return { prompt, truncated, originalLength }
}

/**
 * Build a prompt for a chain step.
 *
 * If the step has a custom prompt template, substitute $INPUT into it.
 * Otherwise, use the input directly as the full prompt.
 */
export function buildStepPrompt(
	stepPrompt: string | undefined,
	input: string,
	maxInputChars?: number
): SubstituteResult {
	if (stepPrompt) {
		return substituteInput({ template: stepPrompt, input, maxInputChars })
	}

	// No template: the input IS the prompt (pass-through)
	const limit = maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
	let truncated = false
	const originalLength = input.length
	let prompt = input

	if (prompt.length > limit) {
		truncated = true
		prompt =
			prompt.slice(0, limit) +
			'\n\n[TRUNCATED: output exceeded ' +
			limit.toLocaleString() +
			' characters. The above is a partial result.]'
	}

	return { prompt, truncated, originalLength }
}
