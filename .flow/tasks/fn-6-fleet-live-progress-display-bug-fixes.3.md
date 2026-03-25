## Description

Harden rendering in both `fleet-progress-component.ts` AND `formatter.ts` to fix fragile string truncation, narrow terminal handling, and code duplication. Update documentation.

**Size:** M
**Files:** `src/status/fleet-progress-component.ts`, `src/status/formatter.ts`, `CLAUDE.md`, `README.md`, `test/status/fleet-progress-component.test.ts`, `test/status/formatter.test.ts`

## Approach

### 1. Fix width authority

Current code: `const w = Math.max(40, width)` at component L127, then truncates to `w`. If TUI passes `width < 40`, emitted lines exceed actual terminal width and pi-tui throws.

Fix: use `width` for all `truncateToWidth()` output calls. Use `layoutWidth = Math.max(40, width)` for internal column positioning only.

### 2. Replace `slice()` with `truncateToWidth()` in BOTH renderers

**fleet-progress-component.ts** (4 locations):
- L214: agent name → `truncateToWidth(agent.name, 14, '\u2026')`
- L239: error text → `truncateToWidth(firstLine, 70, '\u2026')`
- L246: log path → `truncateToWidth(label, 70, '\u2026')`
- L262: activity text → `truncateToWidth(entry.text, 70, '\u2026')`

**formatter.ts** (4 locations):
- L110: agent name → same pattern
- L121: error text → same pattern
- L125: log path → same pattern
- L195: activity text → same pattern
<!-- Updated by plan-sync: fn-6-fleet-live-progress-display-bug-fixes.2 added ~30 lines (formatAgentElapsed, elapsedMs helpers) shifting formatter.ts line numbers -->

Note: `formatter.ts` uses plain strings (no ANSI), so `slice()` is technically safe there today. But applying consistent `truncateToWidth()` ensures the codebase stays safe if formatter output is ever piped through theme wrapping.

**Ellipsis rule**: Inner field truncation: `'\u2026'`. Every line-level safety truncation: `truncateToWidth(line, width, '')` — hard clamp, no extra dots. Apply consistently in both component and formatter.

### 3. Dynamic progress bar widths

Replace magic constant with measured widths using `visibleWidth()`. For side-by-side, measure both label+stats segments. If minimum bars (8 chars each) don't fit, switch to stacked.

### 4. Dynamic height budget

`overheadLines` depends on state:
- No `state.constraints`: 2 (header + summary)
- Side-by-side bars: 3 (+ 1 bar line)
- Stacked bars: 4 (+ 2 bar lines)

### 5. Consolidate helpers

Move `formatElapsed()` and `collectAgentRows()` to formatter.ts as single source.

### 6. Test theme mock for width tests

Current `mockTheme()` emits bracket markers (`[fg:color]text[/fg]`) which `visibleWidth()` counts as visible characters. For width/layout tests, use an identity theme mock (`fg: (_, text) => text`) so `visibleWidth()` produces correct layout decisions. Keep color-marker tests separate for verifying color mapping.

### 7. Documentation

CLAUDE.md: Update status/ module description, add live widget refresh pattern.
README.md: Expand resource tracking section.

## Acceptance

- [ ] `width` parameter is authoritative for output truncation in component
- [ ] No `String.slice()` for truncation in fleet-progress-component.ts — all `truncateToWidth()`
- [ ] No `String.slice()` for truncation in formatter.ts — all `truncateToWidth()` (L80, L90, L94, L160)
- [ ] Inner truncation: `'\u2026'`; outer line-level: `''` — in both renderers
- [ ] Progress bar widths from `visibleWidth()` measurement, not magic constant
- [ ] Stacked layout for narrow terminals; `overheadLines` = 2/3/4 based on constraints + layout
- [ ] Width/layout tests use identity theme mock for accurate `visibleWidth()` results
- [ ] Color-mapping tests use bracket-marker theme mock (existing pattern)
- [ ] `formatElapsed()` and `collectAgentRows()` consolidated in formatter.ts
- [ ] CLAUDE.md and README updated
- [ ] Tests cover: narrow width (w=40), wide (w=120), width < 40, long agent names/activities
- [ ] All existing tests pass
- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds

## Done summary
- Task completed
## Evidence
- Commits:
- Tests:
- PRs: