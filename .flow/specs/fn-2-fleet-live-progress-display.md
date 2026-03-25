# fn-2: Fleet Live Progress Display

## Problem

The fleet progress widget shows static stats that rarely update. Users can't tell what agents are doing during execution. Costs show $0.00 throughout. Three categories of bugs:

1. **Activities wiped by cost callback**: extension.ts cost callback calls `updateProgressWidget` without the activities map, stomping live activity lines rendered by the dispatcher
2. **Timer frozen**: No periodic refresh — elapsed time and progress bars stale between events
3. **Cost/token extraction broken**: Pi SDK emits `type: "done"` events with `Usage { input, output, cost: { total } }` but the parser checks for `"message_end"` events with `input_tokens`/`output_tokens` fields. Three field/type mismatches cause all usage data to be lost.

## Plan (Revised after Carmack review)

### Task 1: Fix activities propagation (fn-2.1)
Remove the `updateProgressWidget` call from the cost callback in extension.ts (line 152). The dispatcher's `commitState()` and `refreshWidget()` already handle widget updates during execution. The cost callback re-renders without activities, erasing live status for still-running agents when any agent's cost event fires. Post-dispatch calls (lines 319, 373, 387) stay as-is — activities are cleared by then.

### Task 2: Add periodic timer refresh + throttle (fn-2.2)
Add a 3-second `setInterval` in the dispatcher that calls `refreshWidget()`. Wrap the wave loop in try/finally to guarantee cleanup. Also add a 200ms throttle to `refreshWidget()` — without it, a fast-streaming agent producing 50 JSONL lines/sec causes 50+ widget renders/sec across concurrent agents.

### Task 3: Enhance formatter (fn-2.3)
Minimal changes only: add total token count to the header line. Defer message count, min-max ranges, and other cosmetic changes — the core problem is that activities/costs aren't showing at all.

### Task 4: Fix cost and token extraction (fn-2.4)
Three bugs in the usage pipeline:
- `parseJsonlStream` doesn't handle pi's `type: "done"` event (only checks `message_end`/`result`)
- `normalizeUsage` doesn't check bare `input`/`output`/`cacheRead` field names (only `inputTokens`/`input_tokens`)
- `normalizeUsage` treats `cost` as a number but pi sends `cost: { total: 0.42 }`

## Task Dependencies

```
Task 1 (activities) ─────┐
Task 2 (timer+throttle) ─┤  All independent
Task 3 (formatter) ──────┤
Task 4 (cost extraction) ┘
```

## Acceptance Criteria

- [ ] During execution, widget shows live activity lines ("reading src/...", "running npm test")
- [ ] Elapsed time advances smoothly (every ~3s), not just on events
- [ ] Widget doesn't thrash at high streaming rates (throttled to ~5 renders/sec)
- [ ] Costs show actual USD amounts after agent completion (not $0.00)
- [ ] Token counts show real numbers (not `-`)
- [ ] All existing tests pass, new tests for usage parsing with pi SDK format
