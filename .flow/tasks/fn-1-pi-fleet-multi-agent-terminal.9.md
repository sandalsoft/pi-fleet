# fn-1-pi-fleet-multi-agent-terminal.9 Agent-chain pipeline runner

## Description
Implement the agent-chain pipeline runner for deterministic sequential execution with $INPUT variable substitution between steps.

**Size:** M
**Files:** src/chain/runner.ts, src/chain/variable.ts, src/chain/detector.ts, test/chain/runner.test.ts, test/chain/variable.test.ts, test/chain/detector.test.ts
## Approach

- detector.ts: check for `.pi/agent-chain.yaml` (canonical path under .pi/) existence. If found and /fleet is invoked, offer chain mode as an option during the interview (ctx.ui.select with "Dispatcher mode" and "Chain mode" options). Parse chain config using the Zod schema from task 1.
- runner.ts: execute chain steps sequentially. For each step: resolve the agent definition from .pi/agents/, compose prompt with $INPUT substituted (via variable.ts), spawn pi subprocess in a worktree (reuse worktree between steps since they're sequential), capture output from JSONL assistant message content as the next step's $INPUT. Emit specialist_started/completed events per step. Respect the same budget/time limits as dispatcher mode.
- variable.ts: $INPUT substitution in prompt strings. Handle edge cases: $INPUT appears multiple times (substitute all occurrences), $INPUT in multi-line context, first step has no $INPUT (it's the user's original task description), output from previous step exceeds reasonable size (truncate with warning at configurable limit, default 50k tokens).
- Chain steps can specify model overrides and tool restrictions per step
- If a chain step fails, abort the chain and report which step failed with context

## Key context

- Canonical chain config path: `.pi/agent-chain.yaml` (NOT root-level agent-chain.yaml) — all fleet config under .pi/
- agent-chain.yaml schema: name, description, steps[] where each step has: agent (name), task (prompt with $INPUT), model (optional override), tools (optional restriction)
- Chain mode reuses a single worktree (sequential, not parallel) — simpler than dispatcher mode
- Chain detection happens during the interview phase — integrate with interviewer.ts from task 4
- The chain runner shares the spawner from task 6 for subprocess management
- Report extraction from JSONL follows the same tolerant parsing as task 6

## Acceptance
- [ ] agent-chain.yaml auto-detected and offered as option during interview
- [ ] Chain steps execute sequentially with correct agent/model/tools per step
- [ ] $INPUT substitution works: first step gets user task, subsequent steps get prior output
- [ ] Output size limits with truncation and warning for oversized step outputs
- [ ] Chain abort on step failure with clear error reporting
- [ ] Budget/time limits respected (same enforcement as dispatcher mode)
- [ ] Events emitted per chain step (specialist_started, specialist_completed/failed)
- [ ] Tests verify $INPUT substitution, sequential execution, and failure handling
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
