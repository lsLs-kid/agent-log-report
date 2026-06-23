# Task 3 Report: Watermark Module

## Summary

Successfully implemented the `WatermarkStore` class and smoke test script as specified.

## Files Created

1. **`log-sync/src/watermark.ts`**
   - `WatermarkEntry` interface with `path`, `lastOffset`, `lastRowId`, and `lastSyncAt` fields.
   - `WatermarkStore` class with methods:
     - `load()` — reads JSON file into internal `Map`, or clears map if file absent.
     - `save()` — ensures parent directory exists, then writes `Map` contents as formatted JSON.
     - `get(cursor)` — returns entry for `sourcePath` or a default zero-value entry.
     - `set(cursor, position)` — stores position into `lastOffset` (jsonl) or `lastRowId` (sqlite-table) with current ISO timestamp.
     - `resetIfNeeded(cursor, currentSize)` — deletes entry if stored position exceeds current size; returns `true` if reset occurred.
     - `defaultPath` getter and `ensureDir` static helper.

2. **`log-sync/scripts/test-watermark.ts`**
   - Manual smoke test exercising load/get/set/save/reload/resetIfNeeded cycle.

## Verification Results

### Smoke Test
```
initial: { path: '/tmp/test.jsonl', lastOffset: 0, lastSyncAt: '1970-01-01T00:00:00.000Z' }
reloaded: { path: '/tmp/test.jsonl', lastOffset: 123, lastSyncAt: '2026-06-23T14:46:53.562Z' }
reset triggered: true
after reset: { path: '/tmp/test.jsonl', lastOffset: 0, lastSyncAt: '1970-01-01T00:00:00.000Z' }
```
Output matches expected behavior (reloaded timestamp is dynamic, reset correctly triggers).

### TypeScript Compilation
```
npx tsc --noEmit
```
Completed with no errors.

## Notes

- The `defaultPath` getter is an instance property, not static, matching the brief exactly.
- The `SourceCursor` type is imported from `./types.js` which already defines the interface in the project.
- No git commits were made per constraints.
