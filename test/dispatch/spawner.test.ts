import { describe, it, expect } from 'vitest'
import {
	parseJsonlStream,
	resolvePromptMode,
	readSmokeResults,
} from '../../src/dispatch/spawner.js'
import type { SmokeResults } from '../../src/dispatch/types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

describe('spawner', () => {
	describe('parseJsonlStream', () => {
		it('extracts last assistant message content from sample JSONL', () => {
			const jsonl = [
				'{"type":"system","subtype":"init","model":"claude-sonnet-4-20250514","session_id":"smoke-test-001"}',
				'{"type":"assistant_message","subtype":"start","message":{"role":"assistant","content":[]}}',
				'{"type":"assistant_message","subtype":"update","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll run the echo"}]}}',
				'{"type":"assistant_message","subtype":"update","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll run the echo command for you."}]}}',
				'{"type":"tool_use","name":"bash","input":{"command":"echo test"}}',
				'{"type":"tool_result","name":"bash","content":[{"type":"text","text":"test\\n"}],"is_error":false}',
				'{"type":"assistant_message","subtype":"update","message":{"role":"assistant","content":[{"type":"text","text":"Done. The echo command output \\"test\\"."}]}}',
				'{"type":"assistant_message","subtype":"end","message":{"role":"assistant","content":[{"type":"text","text":"Done. The echo command output \\"test\\"."}],"usage":{"input_tokens":150,"output_tokens":42,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
				'{"type":"message_end","usage":{"input_tokens":150,"output_tokens":42}}',
			].join('\n')

			const result = parseJsonlStream(jsonl)

			expect(result.report).toBe('Done. The echo command output "test".')
			// Usage comes from the assistant_message end + message_end
			expect(result.usage.inputTokens).toBeGreaterThan(0)
			expect(result.usage.outputTokens).toBeGreaterThan(0)
		})

		it('handles multiple assistant messages (takes last)', () => {
			const jsonl = [
				'{"type":"assistant_message","subtype":"end","message":{"role":"assistant","content":[{"type":"text","text":"First message"}],"usage":{"input_tokens":10,"output_tokens":5}}}',
				'{"type":"assistant_message","subtype":"end","message":{"role":"assistant","content":[{"type":"text","text":"Second message"}],"usage":{"input_tokens":20,"output_tokens":10}}}',
			].join('\n')

			const result = parseJsonlStream(jsonl)
			expect(result.report).toBe('Second message')
		})

		it('skips tool_use messages without crashing', () => {
			const jsonl = [
				'{"type":"tool_use","name":"bash","input":{"command":"ls"}}',
				'{"type":"tool_result","name":"bash","content":[{"type":"text","text":"file.txt"}],"is_error":false}',
				'{"type":"assistant_message","subtype":"end","message":{"role":"assistant","content":[{"type":"text","text":"Found files"}],"usage":{"input_tokens":5,"output_tokens":3}}}',
			].join('\n')

			const result = parseJsonlStream(jsonl)
			expect(result.report).toBe('Found files')
		})

		it('handles partial/malformed lines gracefully', () => {
			const jsonl = [
				'{"type":"assistant_message","subtype":"end","message":{"role":"assistant","content":[{"type":"text","text":"Valid"}],"usage":{"input_tokens":5,"output_tokens":3}}}',
				'this is not json',
				'{incomplete',
				'',
			].join('\n')

			const result = parseJsonlStream(jsonl)
			expect(result.report).toBe('Valid')
		})

		it('returns empty report for empty stream', () => {
			const result = parseJsonlStream('')
			expect(result.report).toBe('')
			expect(result.usage.inputTokens).toBe(0)
		})

		it('ignores unknown event types silently', () => {
			const jsonl = [
				'{"type":"future_event_type","data":"something"}',
				'{"type":"assistant_message","subtype":"end","message":{"role":"assistant","content":[{"type":"text","text":"After unknown"}],"usage":{"input_tokens":5,"output_tokens":3}}}',
			].join('\n')

			const result = parseJsonlStream(jsonl)
			expect(result.report).toBe('After unknown')
		})

		it('normalizes usage from snake_case fields', () => {
			const jsonl = '{"type":"message_end","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":25,"cache_creation_input_tokens":10}}'

			const result = parseJsonlStream(jsonl)
			expect(result.usage.inputTokens).toBe(100)
			expect(result.usage.outputTokens).toBe(50)
			expect(result.usage.cacheReadTokens).toBe(25)
			expect(result.usage.cacheWriteTokens).toBe(10)
		})

		it('normalizes usage from camelCase fields', () => {
			const jsonl = '{"type":"message_end","usage":{"inputTokens":200,"outputTokens":75,"cacheReadTokens":30,"cacheWriteTokens":15}}'

			const result = parseJsonlStream(jsonl)
			expect(result.usage.inputTokens).toBe(200)
			expect(result.usage.outputTokens).toBe(75)
			expect(result.usage.cacheReadTokens).toBe(30)
			expect(result.usage.cacheWriteTokens).toBe(15)
		})

		it('handles assistant_message_end event type variant', () => {
			const jsonl = '{"type":"assistant_message_end","message":{"role":"assistant","content":[{"type":"text","text":"Variant type"}],"usage":{"input_tokens":10,"output_tokens":5}}}'

			const result = parseJsonlStream(jsonl)
			expect(result.report).toBe('Variant type')
		})

		it('handles string content in assistant message', () => {
			const jsonl = '{"type":"assistant_message","subtype":"end","message":{"role":"assistant","content":"Plain string content","usage":{"input_tokens":5,"output_tokens":2}}}'

			const result = parseJsonlStream(jsonl)
			expect(result.report).toBe('Plain string content')
		})
	})

	describe('resolvePromptMode', () => {
		it('returns trailing-arg when smoke results are null', () => {
			expect(resolvePromptMode(null)).toBe('trailing-arg')
		})

		it('returns trailing-arg when preferredPromptMode is null', () => {
			const results: SmokeResults = { preferredPromptMode: null }
			expect(resolvePromptMode(results)).toBe('trailing-arg')
		})

		it('honors trailing-arg preference from smoke results', () => {
			const results: SmokeResults = { preferredPromptMode: 'trailing-arg' }
			expect(resolvePromptMode(results)).toBe('trailing-arg')
		})

		it('honors stdin-pipe preference from smoke results', () => {
			const results: SmokeResults = { preferredPromptMode: 'stdin-pipe' }
			expect(resolvePromptMode(results)).toBe('stdin-pipe')
		})
	})

	describe('readSmokeResults', () => {
		it('returns null when file does not exist', async () => {
			const result = await readSmokeResults('/nonexistent/path')
			expect(result).toBeNull()
		})

		it('reads and parses valid smoke-results.json', async () => {
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-smoke-'))
			const piDir = path.join(tmpDir, '.pi')
			await fs.mkdir(piDir, { recursive: true })
			await fs.writeFile(
				path.join(piDir, 'smoke-results.json'),
				JSON.stringify({
					preferredPromptMode: 'stdin-pipe',
					canWriteToRepoScratchpadFromSiblingCwd: false,
				})
			)

			const result = await readSmokeResults(tmpDir)
			expect(result).not.toBeNull()
			expect(result!.preferredPromptMode).toBe('stdin-pipe')
			expect(result!.canWriteToRepoScratchpadFromSiblingCwd).toBe(false)

			await fs.rm(tmpDir, { recursive: true, force: true })
		})

		it('returns null for malformed JSON', async () => {
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fleet-smoke-'))
			const piDir = path.join(tmpDir, '.pi')
			await fs.mkdir(piDir, { recursive: true })
			await fs.writeFile(path.join(piDir, 'smoke-results.json'), 'not json')

			const result = await readSmokeResults(tmpDir)
			expect(result).toBeNull()

			await fs.rm(tmpDir, { recursive: true, force: true })
		})
	})
})
