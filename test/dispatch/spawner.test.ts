import { describe, it, expect } from 'vitest'
import {
	parseJsonlStream,
	resolvePromptMode,
	readSmokeResults,
	extractActivity,
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

		it('normalizes usage from pi SDK short field names (input, output, cacheRead)', () => {
			const jsonl = '{"type":"message_end","usage":{"input":300,"output":100,"cacheRead":40,"cacheWrite":20,"totalTokens":460}}'

			const result = parseJsonlStream(jsonl)
			expect(result.usage.inputTokens).toBe(300)
			expect(result.usage.outputTokens).toBe(100)
			expect(result.usage.cacheReadTokens).toBe(40)
			expect(result.usage.cacheWriteTokens).toBe(20)
		})

		it('extracts cost from pi SDK cost object with total field', () => {
			const jsonl = JSON.stringify({
				type: 'message_end',
				usage: {
					input: 1000,
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1500,
					cost: { input: 0.003, output: 0.0075, cacheRead: 0, cacheWrite: 0, total: 0.0105 },
				},
			})

			const result = parseJsonlStream(jsonl)
			expect(result.usage.cost).toBeCloseTo(0.0105)
			expect(result.usage.inputTokens).toBe(1000)
		})

		it('extracts cost as plain number when not an object', () => {
			const jsonl = '{"type":"message_end","usage":{"input_tokens":100,"output_tokens":50,"cost":0.42}}'

			const result = parseJsonlStream(jsonl)
			expect(result.usage.cost).toBeCloseTo(0.42)
		})

		it('handles pi SDK "done" event with usage', () => {
			const jsonl = JSON.stringify({
				type: 'done',
				reason: 'stop',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Finished the task.' }],
					usage: {
						input: 2000,
						output: 800,
						cacheRead: 100,
						cacheWrite: 50,
						totalTokens: 2950,
						cost: { input: 0.006, output: 0.012, cacheRead: 0, cacheWrite: 0, total: 0.018 },
					},
				},
			})

			const result = parseJsonlStream(jsonl)
			expect(result.report).toBe('Finished the task.')
			expect(result.usage.inputTokens).toBe(2000)
			expect(result.usage.outputTokens).toBe(800)
			expect(result.usage.cost).toBeCloseTo(0.018)
		})

		it('handles pi SDK "error" event with usage', () => {
			const jsonl = JSON.stringify({
				type: 'error',
				reason: 'error',
				error: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Something went wrong.' }],
					usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600, cost: { total: 0.003 } },
				},
			})

			const result = parseJsonlStream(jsonl)
			expect(result.report).toBe('Something went wrong.')
			expect(result.usage.inputTokens).toBe(500)
			expect(result.usage.cost).toBeCloseTo(0.003)
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

	describe('extractActivity', () => {
		it('extracts tool_use Read activity from assistant_message content', () => {
			const line = JSON.stringify({
				type: 'assistant_message',
				message: {
					role: 'assistant',
					content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/config/schema.ts' } }],
				},
			})
			expect(extractActivity(line)).toBe('reading src/config/schema.ts')
		})

		it('extracts tool_use Edit activity', () => {
			const line = JSON.stringify({
				type: 'assistant_message',
				message: {
					role: 'assistant',
					content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/main.ts' } }],
				},
			})
			expect(extractActivity(line)).toBe('editing src/main.ts')
		})

		it('extracts Bash activity with command', () => {
			const line = JSON.stringify({
				type: 'assistant_message',
				message: {
					role: 'assistant',
					content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
				},
			})
			expect(extractActivity(line)).toBe('running npm test')
		})

		it('extracts Grep activity', () => {
			const line = JSON.stringify({
				type: 'assistant_message',
				message: {
					role: 'assistant',
					content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }],
				},
			})
			expect(extractActivity(line)).toBe('searching TODO')
		})

		it('extracts text content as activity when no tool_use', () => {
			const line = JSON.stringify({
				type: 'assistant_message',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'Analyzing the test coverage gaps' }],
				},
			})
			expect(extractActivity(line)).toBe('Analyzing the test coverage gaps')
		})

		it('extracts content_block_start tool_use', () => {
			const line = JSON.stringify({
				type: 'content_block_start',
				content_block: { type: 'tool_use', name: 'Write', input: { file_path: 'test/new.test.ts' } },
			})
			expect(extractActivity(line)).toBe('writing test/new.test.ts')
		})

		it('extracts top-level tool_use event (pi standalone format)', () => {
			const line = JSON.stringify({
				type: 'tool_use',
				name: 'bash',
				input: { command: 'npm run build' },
			})
			expect(extractActivity(line)).toBe('running npm run build')
		})

		it('extracts tool_execution_start event (pi agent format)', () => {
			const line = JSON.stringify({
				type: 'tool_execution_start',
				toolCallId: 'call_123',
				toolName: 'Read',
				args: { file_path: 'package.json' },
			})
			expect(extractActivity(line)).toBe('reading package.json')
		})

		it('extracts toolcall_start event (pi SDK format)', () => {
			const line = JSON.stringify({
				type: 'toolcall_start',
				contentIndex: 0,
				toolCall: { name: 'Grep', arguments: { pattern: 'TODO' } },
			})
			expect(extractActivity(line)).toBe('searching TODO')
		})

		it('returns null for non-actionable event types', () => {
			expect(extractActivity('{"type":"system","subtype":"init"}')).toBeNull()
			expect(extractActivity('{"type":"message_end","usage":{}}')).toBeNull()
		})

		it('returns null for malformed JSON', () => {
			expect(extractActivity('not json')).toBeNull()
		})

		it('truncates long activity text', () => {
			const longText = 'A'.repeat(100)
			const line = JSON.stringify({
				type: 'assistant_message',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: longText }],
				},
			})
			const result = extractActivity(line)!
			expect(result.length).toBeLessThanOrEqual(60)
			expect(result.endsWith('\u2026')).toBe(true)
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
