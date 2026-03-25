import { describe, it, expect } from 'vitest'
import { ActivityStore } from '../../src/status/activity-store.js'

describe('ActivityStore', () => {
	it('stores and retrieves recent activities', () => {
		const store = new ActivityStore()
		store.appendActivity('dev', 'reading src/main.ts')
		store.appendActivity('dev', 'editing src/main.ts')
		store.appendActivity('dev', 'running npm test')

		const recent = store.getRecentActivities('dev', 2)
		expect(recent).toHaveLength(2)
		expect(recent[0].text).toBe('editing src/main.ts')
		expect(recent[1].text).toBe('running npm test')
	})

	it('deduplicates exact matches', () => {
		const store = new ActivityStore()
		store.appendActivity('dev', 'reading src/main.ts')
		const added = store.appendActivity('dev', 'reading src/main.ts')

		expect(added).toBe(false)
		expect(store.getRecentActivities('dev', 10)).toHaveLength(1)
	})

	it('deduplicates streaming text growth (prefix)', () => {
		const store = new ActivityStore()
		store.appendActivity('dev', "I'll analyze the")
		const added = store.appendActivity('dev', "I'll analyze the test coverage")

		expect(added).toBe(false)
		expect(store.getRecentActivities('dev', 10)).toHaveLength(1)
	})

	it('deduplicates streaming text shrink (superstring)', () => {
		const store = new ActivityStore()
		store.appendActivity('dev', "I'll analyze the test coverage gaps")
		const added = store.appendActivity('dev', "I'll analyze")

		expect(added).toBe(false)
	})

	it('filters noise patterns', () => {
		const store = new ActivityStore()
		const added = store.appendActivity('dev', 'processing tool result...')

		expect(added).toBe(false)
		expect(store.getRecentActivities('dev', 10)).toHaveLength(0)
	})

	it('allows different activities', () => {
		const store = new ActivityStore()
		store.appendActivity('dev', 'reading src/main.ts')
		store.appendActivity('dev', 'editing src/config.ts')

		expect(store.getRecentActivities('dev', 10)).toHaveLength(2)
	})

	it('returns latest activity', () => {
		const store = new ActivityStore()
		store.appendActivity('dev', 'reading src/main.ts')
		store.appendActivity('dev', 'editing src/config.ts')

		expect(store.getLatestActivity('dev')).toBe('editing src/config.ts')
	})

	it('returns undefined for unknown agent', () => {
		const store = new ActivityStore()
		expect(store.getLatestActivity('unknown')).toBeUndefined()
		expect(store.getRecentActivities('unknown', 5)).toEqual([])
	})

	it('maintains global chronological history', () => {
		const store = new ActivityStore()
		store.appendActivity('dev', 'reading src/main.ts')
		store.appendActivity('qa', 'running tests')
		store.appendActivity('dev', 'editing src/main.ts')

		const history = store.getFullHistory()
		expect(history).toHaveLength(3)
		expect(history[0].agentName).toBe('dev')
		expect(history[1].agentName).toBe('qa')
		expect(history[2].agentName).toBe('dev')
	})

	it('caps per-agent buffer at 50', () => {
		const store = new ActivityStore()
		for (let i = 0; i < 60; i++) {
			store.appendActivity('dev', `action ${i}`)
		}

		const recent = store.getRecentActivities('dev', 100)
		expect(recent).toHaveLength(50)
		expect(recent[0].text).toBe('action 10')
		expect(recent[49].text).toBe('action 59')
	})

	it('clears agent history', () => {
		const store = new ActivityStore()
		store.appendActivity('dev', 'something')
		store.clearAgent('dev')

		expect(store.getRecentActivities('dev', 10)).toEqual([])
		// Global history preserved
		expect(store.getFullHistory()).toHaveLength(1)
	})
})
