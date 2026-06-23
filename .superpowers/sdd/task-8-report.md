# Task 8 Report: CLI Entry

## Summary

Implemented the CLI entry point and factory module for the log-sync tool. All verification steps passed.

## Files Created

### 1. `log-sync/src/factory.ts`

Factory module with two functions:

- `createProvider(providerId, root?)`: Maps `claude-code` and `code-agent-3x` to `JsonlProvider`, `opencode` to `OpencodeProvider`. Throws `LogSyncError('UNKNOWN_PROVIDER')` for unknown IDs.
- `createTransport(transportId, target)`: Maps `http` to `HttpTransport`, `db` to `DbTransport`. Throws `LogSyncError('UNKNOWN_TRANSPORT')` for unknown IDs.

### 2. `log-sync/src/index.ts`

Full CLI entry point replacing the Task 1 placeholder. Key behaviors:

- **Argument parsing**: Simple `--key value` parser (flags without values become `true`).
- **Required flags**: `--provider`, `--transport`, `--target` are mandatory; missing any prints error + usage and exits 1.
- **Help**: `--help` prints usage and exits 0.
- **Options**: `--root`, `--watermark-file`, `--batch-size` (default 100), `--dry-run`, `--verbose`.
- **Watermark handling**: Loads store before sync, saves after. Initial cursor position comes from `watermark.get(cursor).lastOffset || lastRowId || 0`.
- **JSONL file shrink detection**: For `jsonl` sources, checks file size; if smaller than stored watermark, resets position to 0 via `watermark.resetIfNeeded()`.
- **SQLite-table position**: Comes from `lastRowId` (set by `watermark.set()` based on cursor type).
- **Per-source error handling**: Each source syncs independently; failures are collected and reported at the end. Exit code 2 if any source failed.
- **Dry-run mode**: Prints `Would send N records from ...` without calling `transport.send()` or updating watermark.

## Verification Results

| Command | Result |
|---------|--------|
| `npx tsx src/index.ts --help` | Prints usage, exits 0 |
| `npx tsx src/index.ts --provider claude-code --transport http --target http://localhost:39999 --dry-run` | Prints "Would send N records from ..." for all discovered sources without network calls |
| `npx tsc --noEmit` | Compiles cleanly, no errors |

## Dry-run Output (excerpt)

The dry-run discovered 108 sources across multiple project directories, printing lines like:

```
Would send 14 records from /Users/shen/.claude/projects/-Users-shen-code-work/...
Would send 401 records from /Users/shen/.claude/projects/-Users-shen-code-work-aaa/...
Would send 2146 records from /Users/shen/.claude/projects/-Users-shen-code-work-ai-coding-dashboard/...
```

No HTTP requests were made (confirmed by `--dry-run`).
