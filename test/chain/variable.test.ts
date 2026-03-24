import { describe, it, expect } from 'vitest'
import { substituteInput, buildStepPrompt } from '../../src/chain/variable.js'

describe('variable substitution', () => {
	describe('substituteInput', () => {
		it('replaces a single $INPUT occurrence', () => {
			const result = substituteInput({
				template: 'Review this: $INPUT',
				input: 'some code output',
			})
			expect(result.prompt).toBe('Review this: some code output')
			expect(result.truncated).toBe(false)
		})

		it('replaces multiple $INPUT occurrences', () => {
			const result = substituteInput({
				template: 'First: $INPUT\nSecond: $INPUT',
				input: 'data',
			})
			expect(result.prompt).toBe('First: data\nSecond: data')
		})

		it('handles $INPUT in multi-line template', () => {
			const template = `Step instructions:
- Analyze the following
- Provide feedback

Input data:
$INPUT

End of instructions.`
			const result = substituteInput({
				template,
				input: 'line1\nline2\nline3',
			})
			expect(result.prompt).toContain('line1\nline2\nline3')
			expect(result.prompt).toContain('End of instructions.')
		})

		it('returns template unchanged when no $INPUT present', () => {
			const result = substituteInput({
				template: 'No placeholder here',
				input: 'ignored',
			})
			expect(result.prompt).toBe('No placeholder here')
			expect(result.truncated).toBe(false)
		})

		it('handles empty input', () => {
			const result = substituteInput({
				template: 'Before: $INPUT :After',
				input: '',
			})
			expect(result.prompt).toBe('Before:  :After')
		})

		it('truncates oversized input with warning', () => {
			const bigInput = 'x'.repeat(500)
			const result = substituteInput({
				template: 'Review: $INPUT',
				input: bigInput,
				maxInputChars: 100,
			})
			expect(result.truncated).toBe(true)
			expect(result.originalLength).toBe(500)
			expect(result.prompt).toContain('[TRUNCATED:')
			// The substituted portion should start with 100 x's
			expect(result.prompt).toContain('x'.repeat(100))
			// But not contain all 500
			expect(result.prompt).not.toContain('x'.repeat(500))
		})

		it('does not truncate input within limit', () => {
			const result = substituteInput({
				template: '$INPUT',
				input: 'short',
				maxInputChars: 100,
			})
			expect(result.truncated).toBe(false)
			expect(result.prompt).toBe('short')
		})

		it('replaces $INPUT even when part of a longer token', () => {
			const result = substituteInput({
				template: '$INPUTS and $INPUT_FILE and $INPUT',
				input: 'val',
			})
			// $INPUT is a simple string replacement, so $INPUTS becomes "valS"
			// and $INPUT_FILE becomes "val_FILE"
			expect(result.prompt).toBe('valS and val_FILE and val')
		})
	})

	describe('buildStepPrompt', () => {
		it('substitutes $INPUT when step has a prompt template', () => {
			const result = buildStepPrompt('Analyze: $INPUT', 'previous output')
			expect(result.prompt).toBe('Analyze: previous output')
			expect(result.truncated).toBe(false)
		})

		it('passes input through when step has no prompt', () => {
			const result = buildStepPrompt(undefined, 'the raw input')
			expect(result.prompt).toBe('the raw input')
		})

		it('truncates pass-through input when oversized', () => {
			const bigInput = 'y'.repeat(200)
			const result = buildStepPrompt(undefined, bigInput, 50)
			expect(result.truncated).toBe(true)
			expect(result.prompt).toContain('[TRUNCATED:')
		})

		it('treats empty prompt template as pass-through', () => {
			// Empty string is falsy, so buildStepPrompt treats it as no template
			const result = buildStepPrompt('', 'some input')
			expect(result.prompt).toBe('some input')
		})
	})
})
