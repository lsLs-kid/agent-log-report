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
    ├── kafka.ts        # KafkaTransport (kafkajs, PLAINTEXT, GZIP, no auth)
    └── http.ts         # HttpTransport (POST JSON array, Node fetch)
```

## Key Abstractions

### Provider interface (`src/types.ts`)
```typescript
interface Provider {
  listSources(): Promise<SourceCursor[]>;
  read(cursor: SourceCursor): Promise<{ records: LogRecord[]; nextCursor: SourceCursor }>;
}
```
Each provider returns `SourceCursor` objects (one per log file or DB table) and reads `LogRecord` batches starting from `cursor.position`. The `nextCursor` may carry `extra: Record<string, number>` with auxiliary watermark values (used by opencode) — these are committed by `syncSource` only after a successful send.

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
  normalized: NormalizedRecord;  // structured extraction; no raw field
}
```

Note: there is no `raw` field. For opencode, `normalized` IS the full structured document. For JSONL providers, `normalized` is a thin extraction from the original line (role, timestamp, model, tokenUsage).

### SourceCursor (`src/types.ts`)
```typescript
interface SourceCursor {
  provider: string;
  sessionId: string;
  sourcePath: string;
  type: 'jsonl' | 'sqlite-table';
  position: number;
  extra?: Record<string, number>;  // auxiliary watermark values from provider
}
```

### WatermarkStore (`src/watermark.ts`)
Persists sync positions to a JSON file (`~/.config/log-sync/watermark.json` by default). Keyed by `sourcePath`. The `set()` method preserves existing `extra` fields. For opencode, auxiliary rowid watermarks are stored in `WatermarkEntry.extra` via `getExtra(cursor, key)` / `setExtra(cursor, key, value)`.

**Watermark commit order** (critical invariant): watermarks are written to disk only inside `syncSource` immediately after `transport.send()` succeeds. A failed send leaves the watermark unchanged, so the next run retries the same data.

## Provider Details

### jsonl (claude-code, code-agent-3x)
- Reads JSONL files from `~/.claude/projects/**/*.jsonl` (claude-code) or `~/.cac/projects/**/*.jsonl` (code-agent-3x)
- Also discovers subagent files at `**/subagents/*.jsonl`
- `cursor.position` = byte offset; advances only past complete lines with valid JSON
- Handles file shrinkage (log rotation) by resetting watermark to 0
- Each line becomes one `LogRecord`; `normalized` extracts `role`, `timestamp`, `model`, `tokenUsage`

### opencode
- Reads `~/.local/share/opencode/db/ngagent.db` (or path override via `--root`)
- Uses **`sql.js`** (pure WASM, no native build required) to read the SQLite file
- **Session-level granularity**: one `LogRecord` = one complete session document
- Change detection: queries `message WHERE rowid > last_msg_rowid` and `part WHERE rowid > last_part_rowid` to find sessions with new content
- For each changed session: joins session + all messages + all parts, assembles `OpenCodeSessionDoc`
- New watermark values (`msg-rowid`, `part-rowid`) are returned in `nextCursor.extra` — NOT written inside `read()`. `syncSource` in `sync.ts` commits them via `watermark.setExtra()` after a successful send.
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
    // output NOT truncated — full content preserved
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
- `target` = comma-separated `host:port` list; each broker is stripped of `\r\n\t` and validated as `host:port` with numeric port 1–65535 before connecting
- Each `LogRecord` → one Kafka message; key = `sessionId`, value = `JSON.stringify(record)`
- **GZIP compression** applied on every send (`CompressionTypes.GZIP`); transparent to consumers — kafkajs auto-decompresses on receive
- Connects and disconnects per `send()` call

### http
- `target` = HTTP(S) URL
- POSTs `LogRecord[]` as JSON array; `Content-Type: application/json`
- Default timeout: 10 000 ms
- Splits into sub-batches of `batchSize` records each

## Public API (`src/mod.ts`)

```typescript
import { sync } from './src/mod.js';
import type { SyncConfig, SyncResult, LogRecord, OpenCodeSessionDoc } from './src/mod.js';
```

### `sync(config: SyncConfig): Promise<SyncResult>`

```typescript
interface SyncConfig {
  provider: string;        // 'opencode' | 'claude-code' | 'code-agent-3x'
  transport: string;       // 'kafka' | 'http'
  target: string;          // broker list / URL
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

`sync()` is idempotent and safe to call on every session idle. Watermark is saved to disk after each successful send; a failed send does not advance the watermark. Returns `{ totalSent: 0, errors: [] }` when nothing has changed since last run.

## CLI (`src/index.ts`)

The CLI parses `--provider`, `--transport`, `--target`, and optional flags, then calls `sync()`. Additionally supports:
- `--dry-run`: reads records but does not send or advance watermarks; prints counts to stdout
- `--verbose`: prints progress to stderr

`--dry-run` is CLI-only (not in `SyncConfig`).

## Adding a New Provider

1. Create `src/providers/<id>.ts` implementing `Provider`
2. Return new watermark values in `nextCursor.extra` (not via direct WatermarkStore calls inside `read()`) so `syncSource` can commit them only after a successful send
3. Register in `src/factory.ts` `createProvider()` switch
4. If it needs WatermarkStore for reading initial watermarks, accept it in constructor options and update the factory call signature

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

- `sql.js` — pure WASM SQLite; reads opencode DB (no native build required, works on Windows without MSVC)
- `kafkajs` — Kafka transport
- `tsx` (dev) — run TypeScript directly without build step
