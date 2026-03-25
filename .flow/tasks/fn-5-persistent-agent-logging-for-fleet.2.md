## Description
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
## Approach

### exitCode
- Add to `SpawnResult`, return from `buildSpawnResult()`. Test via mock or export.

### extension.ts (dispatcher mode only)
```
const logsRootDir = path.join(repoRoot, '.pi', 'logs')
let logDir: string | undefined
try {
  logDir = path.join(logsRootDir, sessionId)
  await fs.mkdir(logDir, { recursive: true })
  setLogDir(logDir)
} catch {
  console.warn('[pi-fleet] Log dir creation failed')
  logDir = undefined
  setLogDir(null)
}
if (logDir) {
  try { await rotateSessionLogs(logsRootDir, KEEP_LOG_SESSIONS) } catch { console.warn('[pi-fleet] Rotation failed') }
}
```
Rotation only runs if logDir succeeded. No rotation on failure path.

### Dispatcher
- `logDir?: string` on opts
- `Map<string, AgentLogger>` tracking
- `close({ exitCode: result.exitCode, usage: result.usage, status: cancelSignal?.aborted ? 'aborted' : undefined })` — no `durationMs` (logger computes it)
- logPath: use `SpecialistFailedEvent.logPath` as the authoritative source in `/fleet-errors` (not computed from getLogDir). Store repo-relative: `.pi/logs/${path.basename(logDir!)}/${agentName}.jsonl`
- Finally block: merge with existing `clearInterval(refreshInterval)` in a single `try/finally`. Logger cleanup uses `Promise.allSettled` for concurrent close:
  ```
  finally {
    clearInterval(refreshInterval)
    if (loggers.size > 0) {
      await Promise.allSettled([...loggers.values()].map(l => l.close({ status: 'aborted' })))
    }
  }
  ```

### Event logPath usage
- `logPath` on `SpecialistFailedEvent` is used by `/fleet-errors` in this epic (not deferred). The handler reads `logPath` from the `errors` Map entry or from the event replay. This justifies adding it to the schema.

## Acceptance

- [ ] `SpawnResult.exitCode: number`
- [ ] No `durationMs` in close() calls
- [ ] Rotation gated on logDir success
- [ ] Finally: single block with clearInterval + Promise.allSettled for loggers
- [ ] `logPath` on event used by `/fleet-errors` (not deferred)
- [ ] All other wiring per prior versions
- [ ] `npm run typecheck` passes
