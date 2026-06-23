# log-sync Design Spec

> **Status:** Approved  
> **Scope:** Standalone local log sync tool, lives in `log-sync/` subfolder, not committed to repo.

---

## Goal

Build a TypeScript CLI tool that reads local agent logs (Claude Code, Code Agent 3.x, opencode) and pushes them incrementally to a remote HTTP API or database. First run sends all existing logs; subsequent runs send only new records.

## Architecture

The tool is split into three independent layers:

- **Provider**: reads local logs and produces `LogRecord[]`. Hides JSONL vs SQLite differences.
- **Transport**: sends `LogRecord[]` to a target. Hides HTTP vs DB differences.
- **Watermark**: tracks sync position per source so only new data is sent.

## Tech Stack

- TypeScript 5, Node 20+
- `tsx` for dev execution
- `better-sqlite3` for reading opencode databases
- `pg` for PostgreSQL transport (optional runtime dependency)
- Node built-in `fetch` for HTTP transport

## Directory Layout

```
log-sync/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # CLI entry
│   ├── types.ts              # shared interfaces
│   ├── watermark.ts          # watermark persistence
│   ├── providers/
│   │   ├── jsonl.ts          # claude-code + code-agent-3x
│   │   └── opencode.ts       # opencode SQLite
│   └── transports/
│       ├── http.ts
│       └── db.ts
```

## Data Model

### `LogRecord`

```typescript
interface LogRecord {
  provider: 'claude-code' | 'code-agent-3x' | 'opencode';
  sourcePath: string;
  sessionId: string;
  syncedAt: string; // ISO timestamp

  raw: string; // JSONL line OR serialized SQLite row

  normalized: {
    recordType?: string;
    role?: 'user' | 'assistant' | 'system' | 'tool';
    timestamp?: string;
    model?: string;
    tokenUsage?: {
      input: number;
      output: number;
      cacheCreation?: number;
      cacheRead?: number;
    };
    [key: string]: unknown;
  };
}
```

- `raw` is always the most original data available for that provider.
- `normalized` contains best-effort extracted fields. Missing fields are `undefined`.

## Watermark

File: `~/.config/log-sync/watermark.json` by default, overridable with `--watermark-file`.

```typescript
interface WatermarkEntry {
  path: string;
  lastOffset: number;  // bytes for JSONL
  lastRowId?: number;  // row id for opencode
  lastSyncAt: string;
}
```

- JSONL provider advances byte offset. Incomplete final line (no trailing newline) is not committed.
- opencode provider advances auto-increment `id` per table. Falls back to `rowid` if needed.
- If a source file shrinks below the stored offset, watermark resets to 0 and a full re-sync is triggered.

## Provider Layer

### Interface

```typescript
interface Provider {
  listSources(): Promise<SourceCursor[]>;
  read(cursor: SourceCursor): Promise<{ records: LogRecord[]; nextCursor: SourceCursor }>;
}

interface SourceCursor {
  provider: string;
  sessionId: string;
  sourcePath: string;
  type: 'jsonl' | 'sqlite-table';
  position: number;
}
```

### JsonlProvider

Used by `claude-code` and `code-agent-3x`. Only `root` and `providerId` differ.

```typescript
new JsonlProvider({
  providerId: 'claude-code',     // or 'code-agent-3x'
  root: '~/.claude/projects',    // or '~/.cac/projects'
  subagentGlob: '**/subagents/*.jsonl',
})
```

Sources:
- `${root}/<encoded-cwd>/<sessionId>.jsonl`
- `${root}/<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl`

### OpencodeProvider

```typescript
new OpencodeProvider({
  dbPath: '~/.local/share/opencode/opencode.db',
})
```

If `dbPath` is a directory, append `opencode.db`. If it is a file, use it directly.

Sources: one cursor per table (`session`, `message`, `part`). Each query uses `WHERE id > ? ORDER BY id LIMIT <batchSize>`.

## Transport Layer

### Interface

```typescript
interface Transport {
  send(records: LogRecord[]): Promise<void>;
}
```

### HttpTransport

```typescript
new HttpTransport({
  endpoint: string,
  headers?: Record<string, string>,
  batchSize?: number,  // default 100
  timeoutMs?: number,  // default 10000
})
```

- Sends each batch as one POST with `Content-Type: application/json`.
- Any non-2xx response throws and aborts the sync for that source.

### DbTransport

```typescript
new DbTransport({
  url: 'postgres://...' | 'mysql://...' | 'sqlite://...',
})
```

Auto-creates table:

```sql
CREATE TABLE IF NOT EXISTS log_sync_records (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  source_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL,
  raw JSONB NOT NULL,
  normalized JSONB
);
CREATE INDEX idx_provider_session ON log_sync_records(provider, session_id);
CREATE INDEX idx_synced_at ON log_sync_records(synced_at);
```

Batch inserts in a single transaction.

## CLI

```bash
npx log-sync \
  --provider claude-code|code-agent-3x|opencode \
  --transport http|db \
  --target <url> \
  [--root <path>] \
  [--watermark-file <path>] \
  [--batch-size <number>] \
  [--dry-run] \
  [--verbose]
```

Examples:

```bash
npx log-sync --provider claude-code --transport http --target http://localhost:3000/api/log-sync
npx log-sync --provider opencode --transport db --target postgres://user:pass@localhost/logs
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All sources synced successfully |
| 1 | CLI argument or initialization error |
| 2 | One or more sources failed; failures are printed to stderr |

## Error Handling

| Scenario | Handling |
|----------|----------|
| JSONL parse error | Skip line, warn, do not advance watermark past it |
| Source file shrinks | Reset watermark to 0 for that source |
| opencode DB locked | Wait briefly, then error out |
| HTTP timeout / non-2xx | Throw; do not update that source's watermark |
| DB insert failure | Rollback transaction; do not update watermark |
| New subagent file appears | `listSources()` discovers it; watermark starts at 0 |
| Empty source | Skip with no records |

## Out of Scope

- No hook integration. The caller decides when to invoke the CLI.
- No local retry queue. A failed batch is retried on the next CLI invocation from the same watermark position.
- No encryption, compression, or authentication beyond optional HTTP headers.
