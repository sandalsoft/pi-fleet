import { describe, it, expect } from 'vitest'
import {
	buildTaskGraph,
	computeWaves,
	detectCycles,
} from '../../src/dispatch/task-graph.js'
import type { TaskAssignment } from '../../src/dispatch/types.js'

function assignment(agentName: string, expectedPaths: string[] = []): TaskAssignment {
	return { agentName, brief: `Brief for ${agentName}`, expectedPaths }
}

describe('task-graph', () => {
	describe('buildTaskGraph', () => {
		it('creates nodes from assignments and dependencies', () => {
			const graph = buildTaskGraph(
				[assignment('dev'), assignment('qa')],
				{ qa: ['dev'] }
			)
			expect(graph.nodes.size).toBe(2)
			expect(graph.nodes.get('qa')?.dependsOn).toEqual(['dev'])
			expect(graph.nodes.get('dev')?.dependsOn).toEqual([])
		})

		it('handles assignments with no dependencies', () => {
			const graph = buildTaskGraph(
				[assignment('dev'), assignment('qa')],
				{}
			)
			expect(graph.nodes.get('dev')?.dependsOn).toEqual([])
			expect(graph.nodes.get('qa')?.dependsOn).toEqual([])
		})
	})

	describe('detectCycles', () => {
		it('returns null for acyclic graphs', () => {
			const graph = buildTaskGraph(
				[assignment('a'), assignment('b'), assignment('c')],
				{ b: ['a'], c: ['b'] }
			)
			expect(detectCycles(graph)).toBeNull()
		})

		it('detects a simple two-node cycle', () => {
			const graph = buildTaskGraph(
				[assignment('a'), assignment('b')],
				{ a: ['b'], b: ['a'] }
			)
			const cycle = detectCycles(graph)
			expect(cycle).not.toBeNull()
			expect(cycle!.length).toBeGreaterThanOrEqual(2)
		})

		it('detects a longer cycle', () => {
			const graph = buildTaskGraph(
				[assignment('a'), assignment('b'), assignment('c')],
				{ a: ['c'], b: ['a'], c: ['b'] }
			)
			expect(detectCycles(graph)).not.toBeNull()
		})

		it('returns null for a single node with no deps', () => {
			const graph = buildTaskGraph([assignment('solo')], {})
			expect(detectCycles(graph)).toBeNull()
		})
	})

	describe('computeWaves', () => {
		it('puts independent tasks in the same wave', () => {
			const waves = computeWaves(
				buildTaskGraph(
					[
						assignment('dev', ['src/app.ts']),
						assignment('qa', ['test/app.test.ts']),
					],
					{}
				)
			)
			expect(waves.length).toBe(1)
			expect(waves[0].length).toBe(2)
		})

		it('chains dependent tasks into sequential waves', () => {
			const waves = computeWaves(
				buildTaskGraph(
					[
						assignment('dev', ['src/app.ts']),
						assignment('qa', ['test/app.test.ts']),
						assignment('reviewer', ['review.md']),
					],
					{ qa: ['dev'], reviewer: ['qa'] }
				)
			)
			expect(waves.length).toBe(3)
			expect(waves[0][0].agentName).toBe('dev')
			expect(waves[1][0].agentName).toBe('qa')
			expect(waves[2][0].agentName).toBe('reviewer')
		})

		it('allows partial parallelism when deps allow it', () => {
			const waves = computeWaves(
				buildTaskGraph(
					[
						assignment('frontend', ['src/ui.ts']),
						assignment('backend', ['src/api.ts']),
						assignment('integrator', ['src/index.ts']),
					],
					{ integrator: ['frontend', 'backend'] }
				)
			)
			expect(waves.length).toBe(2)
			expect(waves[0]).toHaveLength(2)
			expect(waves[1]).toHaveLength(1)
			expect(waves[1][0].agentName).toBe('integrator')
		})

		it('throws on cyclic graph', () => {
			expect(() =>
				computeWaves(
					buildTaskGraph(
						[assignment('a'), assignment('b')],
						{ a: ['b'], b: ['a'] }
					)
				)
			).toThrow(/cycle/i)
		})

		it('separates tasks with overlapping expectedPaths into different waves', () => {
			const waves = computeWaves(
				buildTaskGraph(
					[
						assignment('dev1', ['src/shared.ts', 'src/a.ts']),
						assignment('dev2', ['src/shared.ts', 'src/b.ts']),
					],
					{}
				)
			)
			// Both are ready at the same time but share src/shared.ts
			expect(waves.length).toBe(2)
			expect(waves[0]).toHaveLength(1)
			expect(waves[1]).toHaveLength(1)
		})

		it('places tasks with empty expectedPaths in sequential solo waves', () => {
			const waves = computeWaves(
				buildTaskGraph(
					[
						assignment('safe', ['src/a.ts']),
						assignment('unknown', []),
					],
					{}
				)
			)
			// 'unknown' has no paths -> sequential -> own wave
			// 'safe' has paths -> own wave
			expect(waves.length).toBe(2)
			for (const wave of waves) {
				expect(wave).toHaveLength(1)
			}
		})

		it('handles a diamond dependency shape', () => {
			const waves = computeWaves(
				buildTaskGraph(
					[
						assignment('root', ['src/root.ts']),
						assignment('left', ['src/left.ts']),
						assignment('right', ['src/right.ts']),
						assignment('join', ['src/join.ts']),
					],
					{
						left: ['root'],
						right: ['root'],
						join: ['left', 'right'],
					}
				)
			)
			expect(waves[0][0].agentName).toBe('root')
			expect(waves[1]).toHaveLength(2)
			const waveNames = waves[1].map((a) => a.agentName).sort()
			expect(waveNames).toEqual(['left', 'right'])
			expect(waves[2][0].agentName).toBe('join')
		})

		it('ignores dependencies on agents not in the graph', () => {
			const waves = computeWaves(
				buildTaskGraph(
					[assignment('dev', ['src/app.ts'])],
					{ dev: ['nonexistent'] }
				)
			)
			expect(waves.length).toBe(1)
			expect(waves[0][0].agentName).toBe('dev')
		})
	})
})
