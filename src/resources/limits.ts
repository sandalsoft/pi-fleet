import type { EventLogWriter } from '../session/event-log.js'
import type { BudgetWarningEvent, TimeWarningEvent } from '../session/events.js'
import { createFleetEvent } from '../session/events.js'
import type { SessionTimer } from './timer.js'
import type { ResourceTracker } from './tracker.js'
import fs from 'node:fs/promises'
import path from 'node:path'

const SOFT_THRESHOLD = 0.8
const HARD_THRESHOLD = 1.0

export type LimitKind = 'budget' | 'time'
export type ThresholdLevel = 'soft' | 'hard'

export interface LimitCheckResult {
	kind: LimitKind
	level: ThresholdLevel
	current: number
	limit: number
	ratio: number
}

export interface LimitsMonitorOpts {
	maxUsd: number
	maxMinutes: number
	timer: SessionTimer
	tracker: ResourceTracker
	eventLog: EventLogWriter
	scratchpadDir: string
	onSoftWarning?: (result: LimitCheckResult) => void
	onHardLimit?: (result: LimitCheckResult) => void
}

/**
 * Monitors accumulated cost and elapsed time against configured limits.
 *
 * - At 80%: emits warning events, writes wrap-up instructions to scratchpads,
 *   and notifies via the onSoftWarning callback.
 * - At 100%: triggers the onHardLimit callback for graceful shutdown.
 *
 * Tracks which warnings have already fired to avoid duplicate notifications.
 */
export interface LimitsMonitor {
	/** Run a single check cycle. Call this periodically or after each cost update. */
	check(): Promise<LimitCheckResult[]>

	/** Whether any hard limit has been reached. */
	isHardLimitReached(): boolean

	/** Reset warning state (for testing). */
	resetWarnings(): void
}

export function createLimitsMonitor(opts: LimitsMonitorOpts): LimitsMonitor {
	const {
		maxUsd,
		maxMinutes,
		timer,
		tracker,
		eventLog,
		scratchpadDir,
		onSoftWarning,
		onHardLimit,
	} = opts

	let budgetSoftFired = false
	let budgetHardFired = false
	let timeSoftFired = false
	let timeHardFired = false

	return {
		async check(): Promise<LimitCheckResult[]> {
			const results: LimitCheckResult[] = []

			// Budget checks
			const currentUsd = tracker.totalCostUsd()
			const budgetRatio = maxUsd > 0 ? currentUsd / maxUsd : 0

			if (budgetRatio >= HARD_THRESHOLD && !budgetHardFired) {
				budgetHardFired = true
				budgetSoftFired = true // skip soft if we jump straight to hard
				const result: LimitCheckResult = {
					kind: 'budget',
					level: 'hard',
					current: currentUsd,
					limit: maxUsd,
					ratio: budgetRatio,
				}
				results.push(result)

				const event = createFleetEvent<BudgetWarningEvent>({
					type: 'budget_warning',
					currentUsd,
					limitUsd: maxUsd,
				})
				await eventLog.append(event)
				onHardLimit?.(result)
			} else if (budgetRatio >= SOFT_THRESHOLD && !budgetSoftFired) {
				budgetSoftFired = true
				const result: LimitCheckResult = {
					kind: 'budget',
					level: 'soft',
					current: currentUsd,
					limit: maxUsd,
					ratio: budgetRatio,
				}
				results.push(result)

				const event = createFleetEvent<BudgetWarningEvent>({
					type: 'budget_warning',
					currentUsd,
					limitUsd: maxUsd,
				})
				await eventLog.append(event)

				await writeScratchpadWarning(scratchpadDir, 'budget', currentUsd, maxUsd)
				onSoftWarning?.(result)
			}

			// Time checks
			const elapsedMinutes = timer.elapsedMinutes()
			const timeRatio = maxMinutes > 0 ? elapsedMinutes / maxMinutes : 0

			if (timeRatio >= HARD_THRESHOLD && !timeHardFired) {
				timeHardFired = true
				timeSoftFired = true
				const result: LimitCheckResult = {
					kind: 'time',
					level: 'hard',
					current: elapsedMinutes,
					limit: maxMinutes,
					ratio: timeRatio,
				}
				results.push(result)

				const event = createFleetEvent<TimeWarningEvent>({
					type: 'time_warning',
					elapsedMinutes,
					limitMinutes: maxMinutes,
				})
				await eventLog.append(event)
				onHardLimit?.(result)
			} else if (timeRatio >= SOFT_THRESHOLD && !timeSoftFired) {
				timeSoftFired = true
				const result: LimitCheckResult = {
					kind: 'time',
					level: 'soft',
					current: elapsedMinutes,
					limit: maxMinutes,
					ratio: timeRatio,
				}
				results.push(result)

				const event = createFleetEvent<TimeWarningEvent>({
					type: 'time_warning',
					elapsedMinutes,
					limitMinutes: maxMinutes,
				})
				await eventLog.append(event)

				await writeScratchpadWarning(scratchpadDir, 'time', elapsedMinutes, maxMinutes)
				onSoftWarning?.(result)
			}

			return results
		},

		isHardLimitReached(): boolean {
			return budgetHardFired || timeHardFired
		},

		resetWarnings(): void {
			budgetSoftFired = false
			budgetHardFired = false
			timeSoftFired = false
			timeHardFired = false
		},
	}
}

/**
 * Write a wrap-up instruction to the scratchpad directory.
 * Uses absolute paths to main repo's .pi/scratchpads/ (not worktree-relative).
 */
async function writeScratchpadWarning(
	scratchpadDir: string,
	kind: LimitKind,
	current: number,
	limit: number
): Promise<void> {
	const fileName = `fleet-${kind}-warning.md`
	const filePath = path.join(scratchpadDir, fileName)
	const pct = Math.round((current / limit) * 100)

	const content = kind === 'budget'
		? [
			`# Budget Warning (${pct}%)`,
			'',
			`Current spend: $${current.toFixed(4)} of $${limit.toFixed(2)} limit.`,
			'',
			'Please wrap up your current task as quickly as possible.',
			'Focus on completing the most critical remaining work.',
			'Avoid starting new subtasks or explorations.',
		].join('\n')
		: [
			`# Time Warning (${pct}%)`,
			'',
			`Elapsed: ${current.toFixed(1)} of ${limit} minutes.`,
			'',
			'Please wrap up your current task as quickly as possible.',
			'Focus on completing the most critical remaining work.',
			'Avoid starting new subtasks or explorations.',
		].join('\n')

	try {
		await fs.mkdir(scratchpadDir, { recursive: true })
		await fs.writeFile(filePath, content, 'utf-8')
	} catch {
		// Non-fatal: scratchpad write may fail in restricted environments
		console.warn(`[pi-fleet] Could not write ${kind} warning to scratchpad: ${filePath}`)
	}
}
