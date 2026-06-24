# agent-log-report — AI Agent Instructions

## What This Is

A TypeScript library + CLI that incrementally syncs local AI coding agent logs to external targets (Kafka, HTTP endpoint, PostgreSQL, MySQL, SQLite). Designed to be called programmatically on session idle events, or run directly from the terminal for testing.

## Project Structure

```
src/
├── mod.ts              # Public API entry point — import from here
├── sync.ts             # Core sync() function (the main API)
├── index.ts            # CLI entry point — parses args, calls sync()
├── factory.ts          # createProvider() / createTransport() factories
├── types.ts            # All shared TypeScript interfaces
├── watermark.ts        # WatermarkStore — persists sync positions to disk
├── providers/
│   ├── jsonl.ts        # claude-code and code-agent-3x (JSONL files)
│   └── opencode.ts     # opencode (SQLite, session-level assembly)
└── transports/
    ├── kafka.ts        # KafkaTransport (kafkajs, PLAINTEXT, no auth)
    ├── http.ts         # HttpTransport (POST JSON array, Node fetch)
    └── db.ts           # DbTransport (postgres / mysql / sqlite)
```

## Key Abstractions

### Provider interface (`src/types.ts`)
```typescript
interface Provider {
  listSources(): Promise<SourceCursor[]>;
  read(cursor: SourceCursor): Promise<{ records: LogRecord[]; nextCursor: SourceCursor }>;
}
```
Each provider returns `SourceCursor` objects (one per log file or DB table) and reads `LogRecord` batches starting from `cursor.position`.

### Transport interface (`src/types.ts`)
```typescript
interface Transport {
  send(records: LogRecord[]): Promise<void>;
}
```

### LogRecord (`src/types.ts`)
```typescript
interface LogRecord {
  provider: 'claude-code' | 'code-agent-3x' | 'opencode';
  sourcePath: string;
  sessionId: string;
  syncedAt: string;        // ISO timestamp
  raw: string;             // JSON string of original data
  normalized: NormalizedRecord;  // structured extraction
}
```

### WatermarkStore (`src/watermark.ts`)
Persists sync positions to a JSON file (`~/.config/log-sync/watermark.json` by default). Keyed by `sourcePath`. For opencode, auxiliary rowid watermarks are stored in `WatermarkEntry.extra` via `getExtra(cursor, key)` / `setExtra(cursor, key, value)`. The `set()` method preserves existing `extra` fields.

## Provider Details

### jsonl (claude-code, code-agent-3x)
- Reads JSONL files from `~/.claude/projects/**/*.jsonl` (claude-code) or `~/.cac/projects/**/*.jsonl` (code-agent-3x)
- Also discovers subagent files at `**/subagents/*.jsonl`
- `cursor.position` = byte offset; advances only past complete lines with valid JSON
- Handles file shrinkage (log rotation) by resetting watermark to 0
- Each line becomes one `LogRecord`; `normalized` extracts `role`, `timestamp`, `model`, `tokenUsage`

### opencode
- Reads `~/.local/share/opencode/opencode.db` (or path override)
- **Session-level granularity**: one `LogRecord` = one complete session document
- Change detection: queries `message WHERE rowid > last_msg_rowid` and `part WHERE rowid > last_part_rowid` to find sessions with new content
- For each changed session: joins session + all messages + all parts, assembles `OpenCodeSessionDoc`
- Watermarks stored in `WatermarkEntry.extra` as `msg-rowid` and `part-rowid`
- `normalized` is an `OpenCodeSessionDoc` (cast via `as unknown as NormalizedRecord`)

#### OpenCodeSessionDoc shape
```typescript
{
  record_type: 'opencode-session',
  session_id, title, cwd, project_id, version, model,
  is_subagent, parent_session_id,
  started_at, updated_at,          // ISO strings
  cost_total, tokens_total,        // aggregates from session table columns
  message_count,
  messages: [{
    message_id, role, parent_message_id,
    timestamp, completed_at, generation_duration_ms,
    model_id, provider_id, agent, mode,
    cost, tokens, finish_reason,
    text_parts: string[],          // type=text parts
    reasoning_parts: [{ text, duration_ms }],
    tool_calls: [{ tool_name, call_id, status, input, output, is_error }],
    // output truncated to 16384 chars
    has_patch: boolean,            // any type=patch or type=file parts
    step_count: number,            // count of type=step-start parts
  }]
}
```

Message `data` JSON has two model field layouts; both are handled:
- Nested: `data.model.providerID` / `data.model.modelID`
- Flat: `data.providerID` / `data.modelID`

## Transport Details

### kafka
- Uses `kafkajs`, `ssl: false`, `sasl: undefined` (PLAINTEXT, no auth)
- `target` = comma-separated `host:port` list
- Each `LogRecord` → one Kafka message; key = `sessionId`, value = `JSON.stringify(record)`
- Connects and disconnects per `send()` call

### http
- `target` = HTTP(S) URL
- POSTs `LogRecord[]` as JSON array; `Content-Type: application/json`
- Default timeout: 10 000 ms
- Splits into sub-batches of `batchSize` records each

### db
- `target` = connection string: `postgres://...`, `mysql://...`, `sqlite:///path`
- Auto-creates table `log_sync_records` (configurable via `DbTransportOptions.tableName`) on first send
- Schema: `id, provider, source_path, session_id, synced_at, raw (JSONB/JSON/TEXT), normalized (JSONB/JSON/TEXT)`
- Indexes on `(provider, session_id)` and `synced_at`
- Each `send()` is a single transaction; rolls back on error

## Public API (`src/mod.ts`)

```typescript
import { sync } from './src/mod.js';
import type { SyncConfig, SyncResult, LogRecord, OpenCodeSessionDoc } from './src/mod.js';
```

### `sync(config: SyncConfig): Promise<SyncResult>`

```typescript
interface SyncConfig {
  provider: string;        // 'opencode' | 'claude-code' | 'code-agent-3x'
  transport: string;       // 'kafka' | 'http' | 'db'
  target: string;          // broker list / URL / connection string
  topic?: string;          // required for kafka
  root?: string;           // override default log path
  watermarkFile?: string;  // default: ~/.config/log-sync/watermark.json
  batchSize?: number;      // default: 100
}

interface SyncResult {
  totalSent: number;
  errors: { sourcePath: string; error: unknown }[];
}
```

`sync()` is idempotent and safe to call on every session idle. Returns `{ totalSent: 0, errors: [] }` when nothing has changed since last run.

## CLI (`src/index.ts`)

The CLI parses `--provider`, `--transport`, `--target`, and optional flags, then calls `sync()`. Additionally supports:
- `--dry-run`: reads records but does not send or advance watermarks; prints counts to stdout
- `--verbose`: prints progress to stderr

`--dry-run` is CLI-only (not in `SyncConfig`).

## Adding a New Provider

1. Create `src/providers/<id>.ts` implementing `Provider`
2. Register in `src/factory.ts` `createProvider()` switch
3. If it needs watermark injection (like opencode), accept `WatermarkStore` in constructor options and update the factory call signature

## Adding a New Transport

1. Create `src/transports/<id>.ts` implementing `Transport`
2. Register in `src/factory.ts` `createTransport()` switch; add any new required CLI args to `src/index.ts`

## Running

```bash
# Development (no build needed)
npx tsx src/index.ts --provider opencode --transport kafka \
  --target 127.0.0.1:9092 --topic test --dry-run --verbose

# Build to dist/
npm run build

# Type check
npm run lint
```

## Dependencies

- `better-sqlite3` — reads opencode SQLite DB and SQLite transport target
- `kafkajs` — Kafka transport
- `pg` — PostgreSQL transport
- `mysql2` — MySQL transport
- `tsx` (dev) — run TypeScript directly without build step
