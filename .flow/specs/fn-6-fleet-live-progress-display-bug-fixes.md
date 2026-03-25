# Fleet Live Progress Display — Bug Fixes and Per-Agent Timestamps

## Overview

The live progress widget infrastructure (FleetProgressComponent, factory install, dispatcher refresh loop) is already implemented across `src/status/fleet-progress-component.ts`, `src/status/display.ts`, and `src/dispatch/dispatcher.ts`. But it has two categories of bugs that prevent it from working correctly during execution, plus a missing feature for per-agent elapsed time.

**Bug 1 — Double cost counting**: The `onStreamLine` callback in the dispatcher extracts streaming usage events (line 255-268) and accumulates them into in-memory `FleetState` via `reduceEvent`. After the subprocess exits, `buildSpawnResult` re-parses the ENTIRE accumulated JSONL buffer via `parseJsonlStream`, which produces a `result.usage` total. The dispatcher then reduces this total as ANOTHER `cost_update` event (line 346-354). Since both code paths process the same JSONL usage events, every agent's cost, input tokens, and output tokens are roughly 2x what they should be.

**Bug 2 — `slice()` on themed strings + width unsafety**: Four `String.slice()` calls in the component truncate fragily. The `Math.max(40, width)` clamp can emit lines wider than the TUI's actual `width`, causing pi-tui to throw.

**Missing feature — Per-agent elapsed time**: `SpecialistRecord` has no `startedAt` field.

## Scope

**In scope:**
- Fix double cost counting (USD, inputTokens, outputTokens) in dispatcher streaming + final usage pipeline
- Add `startedAt` and `completedAt` timestamps to `SpecialistRecord`
- Fix all SpecialistRecord construction sites (`spawner.ts`, `steer/handler.ts`, `types.ts`, all tests)
- Wire timestamps through `reduceEvent`
- Create `formatAgentElapsed()` helper with null-safe + NaN-safe display rules and `now` parameter for deterministic testing
- Keep `collectAgentRows()` pure (no `Date.now()` calls; return raw timestamps)
- Display per-agent elapsed time in the component and formatter
- Fix width authority: `width` parameter is authoritative for truncation, not clamped `w`
- Replace `slice()` with `truncateToWidth()` using consistent ellipsis policy (inner: `'\u2026'`, outer: `''`)
- Fix progress bar width using dynamic `visibleWidth()` measurement instead of magic constant
- Dynamic `overheadLines`: 2 (no constraints), 3 (side-by-side bars), 4 (stacked bars)
- Consolidate duplicated helpers
- Update CLAUDE.md and README

**Out of scope:**
- State subscription mechanism in runtime-store
- Configurable color scheme in teams.yaml
- `/fleet-log` overlay merging
- Fractional Unicode block progress bars
- Render batching via microtask coalescing

## Architecture

### Double Cost Fix

`resetAgentCost(state, agentName)` zeros ALL three `AgentCost` fields (`inputTokens`, `outputTokens`, `costUsd`) and recalculates `totalCostUsd`. Then `reduceEvent` with the final cost_update adds authoritative totals. Single `commitState()` call: `commitState(reduceEvent(resetAgentCost(state, agentName), finalCostEvent))`.

### Per-Agent Timestamps

`SpecialistRecord` gains `startedAt: string | null` and `completedAt: string | null`.
- `specialist_started` handler: `{ startedAt: known.timestamp, completedAt: null }`
- `specialist_completed`/`specialist_failed`: `{ completedAt: known.timestamp }`
- All non-reducer construction sites: `{ startedAt: null, completedAt: null }`

### `formatAgentElapsed(startedAt, completedAt, now?)`

- Returns `-` for null `startedAt`
- Guards `Number.isFinite()` after parsing — invalid ISO strings return `-`
- Running (completedAt null): `formatElapsed(now - startMs)`
- Completed/failed: `formatElapsed(endMs - startMs)`
- `now` parameter enables deterministic testing

### `collectAgentRows()` — Pure, No Side Effects

Does NOT call `Date.now()`. Returns `AgentRow` with raw `startedAt`/`completedAt` strings. The rendering layer calls `formatAgentElapsed()` at render time so elapsed is always fresh.

### Width Authority

`width` (the TUI parameter) is authoritative for all `truncateToWidth()` output calls. A separate `layoutWidth = Math.max(40, width)` handles internal column positioning. Final lines: `truncateToWidth(line, width, '')`.

### Ellipsis Policy

- Inner field truncation: `truncateToWidth(text, maxWidth, '\u2026')` — user-visible
- Outer line safety: `truncateToWidth(line, width, '')` — hard clamp, no extra dots
- Rule: every line-level truncation in the component uses empty ellipsis

### Dynamic Height Budget

`overheadLines` depends on constraints and layout:
- No `state.constraints`: 2 (header + summary only)
- Side-by-side bars: 3 (+ 1 bar line)
- Stacked bars: 4 (+ 2 bar lines)

## Key Decisions

1. **Reset ALL AgentCost fields atomically** — single `commitState()`, no intermediate render
2. **Use event envelope `timestamp`** — no new event fields
3. **Reset `completedAt` on start** — prevents stale values
4. **Partial mock for dispatcher tests** — `vi.importActual` keeps real streaming extraction
5. **Mock `updateProgressWidget`** — isolates cost assertions from component factory complexity
6. **`formatAgentElapsed()` guards `Number.isFinite()`** — handles malformed timestamps
7. **`collectAgentRows()` is pure** — no `Date.now()`, timestamps computed at render time
8. **`width` is authoritative** — `layoutWidth` for internals, `width` for output
9. **Consistent ellipsis** — inner `'\u2026'`, outer `''`
10. **Dynamic `overheadLines`** — 2/3/4 depending on constraints and layout

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SpecialistRecord shape change breaks many files | High | Medium | All construction sites enumerated in task 2 |
| Cost reset produces transient display glitch | Low | Low | Single `commitState()` call |
| Dispatcher test complexity | Medium | Medium | Documented mock strategy with partial imports and display stub |
| Invalid timestamp strings produce NaN | Low | Medium | `Number.isFinite()` guard returns `-` |
| Time-dependent test flakiness | Medium | Medium | `now` parameter on `formatAgentElapsed()` |

## Quick commands

```bash
npm run typecheck   # Verify type changes compile
npm test            # Full test suite
npm run build       # Bundle with esbuild
```

## Acceptance

- [ ] Costs/tokens shown during execution match final values (no 2x inflation)
- [ ] Cost reset + final set in single `commitState()` call
- [ ] Running agents show per-agent elapsed time
- [ ] Completed/failed agents show total duration
- [ ] Queued agents and null/NaN timestamps display `-`
- [ ] `SpecialistRecord` has `startedAt` and `completedAt` (both `string | null`)
- [ ] `specialist_started` reducer sets `completedAt: null`
- [ ] All construction sites updated (spawner, steer handler, types, tests)
- [ ] `formatAgentElapsed()` guards `Number.isFinite()`, accepts `now` parameter
- [ ] `collectAgentRows()` is pure — no `Date.now()` calls
- [ ] `width` parameter is authoritative for output truncation
- [ ] Inner truncation: `'\u2026'`; outer line-level: `''`
- [ ] Progress bar widths from `visibleWidth()` measurement
- [ ] `overheadLines` dynamic: 2/3/4 based on constraints + layout
- [ ] Helpers consolidated into formatter.ts
- [ ] CLAUDE.md and README updated
- [ ] All tests pass, new tests for cost fix + timestamps + elapsed
- [ ] `npm run typecheck` and `npm run build` pass

## References

- `src/dispatch/dispatcher.ts` — streaming cost L255-268, final cost L346-354, commitState L115-120
- `src/dispatch/spawner.ts` — `extractStreamingUsage` L192-238, `buildSpawnResult` L501-523
- `src/dispatch/types.ts` — `SpecialistRuntime` extends `SpecialistRecord`
- `src/session/state.ts` — `SpecialistRecord` L17-25, `AgentCost` L28-33, `reduceEvent` L93-260
- `src/session/events.ts` — `FleetEventEnvelopeSchema`, event types
- `src/steer/handler.ts` — synthetic dispatcher SpecialistRecord
- `src/status/fleet-progress-component.ts` — `slice()` L212/236/243/259, `Math.max(40, width)` L125, progress bar L272-278
- `src/status/formatter.ts` — `formatElapsed` L43, `collectAgentRows` L110
- `src/status/display.ts` — singleton factory L64-132
