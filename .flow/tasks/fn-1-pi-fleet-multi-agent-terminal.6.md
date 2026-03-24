# fn-1-pi-fleet-multi-agent-terminal.6 DAG executor and dispatcher orchestration

## Description
Implement the core orchestration loop: DAG-based task dependency resolution, wave-parallel execution, specialist spawning via pi subprocesses, prompt composition, and output consolidation.

**Size:** M (largest task — bordering L but cohesive enough to stay together)
**Files:** src/dispatch/dispatcher.ts, src/dispatch/task-graph.ts, src/dispatch/prompt-composer.ts, src/dispatch/consolidator.ts, src/dispatch/spawner.ts, src/dispatch/types.ts, test/dispatch/task-graph.test.ts, test/dispatch/spawner.test.ts, test/dispatch/prompt-composer.test.ts, test/dispatch/consolidator.test.ts
## Approach

- **types.ts**: Define normalized `Usage` type with canonical field names (inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost). Define two specialist types to avoid serializing non-JSON data: **`SpecialistRecord`** (persistable — JSON-safe, used in FleetEvent payloads and FleetState): runId, pid, agentName, worktreePath, model, status, hostRoutableId (optional). **`SpecialistRuntime`** (live, in-memory only — extends SpecialistRecord): adds abortController (AbortController), process handle, signal refs. FleetEvent payloads and pi.appendEntry() only use SpecialistRecord fields. Task 3 should add a test verifying `JSON.stringify(event)` does not throw and doesn't drop required fields. SpecialistRuntime is used by the dispatcher loop for process management; SpecialistRecord is extracted from it for persistence and status display.
- task-graph.ts: Kahn's algorithm for topological sort producing execution waves. Each wave contains tasks whose dependencies are all satisfied. detectCycles() for validation. Each task assignment includes `expectedPaths: string[]` (approximate file paths the agent will touch). Tasks with overlapping expectedPaths are conservatively placed in different waves. If expectedPaths is empty/absent, the task defaults to sequential execution.
- spawner.ts: `spawn("pi", ["--mode", "json", "-p", "--no-session", "--model", model, ...])` in worktree cwd. This is Node.js child_process.spawn — NOT pi.exec(). pi.exec() is for git commands and CLI tools; subagent spawning requires spawn() for JSONL streaming. **Prompt delivery mode**: read `preferredPromptMode` from `.pi/smoke-results.json` (task 1 writes this). If `"trailing-arg"`, use trailing arg. If `"stdin-pipe"`, pipe via stdin. If `null` or file missing, try trailing arg first; if pi rejects it (exit code with "unknown" in stderr), fall back to stdin pipe. This shared contract between smoke (task 1) and spawner avoids redundant discovery. Add unit tests for the fallback decision logic (mock stderr patterns, no actual pi spawn needed). Parse JSONL stdout tolerantly: accept multiple event type variants (message_end, assistant_message_end), ignore unknown event types. **Normalize usage data**: extract token counts supporting both snake_case (input_tokens) and camelCase (inputTokens) variants, map to canonical Usage type. Extract final assistant message content as the specialist's report. Use AbortController with AbortSignal.any() combining user cancellation and per-agent timeout. Return SpecialistRuntime with runId and pid for tracking. Add fixture-based tests with representative JSONL events.
- prompt-composer.ts: builds specialist system prompt from: agent definition body + repo-root CLAUDE.md content (best-effort: if missing, skip) + repo-root AGENTS.md content (best-effort: if missing, skip; only repo-root, no nested AGENTS.md walking) + task brief + scratchpad instructions with absolute path to main repo's .pi/scratchpads/<agent-name>.md. Uses vendored JSONL fixture from task 1 for parser testing.
- **Scratchpad routing**: dispatcher includes a small routing abstraction that chooses between `centralAbsolutePath` (main repo's `.pi/scratchpads/`) and `worktreeLocalPath` (worktree's own `.pi/scratchpads/`) based on `canWriteToRepoScratchpadFromSiblingCwd` from smoke-results.json. If cross-dir writes are allowed (default/expected), scratchpads are centralized. If not, dispatcher copies scratchpad content into the worktree before spawn and copies it back after completion. Steer handler (task 10) writes to both locations when local mode is active.
- consolidator.ts: collects reports (from JSONL assistant message content) from all specialists, passes to dispatcher for unified summary.
- dispatcher.ts: orchestrates full execution loop — record base commit SHA, for each wave: acquire worktrees, spawn specialists in parallel (p-limit for maxConcurrency), store SpecialistRuntime entries in FleetState, wait for completion, handle failures (new subprocess in worktree, non-blocking), advance to next wave. Emit events with runId for each specialist.

## Key context

- Official subagent example at badlogic/pi-mono/packages/coding-agent/examples/extensions/subagent/ — follow its event parsing exactly, then extend with tolerant variant handling
- Subagent spawning uses `spawn("pi", [...])` from child_process — NOT pi.exec(). pi.exec() is for running CLI tools (git, etc.). This distinction was validated in task 1's SDK surface check.
- SpecialistRuntime.runId + pid are the canonical identifiers for routing steer messages and displaying status. Persisted in FleetEvent so resume can rebuild the mapping.
- Usage normalization: pi's JSON mode may use different field names across versions. Support both naming conventions, map to one canonical type.
- Scratchpad absolute path: main repo's .pi/scratchpads/<agent-name>.md (NOT in worktree)
- Base commit SHA recorded at session start for merge drift detection

## Acceptance
- [ ] Normalized Usage type with canonical field names, supporting snake_case and camelCase extraction
- [ ] SpecialistRecord type (JSON-safe, persistable) with runId, pid, agentName, worktreePath, model, status, hostRoutableId (optional)
- [ ] SpecialistRuntime type (in-memory only, extends SpecialistRecord) with abortController, process handle
- [ ] FleetEvent payloads use SpecialistRecord only (no AbortController serialization)
- [ ] Kahn's algorithm produces correct execution waves; cycle detection fails fast
- [ ] Specialists spawned via spawn("pi", ["--mode", "json", ...]) — NOT pi.exec()
- [ ] Spawner implements dual-mode prompt delivery (trailing arg first, stdin pipe fallback) with unit tests for decision logic
- [ ] Tolerant JSONL parsing: accepts event type variants, ignores unknowns
- [ ] Specialist report extracted as "last assistant message content in the stream" (deterministic rule)
- [ ] Parser handles: multiple assistant messages (take last), tool-use messages (skip), partial lines (buffer)
- [ ] SpecialistRuntime stored in FleetState with runId/pid for steer routing and status display
- [ ] Prompt composer injects agent definition + repo-root CLAUDE.md (best-effort) + repo-root AGENTS.md (best-effort, only repo-root) + task brief + scratchpad absolute path
- [ ] p-limit enforces maxConcurrency from teams.yaml
- [ ] AbortController with per-agent timeout kills stuck specialists
- [ ] Base commit SHA recorded at session start
- [ ] Failed specialist → dispatcher takeover (non-blocking)
- [ ] Fixture-based tests with representative JSONL events verifying parsing and Usage normalization
- [ ] Spawner reads `preferredPromptMode` from smoke-results.json; falls back to dual-mode discovery if absent
- [ ] Task assignments include `expectedPaths: string[]` for conservative wave sequencing; empty → sequential
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
