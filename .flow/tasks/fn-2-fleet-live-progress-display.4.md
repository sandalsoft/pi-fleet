# Task fn-2.4: Fix cost and token extraction from pi's streaming output

**Status:** open
**Files:** `src/dispatch/types.ts`, `src/dispatch/spawner.ts`, `test/dispatch/spawner.test.ts`

## Problem

Costs show $0.00 and tokens show `-` throughout execution because the usage extraction pipeline has three bugs:

### Bug 1: Event type mismatch
Pi's JSON mode emits `{ type: "done", message: AssistantMessage }` events at the end of each response. But `parseJsonlStream` only checks for `type === "message_end"` and `type === "result"` — it never handles `"done"` events.

### Bug 2: Field name mismatch
Pi SDK's `Usage` type uses short field names: `{ input, output, cacheRead, cacheWrite, totalTokens }`. But `normalizeUsage` only checks for `inputTokens`/`input_tokens` and `outputTokens`/`output_tokens`. The bare `input`/`output` fields are never matched.

### Bug 3: Cost is an object, not a number
Pi SDK's `Usage.cost` is an object `{ input, output, cacheRead, cacheWrite, total }` (USD breakdowns). But `normalizeUsage` does `cost: num(raw.cost)` where `num()` returns 0 for non-numbers.

## Fix

### In `src/dispatch/types.ts` — `normalizeUsage`:
```typescript
export function normalizeUsage(raw: Record<string, unknown>): Usage {
    return {
        inputTokens: num(raw.inputTokens ?? raw.input_tokens ?? raw.input),
        outputTokens: num(raw.outputTokens ?? raw.output_tokens ?? raw.output),
        cacheReadTokens: num(raw.cacheReadTokens ?? raw.cache_read_input_tokens ?? raw.cache_read_tokens ?? raw.cacheRead),
        cacheWriteTokens: num(raw.cacheWriteTokens ?? raw.cache_creation_input_tokens ?? raw.cache_write_tokens ?? raw.cacheWrite),
        cost: extractCost(raw.cost),
    }
}

function extractCost(v: unknown): number {
    if (typeof v === 'number') return v
    if (v && typeof v === 'object' && 'total' in v) return num((v as Record<string, unknown>).total)
    return 0
}
```

### In `src/dispatch/spawner.ts` — `parseJsonlStream`:
Add `type === 'done'` handler:
```typescript
if (type === 'done') {
    const msg = parsed.message as Record<string, unknown> | undefined
    if (msg) {
        const content = extractTextContent(msg.content)
        if (content) lastAssistantContent = content
    }
    const msgUsage = (msg?.usage ?? parsed.usage) as Record<string, unknown> | undefined
    if (msgUsage) {
        totalUsage = addUsage(totalUsage, normalizeUsage(msgUsage))
    }
}
```

### Tests
- Add test for `normalizeUsage` with pi SDK's short field names (`input`, `output`, `cacheRead`)
- Add test for `normalizeUsage` with cost as object `{ total: 0.42 }`
- Add test for `parseJsonlStream` with `type: "done"` events

## Verification

- After agent completion, cost shows actual dollar amount (not $0.00)
- Token counts show real numbers (not `-`)
- Works with both Anthropic API format (`input_tokens`) and pi SDK format (`input`)
