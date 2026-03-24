# fn-1-pi-fleet-multi-agent-terminal.10 Steering handler and status display

## Description
Implement the /fleet-steer command for mid-execution guidance routing and /fleet-status for text-based progress display from both in-memory and persisted state.

**Size:** M
**Files:** src/steer/handler.ts, src/status/display.ts, src/status/formatter.ts, test/steer/handler.test.ts, test/status/display.test.ts, test/status/formatter.test.ts
## Approach

- handler.ts: /fleet-steer command handler. Parse args as "<agent-name> <message>". **Path traversal protection**: validate that agent-name is one of `"all"`, `"dispatcher"`, or an exact match in the running SpecialistRuntime roster (filename stems). Reject names containing path separators (`/`, `\\`, `..`) before constructing any scratchpad path. Look up running specialist by name in FleetState's SpecialistRuntime entries (which carry runId, pid, and optional hostRoutableId from task 6). **Scratchpad steering is the primary v1 mechanism**: append to `.pi/scratchpads/<agent-name>.md` using standardized format: `\n\n---\n\n[STEER <ISO-timestamp> from=<source>]\n<message>`. This ensures multiple rapid steers and "all" broadcasts produce parseable, ordered content. Agents read cooperatively between tool calls. Delivery is best-effort — notify user that the agent will see the message on its next scratchpad read. **sendMessage upgrade path**: if SpecialistRuntime has a `hostRoutableId` (discovered by task 1 smoke test from pi's JSONL stream), use `pi.sendMessage({ to: hostRoutableId, content: message, deliverAs: "steer" })` for immediate delivery after current tool execution completes. If scratchpad write fails, notify user that steer delivery failed via ctx.ui.notify (no automatic stop/restart in v1 — the complexity of reconstructing prompt context, worktree state, and preventing duplicated work is out of scope). If agent not found or finished: notify user via ctx.ui.notify. Support special targets: "all" sends to all running agents, "dispatcher" sends to the orchestrator.
- display.ts: /fleet-status command handler. Read current FleetState — prefer in-memory state if available, fall back to rebuilding from event replay (using state.ts from task 3) when in-memory state is absent (e.g., after resume before execution restarts). Format as text table via formatter. Render via ctx.ui.setWidget("fleet-status", lines). Include: agent name, model, status (queued/running/completed/failed), cost, elapsed time. Totals row. Budget/time remaining.
- formatter.ts: format FleetState into string[] for setWidget. Unicode box-drawing for table borders. Default to plain text (no ANSI escape codes) — setWidget may not render ANSI. Keep compact — widget space limited.
- Register persistent status line via ctx.ui.setStatus("fleet", summary) showing "Fleet: 3/6 agents complete | $2.14 / $10.00 | 12m / 30m" — updates on each cost_update event without requiring /fleet-status.

## Key context

- SpecialistRuntime from task 6 carries runId (extension uuid), pid, and optional hostRoutableId (host-assigned, from JSONL stream)
- Scratchpad steering is the primary v1 mechanism — agents read .pi/scratchpads/<name>.md cooperatively
- pi.sendMessage() with deliverAs: "steer" is an upgrade path requiring hostRoutableId (not runId — runId is extension-generated, not routable by pi)
- /fleet-status must work in three scenarios: (1) during execution (in-memory), (2) after completion (in-memory), (3) after resume before re-execution (rebuilt from events via task 3's state.ts)
- ctx.ui.setWidget(key, lines) renders text array in widget area
- ctx.ui.setStatus(key, text) renders single line in footer status bar
- Event replay for status: task 3's specialist_started events include agentName, runId, pid, worktreePath, model — enough to reconstruct the full status table from persisted state

## Acceptance
- [ ] /fleet-steer <agent-name> <message> routes via scratchpad steering (primary v1 mechanism): appends standardized format `[STEER <timestamp> from=<source>]\n<message>` separated by `\n\n---\n\n`
- [ ] Scratchpad append format tested: multiple rapid steers produce parseable, ordered content
- [ ] sendMessage steering used only when SpecialistRuntime.hostRoutableId is available (upgrade path, not default)
- [ ] User notified of delivery semantics: scratchpad is best-effort cooperative; sendMessage is post-tool-call delivery
- [ ] /fleet-steer all broadcasts to all running agents
- [ ] Steer to finished/nonexistent agent shows helpful error via ctx.ui.notify
- [ ] /fleet-status renders text-based agent table via ctx.ui.setWidget
- [ ] Status works from in-memory state during execution and from event replay after resume
- [ ] Status table shows: agent, model, status, cost, elapsed time, totals
- [ ] Persistent footer status line updates on each cost_update event
- [ ] Tests verify scratchpad steer routing, sendMessage path (mocked), and status formatting from both memory and event replay
## Done summary
Implemented /fleet-steer command handler with scratchpad steering (primary v1 mechanism) and sendMessage upgrade path, plus /fleet-status command with text-based table display from in-memory or event-replayed state. Added persistent footer status line via setStatus, Unicode box-drawing formatter, and path traversal protection. 44 new tests covering steer routing, format parsing, sendMessage mocking, and status rendering from both memory and replay sources.
## Evidence
- Commits: 871a340c9d2cc48f0848693a59c4f46c43ad4c10
- Tests: npx vitest run (383 passed), npx tsc --noEmit (no new errors)
- PRs: