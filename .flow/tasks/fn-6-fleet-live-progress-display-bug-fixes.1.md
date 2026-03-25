## Description

Fix double cost counting in the dispatcher's streaming usage pipeline. Streaming costs are accumulated into FleetState during execution (L255-268), then `parseJsonlStream` re-accumulates the same events as a final total (L346-354). All three `AgentCost` fields (inputTokens, outputTokens, costUsd) are roughly 2x actual.

This task fixes *double application in the dispatcher only* — i.e., preventing the same usage data from being reduced twice. It does not address potential internal double-counting within `parseJsonlStream` itself (where multiple event types might carry overlapping usage data), which is a separate concern if it exists.

**Size:** M
**Files:** `src/dispatch/dispatcher.ts`, `test/dispatch/dispatcher.test.ts` (new), `test/dispatch/spawner.test.ts`

## Approach

### Atomic completion + cost reset + final cost

Currently the code commits the completion/failure event THEN later commits the final cost_update. After streaming, the completion render shows inflated streaming totals. Fix by combining all three mutations into a single `commitState()`:

```
state = reduceEvent(state, completedEvent)  // mark agent complete
state = resetAgentCost(state, agentName)     // zero streaming costs
state = reduceEvent(state, finalCostEvent)   // apply authoritative total
commitState(state)                           // single render
```

Persist events to the log at the appropriate points (completion event, cost event via onUsage), but only call `commitState()` once with the fully-computed state.

`resetAgentCost()` zeros ALL fields: `{ inputTokens: 0, outputTokens: 0, costUsd: 0 }` and recalculates `totalCostUsd`.

### Testing strategy

`dispatch()` has heavy side effects. Isolate cost logic with thorough mocking:

**Spawner** — partial mock to keep real streaming extraction:
```typescript
vi.mock('../../src/dispatch/spawner.js', async () => {
    const actual = await vi.importActual('../../src/dispatch/spawner.js')
    return { ...actual, spawnSpecialist: vi.fn(), readSmokeResults: vi.fn().mockResolvedValue(null) }
})
```

**Display** — stub to avoid component factory:
```typescript
vi.mock('../../src/status/display.js', () => ({ updateProgressWidget: vi.fn(), clearProgressWidget: vi.fn() }))
```

**Prompt composition** — stub to avoid filesystem reads:
```typescript
vi.mock('../../src/dispatch/prompt-composer.js', () => ({ composePrompt: vi.fn().mockResolvedValue('test prompt') }))
```

**UI context**: `{ setWidget: vi.fn(), setStatus: vi.fn(), setWorkingMessage: vi.fn(), notify: vi.fn() }`

**Filesystem**: Use a tmpdir for `repoRoot` and let `mkdir` happen there naturally, OR mock `fs/promises` mkdir.

**Timers**: Use `vi.useFakeTimers()` to control the periodic refresh interval, or verify no open handles after test.

**Runtime store**: Call `clearFleetState()` in `afterEach` to reset global state.

Assertion: after dispatch returns, `state.costs.get(agentName)` fields match `calculateCost(result.usage, model)` exactly — not streaming + final.

## Acceptance

- [ ] After agent completion, cost/tokens equal `calculateCost(result.usage, model)` — not 2x
- [ ] Completion event + cost reset + final cost committed in single `commitState()` — no intermediate glitch
- [ ] Streaming costs still update live during execution (streaming path preserved)
- [ ] `totalCostUsd` matches sum of all agent costs after completion
- [ ] Test uses partial mock (`vi.importActual`) for spawner, stubs display/prompt-composer
- [ ] Test uses tmpdir or mocked fs for repoRoot
- [ ] Test handles timer cleanup (fake timers or verified no open handles)
- [ ] Test resets runtime store between runs
- [ ] `npm run typecheck` passes

## Done summary
Fixed double cost counting in the dispatcher streaming pipeline by adding resetAgentCost() to zero streaming-accumulated costs before applying the authoritative final cost from parseJsonlStream, all in a single commitState() call. Added comprehensive dispatcher tests with partial spawner mock and resetAgentCost unit tests.
## Evidence
- Commits: 41b575337f62e91c71ab319ef07ad7a0ec54723d
- Tests: npm test, npm run typecheck
- PRs: