# fn-1-pi-fleet-multi-agent-terminal.3 Session persistence and event schema

## Description
Define the fleet event schema as a versioned discriminated union and implement session persistence using pi's appendEntry/getEntries API for event-sourced state management.

**Size:** M
**Files:** src/session/events.ts, src/session/event-log.ts, src/session/state.ts, src/session/resume.ts, src/session/runtime-store.ts, test/session/events.test.ts, test/session/state.test.ts, test/session/resume.test.ts
## Approach

- Define FleetEvent using **two-layer parsing** (NOT `z.discriminatedUnion()` which rejects unknown type values). Layer 1 (envelope): `z.object({ schemaVersion: z.number(), type: z.string(), timestamp: z.string() }).passthrough()` — accepts ALL events including unknown future types. Layer 2 (known events): a map of per-type Zod schemas keyed by `type` string. Unknown `type` values are preserved as `UnknownFleetEvent` and skipped by state reducers (never rejected). Known event types: session_start, interview_complete, team_selected, task_graph_created, worktree_created, specialist_started, specialist_completed, specialist_failed, cost_update, merge_started, merge_completed, merge_conflict, consolidation_complete, budget_warning, time_warning, session_complete, session_aborted
- Each event carries a timestamp (ISO string), schemaVersion, and event-specific payload. **`session_start` must persist**: `startedAt` (ISO timestamp), `repoRoot`, `baseSha`, and a snapshot of the team `constraints` (maxUsd, maxMinutes, taskTimeoutMs, maxConcurrency) used for this session. This enables /fleet-status to show elapsed time and budget remaining from event replay without re-reading teams.yaml (which may have changed).
- **SpecialistRecord fields in events** (JSON-safe, no AbortController or process handles): specialist_started must include agentName, runId, pid, worktreePath, model. specialist_completed/specialist_failed must include agentName, runId. cost_update must include agentName. These fields enable /fleet-steer routing (task 10) and status display after resume via event replay.
- event-log.ts: thin wrapper around pi.appendEntry("fleet-event", event) for writes. Replays via ctx.sessionManager.getEntries() filtering for customType === "fleet-event"
- **Replay tolerance**: Use Zod in passthrough mode during replay — unknown fields are preserved, not rejected. This allows older sessions to be replayed after schema additions. Only fail on structurally invalid events (missing type/schemaVersion)
- runtime-store.ts: Module-level singleton store that holds in-memory FleetState. Exports `getFleetState()`, `setFleetState()`, `clearFleetState()`. `/fleet` sets it on start/resume; `/fleet-steer` and `/fleet-status` read from it. When store is empty (e.g., process restarted), consumers fall back to event replay. This avoids threading FleetState through every command handler.
- state.ts: FleetState type representing current session state. Reconstructed via Array.reduce() over events. Tracks: phase (interview/dispatching/executing/merging/complete), active agents with SpecialistRuntime info (agentName, runId, pid, worktreePath, status), task graph with completion states, cumulative cost per agent, elapsed time, base commit SHA
- resume.ts: on session_start event, check for incomplete fleet session. Reconstruct state. Detect interrupted specialists (started but not completed/failed). Offer resume via ctx.ui.confirm(). **Command wiring**: the `/fleet` command handler (task 1's `src/extension.ts`) must parse `--resume` from args and call `resume()` before starting the interview/dispatch flow. If no incomplete session or user declines resume, fall through to normal flow. This task implements the resume module; task 1's extension entry must wire `--resume` arg parsing.
- Handle JSONL corruption: skip entries where data fails to parse as FleetEvent (log warning, don't crash)
- Write session_complete event for clean end detection vs crash detection

## Key context

- pi.appendEntry() persists to pi's session file (JSONL). NOT a custom file in .pi/fleet-sessions/. Pi handles the file storage.
- ctx.sessionManager.getEntries() returns all session entries including custom ones
- State reconstruction must be fast: < 2s for 10,000 events
- During execution, in-memory FleetState is the source of truth. Events are the persistence/audit layer.
- schemaVersion enables future schema evolution without breaking replay of old sessions
- SpecialistRuntime fields (agentName, runId, pid, worktreePath) in events are critical for: (1) /fleet-steer routing by agent name to correct runId/pid, (2) /fleet-status display after resume when in-memory state must be rebuilt from events, (3) worktree cleanup on resume detecting orphaned worktrees

## Acceptance
- [ ] FleetEvent uses two-layer parsing (envelope + per-type schemas, NOT z.discriminatedUnion); unknown types preserved as UnknownFleetEvent
- [ ] specialist_started events include agentName, runId, pid, worktreePath, model
- [ ] specialist_completed/specialist_failed events include agentName, runId
- [ ] cost_update events include agentName for per-agent attribution
- [ ] event-log.ts wraps pi.appendEntry() for writes and getEntries() for reads
- [ ] state.ts reconstructs FleetState (including SpecialistRuntime info) from event sequence via reduce()
- [ ] Zod passthrough mode tolerates unknown fields during replay (forward compat)
- [ ] resume.ts detects incomplete sessions and offers resume
- [ ] /fleet --resume arg parsing documented; extension entry wires --resume to resume flow before interview
- [ ] Handles corrupted/unparseable entries gracefully (skip + warn)
- [ ] Clean vs crashed session detection via session_complete event
- [ ] Tests verify state reconstruction produces correct state from event sequences
- [ ] Tests verify SpecialistRuntime fields survive round-trip through persist/replay
- [ ] Tests verify corruption handling and schema version tolerance
- [ ] session_start event persists startedAt, repoRoot, baseSha, and constraints snapshot
- [ ] All FleetEvent payloads are JSON-serializable (test: JSON.stringify(event) does not throw, required fields preserved)
- [ ] runtime-store.ts: module-level singleton with getFleetState/setFleetState/clearFleetState; /fleet sets, /fleet-steer and /fleet-status read
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
