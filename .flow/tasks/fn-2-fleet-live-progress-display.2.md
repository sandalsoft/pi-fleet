# Task fn-2.2: Add periodic timer refresh

**Status:** open
**Files:** `src/dispatch/dispatcher.ts`

## Problem

The TIME progress bar and elapsed counters go stale between events. An agent can run for minutes with the timer frozen at whatever it was during the last event.

## Fix

Add a `setInterval` (every 3 seconds) in the dispatch loop that calls `refreshWidget()`. This keeps elapsed time, progress bars, and summary counters current.

- Start the interval after the session_start event
- Clear it after the dispatch loop completes (in the finally block)
- Also clear on abort/cancel

## Verification

- TIME progress bar advances smoothly during execution
- Elapsed time in summary line updates every few seconds
- Interval is cleaned up after session ends (no leaked timers)
