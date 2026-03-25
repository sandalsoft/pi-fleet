## Description
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
## Approach

- All public methods never-throw. `create()` returns null on failure.
- `create()` stores `_startedAtMs = Date.now()`. `close()` computes `durationMs` and `completedAt` from it.
- `close(opts?: { exitCode?, usage?, status? })` — no `durationMs` parameter.
- `rotateSessionLogs(logsRootDir, keepCount)`: filter dirs via `/^[0-9a-z]+$/i.test(name)` (exact base36 match, not `parseInt` which parses partial strings), then sort numerically, remove oldest beyond keepCount.
- `tailLines(filePath, n)`: single Buffer assembly + decode. `n <= 0 → []`. Handle missing trailing newline (include last partial line). Return `[]` on ENOENT.

## Acceptance

- [ ] `create()` → `AgentLogger | null`, all errors caught
- [ ] `_startedAtMs` stored; `close()` computes duration from it
- [ ] `close(opts?)` no `durationMs` param, opts: `{ exitCode?, usage?, status? }`
- [ ] All methods never-throw
- [ ] `close()` idempotent, awaits flush
- [ ] Name validation: length cap + traversal checks
- [ ] `rotateSessionLogs`: base36 regex filter `/^[0-9a-z]+$/i`, then numeric sort
- [ ] `KEEP_LOG_SESSIONS = 5`
- [ ] `tailLines`: `n <= 0 → []`, no trailing newline → include last line, ENOENT → `[]`, CRLF normalized
- [ ] `.pi/logs/` in `.gitignore`
- [ ] Tests cover all
- [ ] `npm run typecheck` passes
