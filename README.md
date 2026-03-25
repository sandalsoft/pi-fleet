# pi-fleet

Multi-agent terminal orchestration extension for [pi](https://github.com/badlogic/pi-mono) coding agent.

Define teams of specialist agents in YAML, run a structured interview to scope the work, and let pi-fleet dispatch agents in parallel -- each isolated in its own git worktree -- then merge results automatically. Also supports deterministic sequential pipelines via `.pi/agent-chain.yaml`.

## Install

```bash
# From npm (once published)
pi install npm:pi-fleet

# From git
pi install git:github.com/sandalsoft/pi-fleet

# From a local clone
pi install /path/to/pi-fleet
```

Requires Node.js >= 20 and pi >= 0.60.0.

## Quick Start

```bash
# 1. Install the extension
pi install .

# 2. In any git repo, run fleet
/fleet
```

If no `.pi/teams.yaml` exists, the interactive setup wizard walks you through picking agent templates and configuring constraints. Once config is in place, `/fleet` interviews you about the task, selects agents, builds a dependency graph, and dispatches work.

## Commands

| Command | Description |
|---------|-------------|
| `/fleet` | Start a multi-agent fleet session. Interviews you, selects agents, dispatches work, merges results. |
| `/fleet --resume` | Resume a previously interrupted session by replaying persisted events. |
| `/fleet --allow-dirty` | Skip the dirty working tree confirmation prompt. |
| `/fleet-status` | Display current session status (agents, progress, costs) via a text widget. |
| `/fleet-steer <agent> <message>` | Send a steering message to a running agent. Use `all` to broadcast. |
| `/fleet-log` | Show scrollable in-memory activity log overlay for the current session. |
| `/fleet-logs [agent] [--raw]` | Browse persistent agent log files from disk. No args lists sessions; with agent name shows meta/activity/stderr. |
| `/fleet-errors` | Show error details and log file paths for failed agents. |
| `/fleet-config` | Configure fleet settings (team, agents, constraints, chain). |

## Configuration

All fleet configuration lives under `.pi/` in your repository root.

### `.pi/teams.yaml`

Defines your team composition and resource constraints. Uses a single team object (multi-team support is deferred).

```yaml
team_id: default
orchestrator:
  model: claude-sonnet-4-20250514
  skills:
    - planning
    - delegation
members:
  - architect
  - developer
  - reviewer
  - researcher
  - qa
  - devops
constraints:
  max_usd: 10
  max_minutes: 30
  task_timeout_ms: 120000   # optional, defaults to 120000
  max_concurrency: 4
```

**Schema enforcement**: `teams.yaml` uses strict validation. Unknown keys are rejected with a clear error message telling you which key to remove. YAML uses `snake_case`; these are transformed to `camelCase` in TypeScript at load time.

The `members` array references agent filename stems (see below).

### `.pi/agents/*.md`

Each agent is a markdown file with YAML front matter. The filename stem (e.g., `developer` from `developer.md`) is the agent's stable identifier used in `members`, events, and `/fleet-steer` routing.

**Required front matter**: `name` (display name), `model`.
**Optional front matter**: `skills` (string array), `expertise` (string), `thinking` (string).
Extra keys are allowed (passthrough validation for forward compatibility).

```markdown
---
name: Developer
model: claude-sonnet-4-20250514
expertise: Full-stack implementation, testing, code quality
skills:
  - coding
  - testing
  - debugging
thinking: medium
---

You are a senior software developer responsible for implementing features
and writing tests.

## Focus Areas

- Implement the assigned task following existing code patterns
- Write unit tests alongside implementation code
- Handle edge cases and error paths explicitly

## Scratchpad

Maintain your working notes at `.pi/scratchpads/developer.md`.
```

### `.pi/agent-chain.yaml`

Defines a sequential pipeline where each agent's output becomes the next agent's `$INPUT`. When this file exists, `/fleet` auto-detects chain mode and runs the pipeline instead of the interview/dispatch flow.

```yaml
name: research-build-review
steps:
  - agent: researcher
    prompt: "Analyze the codebase for $INPUT. Identify relevant files, patterns, and dependencies."
  - agent: architect
    prompt: "Based on the research findings, design a solution for $INPUT."
  - agent: developer
    prompt: "Implement the design from the architect. Write tests for all new code."
  - agent: reviewer
    prompt: "Review all changes. Check correctness, security, and test coverage."
```

Each `agent` value must match a filename stem in `.pi/agents/`. The `$INPUT` variable in prompts is substituted with the previous step's output (or the user's initial input for the first step).

## Agent Templates

The interactive setup wizard (`/fleet` with no existing config) offers six pre-built agent templates:

| Template | Role |
|----------|------|
| Architect | System design, API contracts, dependency analysis |
| Developer | Implementation, testing, code quality |
| Reviewer | Code review, security analysis, test coverage |
| Researcher | Codebase analysis, pattern identification |
| QA | Test planning, edge case discovery, regression testing |
| DevOps | CI/CD, deployment, infrastructure |

Select the ones relevant to your task. The wizard creates `.pi/teams.yaml` and copies agent definitions to `.pi/agents/`.

## Architecture

```
+-----------------------------------------------+
|  pi coding agent (ExtensionAPI)                |
|  +-------------------------------------------+|
|  |  pi-fleet extension                       ||
|  |  +----------+  +-----------+  +---------+ ||
|  |  | Preflight|  | Interview |  | Config  | ||
|  |  | (git     |  | Engine    |  | Loader  | ||
|  |  |  checks) |  | (8-12 Qs)|  | (Zod)   | ||
|  |  +----+-----+  +-----+-----+  +----+----+ ||
|  |       |              |              |      ||
|  |  +----+--------------+--------------+----+ ||
|  |  |         Dispatcher / DAG Executor     | ||
|  |  |  (Kahn's algorithm, wave execution)   | ||
|  |  +--+--------+--------+--------+--------+ ||
|  |     |        |        |        |           ||
|  |  +--+--+  +--+--+  +--+--+  +------+      ||
|  |  |Spec |  |Spec |  |Spec |  |Chain |      ||
|  |  |  A  |  |  B  |  |  N  |  |Runner|      ||
|  |  |(wt) |  |(wt) |  |(wt) |  |      |      ||
|  |  +--+--+  +--+--+  +--+--+  +------+      ||
|  |     |        |        |                    ||
|  |  +--+--------+--------+--+                 ||
|  |  |    Merge Engine       |                 ||
|  |  | (3-way + node-diff3)  |                 ||
|  |  +-----------------------+                 ||
|  |                                            ||
|  |  Crosscutting:                             ||
|  |  - Session Events (event sourcing, JSONL)  ||
|  |  - Resource Monitor (cost, time, budgets)  ||
|  |  - Worktree Pool (sibling dirs)            ||
|  |  - Steering (scratchpad-based)             ||
|  +-------------------------------------------+||
+-----------------------------------------------+
```

### Key Patterns

- **Event sourcing** -- All session state changes are persisted as typed events via `pi.appendEntry()`. Sessions can be resumed by replaying the event log.
- **Worktree pool** -- Each specialist runs in its own git worktree, created as a sibling directory outside the repo (never nested inside).
- **DAG execution** -- Kahn's algorithm produces execution waves. Tasks within a wave run in parallel; waves execute sequentially. `expectedPaths` on task assignments conservatively sequences tasks with overlapping file paths.
- **Three-way merge** -- After specialists complete, their worktree branches merge into an integration branch using `git merge --no-commit` + `node-diff3` for text conflicts + dispatcher resolution for semantic conflicts.

### Data Flow: Dispatch Mode

```
User -> /fleet -> Preflight -> Interview (8-12 questions)
  -> Team Selection -> Task Graph (DAG)
  -> Wave Execution (parallel specialists in worktrees)
  -> Consolidation -> Merge Engine -> Fast-Forward Main
```

### Data Flow: Chain Mode

```
User Input -> $INPUT -> Agent Step 1
  -> output becomes $INPUT -> Agent Step 2
  -> output becomes $INPUT -> Agent Step N
  -> Final Output
```

## Scratchpads

Specialist agents maintain working notes at `.pi/scratchpads/<agent-name>.md` in the main repository. The absolute path is passed to worktree agents so they can write back to a shared location.

### `.pi/scratchpads/` and `.gitignore`

Scratchpad files are in `.gitignore` because they are session-local working memory, not source code. They contain transient agent output (thinking notes, intermediate findings, progress tracking) that changes every run and would pollute commit history.

If your team wants to share scratchpad templates or review agent working notes after a session, copy the relevant files to a tracked location manually. Removing the `.gitignore` entry would cause every fleet run to dirty the working tree with agent output files.

### Steering via Scratchpads

`/fleet-steer` appends messages to the target agent's scratchpad in a standardized format:

```
---

[STEER 2026-03-23T14:30:00.000Z from=user]
Your steering message here.
```

Agents read their scratchpad cooperatively between tool calls. Delivery is best-effort -- the agent may finish before reading. Agent names are validated against the running roster; path separators (`/`, `\`, `..`) are rejected to prevent traversal.

## Session Persistence and Resume

Fleet sessions are persisted as typed JSONL events via `pi.appendEntry()`. Each event carries a `schemaVersion`, `type`, and `timestamp`. Unknown event types are preserved but skipped by state reducers (forward compatibility).

Resume a session with `/fleet --resume`. The extension replays events from the session log to reconstruct state, then continues execution from where it left off.

## Resource Tracking

The resource monitor tracks per-agent cost from JSONL `msg.usage` output, with model-specific pricing. Budget enforcement uses soft warnings at 80% and hard limits that trigger a 60-second graceful shutdown (SIGTERM with grace period, then SIGKILL). A bounded 30-second merge safe window prevents deadlock during budget-triggered shutdown.

## Pre-flight Checks

Before dispatching, `/fleet` runs validation:

- **Git repository** -- Hard fail if not in a git repo.
- **Shallow clone** -- Hard fail if the repo is a shallow clone (worktrees need full history).
- **Dirty working tree** -- Soft block: warns and requires confirmation, or pass `--allow-dirty` to skip.
- **Repo root resolution** -- All `.pi/` paths are derived from `git rev-parse --show-toplevel`, never `process.cwd()`.

## Worktree Directories

Worktrees are created as sibling directories outside the repository (e.g., `../<project>-fleet-worktrees/`). This avoids git's rejection of nested worktrees and keeps the repo clean. Since these directories live outside the repository, they are not under `.gitignore` control. Periodic manual cleanup is recommended -- look for `*-fleet-worktrees` directories next to your repo after extended use.

If sibling directory creation fails at runtime, the worktree manager falls back to `os.tmpdir()`.

## AGENTS.md Injection

For v1, pi-fleet injects only the repo-root `AGENTS.md` file (if present) into agent system prompts. Nested `AGENTS.md` files in subdirectories are not walked. This keeps prompt composition deterministic and testable.

## Dependency Bundling

pi-fleet uses esbuild to bundle all runtime dependencies (`zod`, `yaml`, `p-limit`, `node-diff3`, `@sinclair/typebox`) into a single `dist/extension.js`. This means the built artifact is self-contained. If pi's host process also provides some of these packages (e.g., `@sinclair/typebox`), there will be duplication at runtime. This is an accepted tradeoff for reliable, predictable loading regardless of the host environment.

The pi SDK packages (`@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`) are externalized -- they are provided by the pi runtime.

## Implemented v1 Scope

This extension implements a narrowed v1 scope from the broader product vision described in `PRD.md`. Key decisions:

| PRD Feature | v1 Decision |
|---|---|
| TUI Dashboard (Textual/Bubble Tea) | Pi UI primitives only (`setWidget`, `setStatus`) |
| `dispatch_agent` tool | Default extension behavior via `/fleet` command |
| Safety/Damage Control engine | Delegate to pi's built-in permission system |
| OpenTelemetry metrics | Pi event hooks for cost tracking |
| Cross-provider fallback | Delegate to pi's native provider handling |
| Brief markdown input file | Interactive interview; `--brief <file>` deferred |

See `PRD.md` for the broader vision and rationale behind each narrowing decision.

## Integration Testing

### Automated Tests

```bash
npm test          # 383 vitest tests
```

### Smoke Test

```bash
npm run smoke     # requires pi on PATH, may need interactive approvals
```

The smoke script (`scripts/smoke.ts`) validates pi CLI flags, JSONL event shapes, scratchpad write access from a sibling worktree, and ESM artifact loading. Results are written to `.pi/smoke-results.json` (gitignored, machine-specific).

### In-Extension Spawn Validation

The smoke script runs in a developer terminal, which may differ from the environment inside pi's extension sandbox (different `PATH`, sandbox restrictions, permission model). After building, validate the core spawn path works inside the actual extension runtime:

```bash
npm run build
pi install .
/fleet              # with a minimal teams.yaml config
```

This manually verifies that `child_process.spawn("pi", ...)` works from within the extension sandbox. If pi's sandbox restricts `child_process.spawn`, the extension will fail at runtime with a clear error from the spawner, not silently. This risk is accepted and documented.

## Known Limitations

- Single team per `teams.yaml` (multi-team deferred).
- No composed chain+dispatcher mode (deferred).
- `sendMessage` steering only available if smoke test discovers a host-assigned routable ID (scratchpad steering is the primary mechanism).
- Steering delivery is best-effort -- agents may finish before reading.
- Only repo-root `AGENTS.md` is injected (nested files ignored in v1).
- No cross-provider fallback (delegated to pi).

## Development

```bash
npm install
npm run build       # esbuild -> dist/extension.js
npm run dev         # esbuild watch mode
npm test            # vitest (383 tests)
npm run typecheck   # tsc --noEmit
npm run smoke       # manual pi integration smoke test
```

## License

MIT
