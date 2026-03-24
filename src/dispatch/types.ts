import type { ChildProcess } from 'node:child_process'
import type { SpecialistRecord } from '../session/state.js'

// Re-export SpecialistRecord from session/state for convenience
export type { SpecialistRecord } from '../session/state.js'

// --- Normalized usage type with canonical field names ---

export interface Usage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	cost: number
}

/**
 * Extract a normalized Usage from a raw object that may use snake_case
 * (input_tokens) or camelCase (inputTokens) field names.
 * Returns zero for any missing fields.
 */
export function normalizeUsage(raw: Record<string, unknown>): Usage {
	return {
		inputTokens: num(raw.inputTokens ?? raw.input_tokens),
		outputTokens: num(raw.outputTokens ?? raw.output_tokens),
		cacheReadTokens: num(raw.cacheReadTokens ?? raw.cache_read_input_tokens ?? raw.cache_read_tokens),
		cacheWriteTokens: num(raw.cacheWriteTokens ?? raw.cache_creation_input_tokens ?? raw.cache_write_tokens),
		cost: num(raw.cost),
	}
}

function num(v: unknown): number {
	return typeof v === 'number' ? v : 0
}

export function emptyUsage(): Usage {
	return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 }
}

export function addUsage(a: Usage, b: Usage): Usage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
		cost: a.cost + b.cost,
	}
}

/**
 * Live, in-memory only. Extends SpecialistRecord with process management handles.
 * Never serialized to JSON or passed through FleetEvent payloads.
 */
export interface SpecialistRuntime extends SpecialistRecord {
	abortController: AbortController
	process: ChildProcess
}

// --- Task assignment ---

export interface TaskAssignment {
	agentName: string
	brief: string
	expectedPaths: string[]
	model?: string
}

// --- Prompt mode detection ---

export type PromptMode = 'trailing-arg' | 'stdin-pipe'

export interface SmokeResults {
	preferredPromptMode: PromptMode | null
	canWriteToRepoScratchpadFromSiblingCwd?: boolean
}

// --- Specialist spawn result ---

export interface SpawnResult {
	runtime: SpecialistRuntime
	report: string
	usage: Usage
}
