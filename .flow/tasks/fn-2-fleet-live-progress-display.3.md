# Task fn-2.3: Enhance formatter to match reference UI

**Status:** open
**Files:** `src/status/formatter.ts`, `src/session/state.ts`, `src/session/events.ts`, `test/status/formatter.test.ts`

## Problem

The formatter output is sparse compared to the reference UI. Missing: per-agent message counts, total tokens in header, min-max range on progress bars.

## Changes

1. **Header line**: add total token count after cost
   `Fleet [Executing]                  $2.14  7.0k tok`

2. **Agent cells**: add message count between icon and cost
   `✓ developer  1  $1.50  7.0k`
   The `1` is message count (number of LLM calls completed).

3. **Progress bars**: show range like reference
   `TIME ▓▓▓▓░░░░░░░░░░░░  6m 10s    0-30m`
   `COST ▓▓░░░░░░░░░░░░░░  $2.14     $0-$10`

4. **Expose message count**: The `AgentCost` interface in `session/state.ts` doesn't have `messageCount`. Either:
   - Derive from cost_update event count per agent (count events in state reducer)
   - Or add a counter that increments on each cost_update

## Verification

- Agent cells show message count when available
- Header shows total token count
- Progress bars show min-max range
- Existing formatter tests updated, new tests for message count
