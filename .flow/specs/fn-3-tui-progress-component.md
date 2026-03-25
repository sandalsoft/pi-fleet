# fn-3: TUI Progress Component

## Problem

The fleet status widget uses `setWidget(key, string[])` which renders plain monospace text — no colors, no styling. The reference UI uses pi's TUI component system with colored status labels, styled progress bars, and themed text.

## Approach

Migrate from `string[]` rendering to pi's component factory:

```typescript
setWidget(key, (tui: TUI, theme: Theme) => Component & { dispose?(): void }, options?)
```

The Component interface requires:
- `render(width: number): string[]` — return ANSI-styled lines
- `invalidate()` — clear cached render output
- Optional `dispose()` for cleanup

Theme API provides `theme.fg(color, text)` and `theme.bg(color, text)` with semantic color tokens like `accent`, `success`, `error`, `warning`, `muted`, `dim`, `text`.

Key utility: `truncateToWidth(text, maxWidth)` handles ANSI-aware width calculation.

## Design

### Color mapping (configurable)

```typescript
interface FleetWidgetColors {
  header: ThemeColor        // 'accent'
  statusRunning: ThemeColor // 'accent'
  statusDone: ThemeColor    // 'success'
  statusFailed: ThemeColor  // 'error'
  statusQueued: ThemeColor  // 'dim'
  agentName: ThemeColor     // 'text'
  stats: ThemeColor         // 'muted'
  activity: ThemeColor      // 'dim'
  barFilled: ThemeColor     // 'accent'
  barEmpty: ThemeColor      // 'dim'
  summary: ThemeColor       // 'muted'
}
```

Defaults use theme tokens. Users can override via team config later.

### Target layout (matching reference)

```
  Fleet [Executing]                       $2.14 / $10.00  11.0k tok
  ✓ developer     $1.50  7.0k    ● reviewer     $0.64  4.0k
  ○ architect        -      -    ○ qa              -      -
  developer: reading src/config/schema.ts
  TIME ██████░░░░░░  6m / 30m    COST ██░░░░░░░░░░  $2.14 / $10
  2/4 complete | 6m 10s
```

With colors:
- `✓` in success green, `●` in accent, `✗` in error red, `○` in dim gray
- Agent names in default text, cost/tokens in muted
- Activity lines in dim italic
- Progress bar filled segments in accent, empty in dim
- Summary in muted

## Plan

### Task 1: Create FleetProgressComponent class

**Files:** `src/status/fleet-progress-component.ts` (new), `test/status/fleet-progress-component.test.ts` (new)

Create a class implementing `Component` that:
- Holds references to `Theme`, `TUI` (for requestRender), FleetState, activities map
- Has `update(state, activities?)` method that invalidates cache and calls `tui.requestRender()`
- Renders colored output using `theme.fg()` in `render(width)`
- Caches render output (keyed by width + state hash)
- Accepts a `FleetWidgetColors` config for color overrides

### Task 2: Wire component into display.ts and dispatcher

**Files:** `src/status/display.ts`, `src/dispatch/dispatcher.ts`, `src/extension.ts`

Replace `updateProgressWidget` to use the component factory on first call, then update the component instance on subsequent calls. The factory creates the component; subsequent state changes call `component.update()` + `tui.requestRender()`.

Pattern:
```typescript
let progressComponent: FleetProgressComponent | null = null

function updateProgressWidget(ctx, state, activities?) {
  if (!progressComponent) {
    ctx.ui.setWidget('fleet-progress', (tui, theme) => {
      progressComponent = new FleetProgressComponent(tui, theme)
      progressComponent.update(state, activities)
      return progressComponent
    }, { placement: 'aboveEditor' })
  } else {
    progressComponent.update(state, activities)
  }
}
```

### Task 3: Add configurable color scheme

**Files:** `src/status/fleet-progress-component.ts`, `src/config/schema.ts`

Add optional `widget_colors` section to teams.yaml schema that maps to `FleetWidgetColors`. Falls back to sensible theme-based defaults.

## Task Dependencies

```
Task 1 (component class) → Task 2 (wiring) → Task 3 (config)
```

Sequential — each builds on the previous.

## Acceptance Criteria

- [ ] Status icons render in color (green ✓, blue ●, red ✗, gray ○)
- [ ] Progress bars use colored fill segments
- [ ] Activity text renders in dim/muted color
- [ ] Header uses accent color
- [ ] Widget re-renders on state changes via tui.requestRender()
- [ ] Colors use theme tokens (respect user's pi theme)
- [ ] Color mapping is overridable
- [ ] All existing tests pass, new component tests added
- [ ] Widget fits without truncation
