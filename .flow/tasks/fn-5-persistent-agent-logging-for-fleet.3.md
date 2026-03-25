## Description
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
## Approach

### /fleet-logs
- repoRoot: `getFleetState()?.repoRoot` or `preflightBootstrap({ pi })`
- Status derivation: "active" iff `getLogDir()` basename matches session dir AND `getFleetState()?.phase !== 'complete'`. Otherwise stale `running` → "interrupted".
- No args: list sessions. With agent: meta + tailLines + extractActivity + stderr + path. --raw: raw JSONL.

### /fleet-errors
- Read `logPath` from errors Map entries (populated by dispatcher in task 2). Display alongside diagnosis.
- Also construct path from `getLogDir()` as fallback if `logPath` not in Map entry.

### Widget
- Failed agent log path inline on header row, compact format: `log: .pi/logs/<sid>/<agent>.jsonl`, truncated to ~70 cols
- Same format in `formatStatusTable` string fallback

### Docs
Same as before.

## Acceptance

- [ ] Status derivation uses `getLogDir()` basename match + fleet state
- [ ] `/fleet-errors` reads logPath from errors (primary) or getLogDir (fallback)
- [ ] Widget format: `log: .pi/logs/...` truncated to ~70 cols
- [ ] Same format in formatStatusTable
- [ ] All other acceptance per prior versions
- [ ] Tests pass, typecheck passes, build succeeds
