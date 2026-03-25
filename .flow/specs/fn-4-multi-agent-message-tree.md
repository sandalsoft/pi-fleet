# fn-4: Multi-Agent Message Tree

## Problem

The widget shows only the latest activity per agent — a single line. The user can't see what led to the current state, when agents fail there's no context, and there's no way to scroll back through history. The user wants to see recent messages per agent in a tree structure, with old messages scrolling off and the ability to review history.

## Architecture

Two-tier approach using different pi APIs for different needs:

### Tier 1: Expanded status widget (always visible)

The existing component factory widget (no 10-line cap) shows a **nested tree** with the last 2-3 activity messages per agent:

```
Fleet [Executing]                                           $0.42 / $10.00
├─ ● developer      $0.20  3.2k
│  ├─ reading src/config/schema.ts
│  ├─ editing src/main.ts
│  └─ running npm test
├─ ✗ qa             $0.00     -
│  └─ ERROR: test suite not found
└─ ○ reviewer          -      -
   └─ waiting
TIME ▓▓▓▓░░░░░░░░  2m / 30m    COST ▓▓░░░░░░░░░░  $0.42 / $10
1/3 complete | 2m
```

This requires:
- A rolling buffer of recent activities per agent (last 3 events)
- The streaming callback appends to the buffer (not overwrites)
- The component renders sub-tree lines under each agent

### Tier 2: `/fleet-log` overlay (on demand)

A scrollable overlay opened via `ctx.ui.custom()` showing the complete activity history for all agents. Up/down keys scroll, Escape closes. Full history preserved (not just last 3).

```
Fleet Activity Log (↑↓ scroll, ESC close)
─────────────────────────────────────────
[0:12] developer  reading src/config/schema.ts
[0:14] developer  editing src/main.ts
[0:15] qa         ERROR: test suite not found
[0:18] developer  running npm test
[0:22] reviewer   I'll begin reviewing the implementation...
[0:25] developer  writing test/config/schema.test.ts
```

## Plan

### Task 1: Activity history buffer

**Files:** `src/status/activity-store.ts` (new)

Create a per-agent activity history store:
- `appendActivity(agentName, activity)` — adds to a ring buffer
- `getRecentActivities(agentName, count)` — returns last N activities
- `getFullHistory()` — returns all activities (timestamped) for the log overlay
- Ring buffer per agent, capped at 50 entries
- Each entry: `{ timestamp: number, agentName: string, text: string }`

### Task 2: Wire activity buffer into dispatcher

**Files:** `src/dispatch/dispatcher.ts`

Change the `onStreamLine` callback from `activities.set(name, text)` (overwrites) to `activityStore.appendActivity(name, text)`. Pass the store's recent activities to the component.

### Task 3: Render sub-tree in the TUI component

**Files:** `src/status/fleet-progress-component.ts`

Update `renderAgentRow` to render 2-3 sub-tree lines under each agent showing recent activities:
```
├─ ● developer      $0.20  3.2k
│  ├─ reading src/config/schema.ts
│  └─ running npm test
```

Use `│  ├─` for middle items and `│  └─` for last item. Limit to 3 sub-items per agent to keep the widget within ~20 lines for a 4-agent team.

### Task 4: `/fleet-log` scrollable overlay

**Files:** `src/status/log-overlay.ts` (new), `src/extension.ts`

Use `ctx.ui.custom()` to create a scrollable overlay:
- Receives the full activity history from the store
- Renders a timestamped log with agent name prefixes
- `handleInput` for up/down scrolling, Escape to close
- `maxHeight: "70%"` in overlay options

## Task Dependencies

```
Task 1 (activity store) → Task 2 (wire into dispatcher)
                        → Task 3 (sub-tree rendering)
                        → Task 4 (log overlay)
```

Task 1 is the foundation. Tasks 2, 3, 4 can be done in parallel after it.
