## Description

Add `startedAt` and `completedAt` timestamps to `SpecialistRecord` so the widget can display per-agent elapsed time.

**Size:** M
**Files:** `src/session/state.ts`, `src/dispatch/spawner.ts`, `src/dispatch/types.ts`, `src/steer/handler.ts`, `src/status/fleet-progress-component.ts`, `src/status/formatter.ts`, `test/session/state.test.ts`, `test/session/events.test.ts`, `test/session/resume.test.ts`, `test/chain/runner.test.ts`, `test/status/display.test.ts`, `test/status/fleet-progress-component.test.ts`, `test/status/formatter.test.ts`, `test/steer/handler.test.ts`

## Approach

1. **Extend `SpecialistRecord`** (state.ts L17-25):
   - Add `startedAt: string | null` and `completedAt: string | null`

2. **Update `reduceEvent`** (state.ts):
   - `specialist_started`: `{ startedAt: known.timestamp, completedAt: null }`
   - `specialist_completed`/`specialist_failed`: `{ completedAt: known.timestamp }`

3. **Fix ALL construction sites** — run `rg "runtime: \{|SpecialistRuntime|SpecialistRecord|agentName.*runId" test src` to find every literal. Known sites:
   - `src/dispatch/spawner.ts` — `buildSpawnResult()` constructs `SpecialistRuntime`
   - `src/dispatch/types.ts` — `SpecialistRuntime` interface extends `SpecialistRecord`
   - `src/steer/handler.ts` — dispatcher pseudo-agent
   - `test/chain/runner.test.ts` — `SpawnResult.runtime` mocks
   - `test/session/state.test.ts`, `test/session/events.test.ts`, `test/session/resume.test.ts`
   - `test/status/display.test.ts`, `test/status/formatter.test.ts`, `test/status/fleet-progress-component.test.ts`
   - `test/steer/handler.test.ts`
   - All set `startedAt: null, completedAt: null` (only reducer sets real timestamps)

4. **Create `formatAgentElapsed()` helper** in formatter.ts:
   - Signature: `formatAgentElapsed(startedAt: string | null, completedAt: string | null, now?: number): string`
   - Returns `-` for null `startedAt`
   - Parse timestamps, guard with `Number.isFinite()` — return `-` for NaN
   - Clamp duration: `Math.max(0, endMs - startMs)` — handles clock skew, malformed logs
   - Running (completedAt null, startedAt valid): `formatElapsed(Math.max(0, (now ?? Date.now()) - startMs))`
   - Completed/failed: `formatElapsed(Math.max(0, endMs - startMs))`
   - `now` parameter for deterministic testing

5. **Keep `collectAgentRows()` pure** — return raw `startedAt`/`completedAt` strings in `AgentRow`. Elapsed computed at render time.

6. **Update component and formatter** to show per-agent elapsed using `formatAgentElapsed()` at render time.

## Key context

- `SpecialistRuntime` extends `SpecialistRecord` — shape change propagates to runtime type and `SpawnResult.runtime`
- `test/chain/runner.test.ts` constructs `SpawnResult` with embedded `runtime` objects — must add new fields
- `timestamp` validated as `z.string()` not `z.string().datetime()` — malformed values possible
- `formatElapsed(0)` returns `"0s"` — `formatAgentElapsed()` returns `-` for null/NaN

## Acceptance

- [ ] `SpecialistRecord` has `startedAt: string | null` and `completedAt: string | null`
- [ ] `specialist_started` reducer sets `completedAt: null` explicitly
- [ ] ALL construction sites updated — verified with repo-wide grep
- [ ] `test/chain/runner.test.ts` SpawnResult mocks compile with new fields
- [ ] `formatAgentElapsed()` returns `-` for null/NaN, uses `Math.max(0, ...)` for negative durations
- [ ] `formatAgentElapsed()` accepts `now` parameter for deterministic testing
- [ ] `collectAgentRows()` does NOT call `Date.now()` — returns raw timestamps
- [ ] Running agents show elapsed time; completed/failed show duration; queued show `-`
- [ ] Tests use fixed `now` values
- [ ] `npm run typecheck` passes

## Done summary
Added startedAt and completedAt timestamps to SpecialistRecord, wired them through the event reducer, and created a formatAgentElapsed() helper with null/NaN guards and a now parameter for deterministic testing. Updated all construction sites across source and test files, and always display the elapsed column (including `-` for queued agents).
## Evidence
- Commits: d29831dfc7c17e6b26856b2a6e8e1e49b94e3b0e, 7403823a5f0277eaefb9163b9466beebcecf5873
- Tests: npm test, npm run typecheck, npm run build
- PRs: