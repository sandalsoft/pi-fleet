# pi-fleet

Multi-agent terminal orchestration extension for pi coding agent.

## Build and Test

```bash
npm run build       # tsx esbuild.config.ts -> dist/extension.js
npm run dev         # esbuild watch mode (--watch)
npm test            # vitest run
npm run typecheck   # tsc --noEmit (main tsconfig)
npm run typecheck:tier2  # tier 2 SDK surface check (non-gating)
npm run smoke       # manual integration test (requires pi on PATH)
```

Run tests before committing. The test suite must pass.

## Tech Stack

- **TypeScript** with ESM (`"type": "module"` in package.json)
- **Zod** for config validation (`teams.yaml` strict, agent front matter passthrough)
- **TypeBox** (`@sinclair/typebox`) for pi `registerTool` parameter schemas
- **Vitest** for tests
- **esbuild** for bundling (config in `esbuild.config.ts`, executed via `tsx`)
- Pi SDK externalized at bundle time (`@mariozechner/*`)

## Module Structure

```
src/
  extension.ts          # Entrypoint: registers /fleet, /fleet-status, /fleet-steer
  preflight.ts          # preflightBootstrap() + preflightRunChecks()
  config/               # Zod schemas, YAML loaders for teams/agents/chains
  setup/                # Interactive wizard + template scaffolder
  interview/            # 8-12 question engine + team selector
  session/              # Event schema, state reducer, resume, runtime store
  dispatch/             # DAG executor, spawner, prompt composer, consolidator
  worktree/             # Worktree pool, manager, cleanup
  merge/                # Three-way merge engine, integration branch, conflict resolver
  chain/                # Agent-chain detector, variable substitution, runner
  resources/            # Cost tracker, budget/time limits, graceful shutdown
  steer/                # Scratchpad-based steering handler
  status/               # Status display formatter + widget handler
```

## Test Convention

Test files live in `test/` mirroring the `src/` directory structure:

```
src/config/schema.ts  ->  test/config/schema.test.ts
src/merge/merger.ts   ->  test/merge/merger.test.ts
```

Entrypoint wiring files (`src/extension.ts`) are exempt -- their behavior is covered by the modules they delegate to.

Integration tests that need git (worktree, merge) create isolated tmpdir repos.

## Key Patterns

- **Event sourcing**: Session state persisted via `pi.appendEntry()` as typed JSONL events. State reconstructed by reducing the event log.
- **Worktree pool**: Specialists run in sibling worktrees outside the repo. Falls back to `os.tmpdir()`.
- **DAG execution**: Kahn's algorithm for wave-parallel scheduling. `p-limit` for concurrency.
- **Snake-to-camel**: `teams.yaml` uses `snake_case`; Zod `.transform()` produces `camelCase` TS types.
- **Agent identity**: Filename stem = stable ID. `members[]` uses stems. Events persist `agentName` as stem.
- **Scratchpad steering**: `/fleet-steer` appends to `.pi/scratchpads/<agent>.md`. Agent names validated against roster. Path traversal rejected.
- **Repo root**: Always resolved via `git rev-parse --show-toplevel`, never `process.cwd()`. Threaded to all modules.

## Config Paths

All configuration under `.pi/` relative to repo root:

- `.pi/teams.yaml` -- team definition (strict schema, unknown keys rejected)
- `.pi/agents/*.md` -- agent definitions (passthrough front matter)
- `.pi/agent-chain.yaml` -- sequential pipeline definition
- `.pi/scratchpads/` -- agent working memory (gitignored)
- `.pi/smoke-results.json` -- smoke test output (gitignored)

## Dependencies

**Runtime** (bundled by esbuild): `zod`, `yaml`, `p-limit`, `node-diff3`, `@sinclair/typebox`

**Peer** (provided by pi host): `@mariozechner/pi-agent-core`, `@mariozechner/pi-coding-agent`

**node-diff3 import**: CJS module, use `import { diff3Merge } from 'node-diff3'` then `diff3Merge(theirs, base, ours)`. Requires `esModuleInterop: true` in tsconfig.
