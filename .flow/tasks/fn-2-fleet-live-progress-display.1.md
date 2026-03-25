# Task fn-2.1: Fix activities propagation in extension.ts

**Status:** open
**Files:** `src/extension.ts`, `src/dispatch/dispatcher.ts`

## Problem

The cost update callback in extension.ts calls `updateProgressWidget({ ui: ctx.ui }, currentState)` without the activities map. This overwrites the activity-rich widget rendered by the dispatcher with a static version.

## Fix

Remove the `updateProgressWidget` call from the cost callback in extension.ts. The dispatcher's `commitState()` and `refreshWidget()` already handle widget updates during execution — the cost callback is redundant and actively harmful (it erases activities).

Keep the cost callback for logging/tracking purposes only, remove the widget update from it.

## Verification

- Activities from streaming JSONL appear in the widget during execution
- Widget shows "agentName: reading src/..." lines while agents work
