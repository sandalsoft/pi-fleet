## Description
## Done summary
Added /fleet-logs command for browsing persistent agent log sessions (list sessions, view agent meta/activity/stderr, raw JSONL mode). Enhanced /fleet-errors with getLogDir() fallback for log paths, added inline log path display in FleetProgressComponent and formatStatusTable for failed agents, and updated CLAUDE.md documentation.
## Evidence
- Commits: ffa1786a1e1796971c936336f14c6a72545d69ee
- Tests: npm test, npm run typecheck, npm run build
- PRs:
## Approach

### /fleet-logs
- repoRoot: `getFleetState()?.repoRoot` or `preflightBootstrap({ pi })`
- Status derivation: "active" iff `getLogDir()` basename matches session dir AND `getFleetState()?.phase !== 'complete'`. Otherwise stale `running` → "interrupted".
- No args: list sessions. With agent: meta + tailLines + extractActivity + stderr + path. --raw: raw JSONL.

### /fleet-errors
<!-- Updated by plan-sync: fn-5.2 stores logPaths in a separate Map<string, string> via getLogPaths(), not on the errors Map entries -->
- Read `logPath` from `getLogPaths().get(agentName)` (populated by dispatcher in task 2 as a separate `logPaths: Map<string, string>` on DispatchResult, persisted via `setLogPaths()`). Display alongside diagnosis.
- Also construct path from `getLogDir()` as fallback if `getLogPaths()` has no entry for the agent.

### Widget
- Failed agent log path inline on header row, compact format: `log: .pi/logs/<sid>/<agent>.jsonl`, truncated to ~70 cols
- Same format in `formatStatusTable` string fallback

### Docs
Same as before.

## Acceptance

- [ ] Status derivation uses `getLogDir()` basename match + fleet state
- [ ] `/fleet-errors` reads logPath from `getLogPaths()` (primary) or getLogDir (fallback)
- [ ] Widget format: `log: .pi/logs/...` truncated to ~70 cols
- [ ] Same format in formatStatusTable
- [ ] All other acceptance per prior versions
- [ ] Tests pass, typecheck passes, build succeeds
