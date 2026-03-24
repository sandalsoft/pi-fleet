import type { TaskAssignment } from './types.js'

export interface TaskNode {
	assignment: TaskAssignment
	dependsOn: string[]
}

export interface TaskGraph {
	nodes: Map<string, TaskNode>
}

/**
 * Build a task graph from assignments and dependency declarations.
 * Dependencies reference agent names. An assignment with empty dependsOn
 * runs in the earliest wave possible.
 */
export function buildTaskGraph(
	assignments: TaskAssignment[],
	dependencies: Record<string, string[]>
): TaskGraph {
	const nodes = new Map<string, TaskNode>()
	for (const assignment of assignments) {
		nodes.set(assignment.agentName, {
			assignment,
			dependsOn: dependencies[assignment.agentName] ?? [],
		})
	}
	return { nodes }
}

/**
 * Detect cycles in the task graph using DFS coloring.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCycles(graph: TaskGraph): string[] | null {
	// DFS coloring: 0 = unvisited, 1 = in-progress, 2 = done
	const color = new Map<string, number>()
	const parent = new Map<string, string | null>()

	for (const name of graph.nodes.keys()) {
		color.set(name, 0)
		parent.set(name, null)
	}

	for (const name of graph.nodes.keys()) {
		if (color.get(name) === 0) {
			const cycle = dfs(name, graph, color, parent)
			if (cycle) return cycle
		}
	}

	return null
}

function dfs(
	node: string,
	graph: TaskGraph,
	color: Map<string, number>,
	parent: Map<string, string | null>
): string[] | null {
	color.set(node, 1) // GRAY

	const taskNode = graph.nodes.get(node)
	if (taskNode) {
		for (const dep of taskNode.dependsOn) {
			if (!graph.nodes.has(dep)) continue
			if (color.get(dep) === 1) { // GRAY
				// Found cycle: reconstruct path
				const cycle = [dep, node]
				let cur = parent.get(node)
				while (cur && cur !== dep) {
					cycle.push(cur)
					cur = parent.get(cur)
				}
				cycle.push(dep)
				return cycle.reverse()
			}
			if (color.get(dep) === 2) continue // BLACK
			parent.set(dep, node)
			const result = dfs(dep, graph, color, parent)
			if (result) return result
		}
	}

	color.set(node, 2) // BLACK
	return null
}

/**
 * Produce execution waves using Kahn's algorithm (topological sort).
 * Each wave contains tasks whose dependencies are all satisfied by
 * prior waves. Tasks with overlapping expectedPaths within the same
 * wave are conservatively split into separate waves.
 *
 * Tasks with empty expectedPaths default to sequential execution
 * (placed in their own single-task wave after dependencies are met).
 *
 * Throws if cycles are detected.
 */
export function computeWaves(graph: TaskGraph): TaskAssignment[][] {
	const cycle = detectCycles(graph)
	if (cycle) {
		throw new Error(`Cycle detected in task graph: ${cycle.join(' -> ')}`)
	}

	// Kahn's: compute in-degree from graph dependencies
	const inDegree = new Map<string, number>()
	for (const [name, node] of graph.nodes) {
		// Only count deps that are actually in the graph
		const validDeps = node.dependsOn.filter((d) => graph.nodes.has(d))
		inDegree.set(name, validDeps.length)
	}

	const waves: TaskAssignment[][] = []
	const completed = new Set<string>()

	while (completed.size < graph.nodes.size) {
		// Find all nodes with zero in-degree (ready to execute)
		const ready: string[] = []
		for (const [name, degree] of inDegree) {
			if (!completed.has(name) && degree === 0) {
				ready.push(name)
			}
		}

		if (ready.length === 0) {
			// Should not happen since we checked for cycles, but guard anyway
			throw new Error('Deadlock: no ready tasks but graph is not complete')
		}

		// Split ready tasks by path overlap and sequential-default
		const waveGroups = splitByPathOverlap(ready, graph)

		for (const group of waveGroups) {
			const wave = group.map((name) => graph.nodes.get(name)!.assignment)
			waves.push(wave)

			// Mark as completed and update in-degrees
			for (const name of group) {
				completed.add(name)

				// Reduce in-degree for dependents
				for (const [depName, node] of graph.nodes) {
					if (node.dependsOn.includes(name) && !completed.has(depName)) {
						inDegree.set(depName, (inDegree.get(depName) ?? 1) - 1)
					}
				}
			}
		}
	}

	return waves
}

/**
 * Split a set of ready-to-execute tasks into groups that can safely
 * run in parallel. Tasks with overlapping expectedPaths are placed in
 * separate groups. Tasks with empty expectedPaths are sequential
 * (solo groups).
 */
function splitByPathOverlap(ready: string[], graph: TaskGraph): string[][] {
	const groups: string[][] = []

	for (const name of ready) {
		const node = graph.nodes.get(name)!
		const paths = node.assignment.expectedPaths

		// Empty paths -> sequential (own group)
		if (!paths || paths.length === 0) {
			groups.push([name])
			continue
		}

		// Try to fit into an existing group with no overlap
		let placed = false
		for (const group of groups) {
			const hasOverlap = group.some((member) => {
				const memberPaths = graph.nodes.get(member)!.assignment.expectedPaths
				if (!memberPaths || memberPaths.length === 0) return true // sequential task -> overlap
				return paths.some((p) => memberPaths.includes(p))
			})
			if (!hasOverlap) {
				group.push(name)
				placed = true
				break
			}
		}

		if (!placed) {
			groups.push([name])
		}
	}

	return groups
}
