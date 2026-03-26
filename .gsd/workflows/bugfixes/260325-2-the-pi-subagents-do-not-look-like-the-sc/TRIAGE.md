# Triage: Subagent Status Widget Layout Mismatch

**Date:** 2026-03-26  
**Screenshot:** `/Users/eric/screenshots/SCR-20260323-ojbf.png`

## Expected vs Actual

### Expected (screenshot)
The bottom panel shows a **2-column agent grid**:
```
✅ Revenue           ~1  💰$0.18  🧠977k   ✅ Product Strategist  ~1  💰$0.12  🧠979k
✅ Technical Arch    ~1  💰$0.20  🧠973k   🔄 Contrarian          ~0  💰$0.00  🧠1.0M
🔄 Compounder        ~0  💰$0.00  🧠1.0M   🔄 Moonshot            ~0  💰$0.00  🧠1.0M
```
Each cell shows: `<icon> <AgentName padded>  <turnCount>  <cost>  <tokens>`  
The header row shows: `CEO [deliberating]` + total cost/tokens right-aligned.

### Actual (current code)
Both `FleetProgressComponent` and `formatStatusTable` render a **vertical tree list**:
```
  Fleet [Executing]                        $2.14 / $10.00
  ├─ ✓ developer       $1.50  7.0k
  │    └─ done
  ├─ ● reviewer        $0.64  4.0k
  │    └─ starting...
  └─ ○ architect       -      -
       └─ waiting
  TIME ▓▓▓▓▓░░░░░  12m / 30m    COST ▓▓░░░░░░░  $2.14 / $10.00
  1/3 complete | 12m
```

## Root Cause

The layout in the screenshot is a **2-column side-by-side grid** with turn counts — neither of these exists in the current codebase:

1. **No 2-column grid layout** — `renderAgentRow()` in `FleetProgressComponent` and `formatAgentTreeRow()` in `formatter.ts` both produce single-row tree entries. The agents are stacked vertically with `├─`/`└─` connectors.

2. **No turn count column** — The `AgentRow` interface does not include a `turnCount` field. The `SpecialistRecord` in `state.ts` does not track turn count. The screenshot shows `~1` for completed agents and `~0` for queued.

3. **Sub-tree activity items** — The current code shows sub-tree rows (activities, errors) under each agent row. The screenshot shows agents side-by-side with no sub-rows; activity text streams in the main chat body instead.

The `FleetState` does **not** have a per-agent turn count. However `ActivityStore` (or cost updates via `cost_update` events) could be used as a proxy, or the turn count needs to be added to `SpecialistRecord` / event schema.

## Affected Files

| File | What to change |
|---|---|
| `src/status/fleet-progress-component.ts` | Replace tree layout with 2-column grid; remove sub-tree items |
| `src/status/formatter.ts` | Replace `formatAgentTreeRow` with 2-column grid renderer |
| `src/session/state.ts` | Add `turnCount` to `SpecialistRecord` |
| `src/session/events.ts` | Check if `cost_update` carries enough info or add turn count |
| `test/status/fleet-progress-component.test.ts` | Update tests to expect grid layout, not tree connectors |
| `test/status/formatter.test.ts` | Update test that asserts tree connectors `├─` / `└─` |

## Proposed Fix

### Approach
1. **Add turn count tracking** to `SpecialistRecord` (increment on each `cost_update` event, which fires once per LLM turn).
2. **Rewrite `renderState()`** in `FleetProgressComponent` to use a 2-column grid:
   - Pair agents left/right: `[0,1]`, `[2,3]`, `[4,5]`, ...
   - Each cell: `icon name  ~turns  cost  tokens`, padded to half-width
   - Remove sub-tree items (activities shown in chat, not widget)
3. **Rewrite `formatStatusTable()`** fallback similarly.
4. **Update tests** to assert grid layout (`~1`, 2 agents per line) and remove tree connector assertions.

### Turn count proxy
Use the count of `cost_update` events per agent as the turn counter — each LLM turn generates one `cost_update`. This requires adding a `turnCount: number` field to `SpecialistRecord` and incrementing it in `reduceEvent` when `case 'cost_update'` fires for a known specialist.

### Scope
Low — pure rendering change. No changes to dispatching, merging, or session logic beyond adding `turnCount` to state.
