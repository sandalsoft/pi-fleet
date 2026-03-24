# fn-1-pi-fleet-multi-agent-terminal.7 Resource monitor with cost and time tracking

## Description
Implement cost tracking from subprocess JSON output, budget/time enforcement with soft warnings and hard limits, and graceful shutdown with bounded merge safe window.

**Size:** M
**Files:** src/resources/tracker.ts, src/resources/pricing.ts, src/resources/limits.ts, src/resources/timer.ts, src/resources/shutdown.ts, test/resources/tracker.test.ts, test/resources/pricing.test.ts, test/resources/limits.test.ts, test/resources/shutdown.test.ts
## Approach

- tracker.ts: receives usage data from spawner (input_tokens, output_tokens, cache_read, cache_write, cost) per agent per message. Accumulates per-agent and total costs. Emits cost_update events to session log.
- pricing.ts: model pricing lookup. For v1, use `msg.usage.cost` when present (preferred), plus a static hardcoded pricing table for known models (Opus, Sonnet, Haiku with current pricing) as fallback when cost is not included in usage data. **Model ID normalization**: model strings from pi may be provider-qualified (e.g., `anthropic:claude-sonnet-4-20250514`, `claude-opus-4-20250514`) or short names (`opus`, `sonnet`). Use a contains-based matching strategy: if model ID contains "opus" → opus pricing, "sonnet" → sonnet pricing, "haiku" → haiku pricing. When model is unrecognized and `msg.usage.cost` is absent: log a warning with the unknown model ID, attribute $0.00 cost for that message (don't crash), and emit a `budget_warning` event noting cost tracking may be inaccurate. No network fetching — deferred to a future version.
- limits.ts: monitors accumulated cost against max_usd and elapsed time against max_minutes from teams.yaml constraints. At 80% threshold: emit budget_warning/time_warning events, write wrap-up instructions to scratchpad files (absolute paths to main repo's .pi/scratchpads/), notify dispatcher to coordinate wrap-up. At 100%: trigger graceful shutdown.
- timer.ts: tracks session start time, elapsed minutes, per-agent durations. Provides time remaining calculations.
- shutdown.ts: two-phase graceful shutdown. Phase 1: send SIGTERM to all child processes, write "wrap up immediately" to scratchpads, wait up to 60 seconds. Phase 2: SIGKILL remaining processes. **Bounded merge safe window**: if merge is in progress during shutdown, allow up to 30 seconds for current merge to complete, then stop further merges and leave integration branch for manual inspection. Flush event log (emit session_aborted event). Clean up worktrees. Use process.once() for signal handlers to prevent double-fire on rapid Ctrl+C.

## Key context

- msg.usage from --mode json output contains token counts and sometimes cost — extracted by spawner (task 6) and streamed to tracker
- Budget enforcement must respect merge safe window — aborting mid-merge corrupts branch state. Bounded 30s window prevents deadlock.
- Scratchpad warnings use absolute paths to main repo's .pi/scratchpads/ (not worktree-relative)
- pi.on("session_shutdown") for cleanup registration

## Acceptance
- [ ] Per-agent cost tracking from msg.usage data (tokens + cost)
- [ ] Hardcoded pricing fallback with model ID normalization (contains-based matching for provider-qualified names)
- [ ] Unknown model with no msg.usage.cost: $0.00 + warning (no crash)
- [ ] Soft warning at 80% of budget/time limits with notification and scratchpad injection
- [ ] Hard limit triggers graceful shutdown at 100%
- [ ] Two-phase shutdown: SIGTERM with 60s grace → SIGKILL
- [ ] Shutdown deferred if merge in progress (prevents corruption)
- [ ] session_aborted event emitted on forced shutdown
- [ ] Worktree cleanup runs during shutdown
- [ ] process.once() prevents double-fire signal handling
- [ ] Tests verify threshold detection, warning emission, and shutdown sequencing
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
