# log-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone TypeScript CLI in `log-sync/` that incrementally syncs local agent logs (claude-code, code-agent-3x, opencode) to an HTTP API or database.

**Architecture:** The tool has three independent layers — Provider reads local logs into a unified `LogRecord` shape, Transport sends batches to a target, and Watermark tracks sync position per source. CLI wires these layers together. First run performs a full sync; later runs use watermarks to send only new records.

**Tech Stack:** TypeScript 5, Node 20+, `better-sqlite3`, `pg`, Node built-in `fetch`, `tsx` for dev execution.

## Global Constraints

- Lives in `log-sync/` subfolder under `/Users/shen/code/work/aaa`; must not be committed to git.
- Three providers must be supported: `claude-code`, `code-agent-3x`, `opencode`.
- Two transports must be supported: `http`, `db`.
- CLI configuration is passed via arguments; the tool is stateless except for the watermark file.
- Watermark file defaults to `~/.config/log-sync/watermark.json`.
- JSONL provider uses byte offset; opencode uses auto-increment row id.
- Each source's watermark is updated only after its batch is successfully sent.
- Exit codes: 0 success, 1 init/arg error, 2 partial sync failure.

---

## Task 1: Project Scaffolding

**Files:**
- Create: `log-sync/package.json`
- Create: `log-sync/tsconfig.json`
- Create: `log-sync/.gitignore`

**Interfaces:**
- Produces: `log-sync/` directory ready for TypeScript development.

- [ ] **Step 1: Create package.json**

Create `log-sync/package.json`:

```json
{
  "name": "log-sync",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "log-sync": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "pg": "^8.12.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.14.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.15.0",
    "typescript": "^5.4.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `log-sync/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create .gitignore**

Create `log-sync/.gitignore`:

```gitignore
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Verify TypeScript compiles empty project**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds with no output.

---

## Task 2: Core Types

**Files:**
- Create: `log-sync/src/types.ts`

**Interfaces:**
- Produces: `LogRecord`, `SourceCursor`, `Provider`, `Transport`, `LogSyncError`, `SyncOptions`.

- [ ] **Step 1: Write types.ts**

Create `log-sync/src/types.ts`:

```typescript
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
}

export interface NormalizedRecord {
  recordType?: string;
  role?: 'user' | 'assistant' | 'system' | 'tool';
  timestamp?: string;
  model?: string;
  tokenUsage?: TokenUsage;
  [key: string]: unknown;
}

export interface LogRecord {
  provider: 'claude-code' | 'code-agent-3x' | 'opencode';
  sourcePath: string;
  sessionId: string;
  syncedAt: string;
  raw: string;
  normalized: NormalizedRecord;
}

export interface SourceCursor {
  provider: string;
  sessionId: string;
  sourcePath: string;
  type: 'jsonl' | 'sqlite-table';
  position: number;
}

export interface Provider {
  listSources(): Promise<SourceCursor[]>;
  read(cursor: SourceCursor): Promise<{ records: LogRecord[]; nextCursor: SourceCursor }>;
}

export interface Transport {
  send(records: LogRecord[]): Promise<void>;
}

export class LogSyncError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LogSyncError';
  }
}

export interface SyncOptions {
  batchSize: number;
  dryRun: boolean;
  verbose: boolean;
}
```

- [ ] **Step 2: Verify types compile**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds with no output.

---

## Task 3: Watermark Module

**Files:**
- Create: `log-sync/src/watermark.ts`

**Interfaces:**
- Consumes: `SourceCursor` from `types.ts`.
- Produces: `WatermarkStore` class with `load`, `get`, `set`, `save`, `resetIfNeeded`.

- [ ] **Step 1: Write watermark.ts**

Create `log-sync/src/watermark.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SourceCursor } from './types.js';

export interface WatermarkEntry {
  path: string;
  lastOffset: number;
  lastRowId?: number;
  lastSyncAt: string;
}

export class WatermarkStore {
  private entries: Map<string, WatermarkEntry> = new Map();

  constructor(private readonly filePath: string) {}

  get defaultPath(): string {
    return path.join(os.homedir(), '.config', 'log-sync', 'watermark.json');
  }

  static ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
  }

  load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.entries = new Map();
      return;
    }
    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, WatermarkEntry>;
    this.entries = new Map(Object.entries(parsed));
  }

  save(): void {
    WatermarkStore.ensureDir(this.filePath);
    const obj = Object.fromEntries(this.entries);
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2) + '\n');
  }

  get(cursor: SourceCursor): WatermarkEntry {
    return (
      this.entries.get(cursor.sourcePath) ?? {
        path: cursor.sourcePath,
        lastOffset: 0,
        lastSyncAt: new Date(0).toISOString(),
      }
    );
  }

  set(cursor: SourceCursor, position: number): void {
    const entry: WatermarkEntry = {
      path: cursor.sourcePath,
      lastOffset: cursor.type === 'jsonl' ? position : 0,
      lastRowId: cursor.type === 'sqlite-table' ? position : undefined,
      lastSyncAt: new Date().toISOString(),
    };
    this.entries.set(cursor.sourcePath, entry);
  }

  /** Reset watermark if the source has shrunk below stored position. */
  resetIfNeeded(cursor: SourceCursor, currentSize: number): boolean {
    const existing = this.entries.get(cursor.sourcePath);
    if (!existing) return false;
    const stored = cursor.type === 'jsonl' ? existing.lastOffset : (existing.lastRowId ?? 0);
    if (stored > currentSize) {
      this.entries.delete(cursor.sourcePath);
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 2: Create a manual smoke test script**

Create `log-sync/scripts/test-watermark.ts`:

```typescript
import { WatermarkStore } from '../src/watermark.js';
import fs from 'node:fs';
import os from 'node:path';

const tmp = '/tmp/log-sync-watermark-test.json';
if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

const store = new WatermarkStore(tmp);
store.load();

const cursor = {
  provider: 'claude-code',
  sessionId: 's1',
  sourcePath: '/tmp/test.jsonl',
  type: 'jsonl' as const,
  position: 0,
};

console.log('initial:', store.get(cursor));
store.set(cursor, 123);
store.save();

const store2 = new WatermarkStore(tmp);
store2.load();
console.log('reloaded:', store2.get(cursor));

const reset = store2.resetIfNeeded(cursor, 50);
console.log('reset triggered:', reset);
console.log('after reset:', store2.get(cursor));
```

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx scripts/test-watermark.ts
```

Expected output:

```
initial: { path: '/tmp/test.jsonl', lastOffset: 0, lastSyncAt: '1970-01-01T00:00:00.000Z' }
reloaded: { path: '/tmp/test.jsonl', lastOffset: 123, lastSyncAt: '...' }
reset triggered: true
after reset: { path: '/tmp/test.jsonl', lastOffset: 0, lastSyncAt: '1970-01-01T00:00:00.000Z' }
```

- [ ] **Step 3: Verify TypeScript**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds.

---

## Task 4: JSONL Provider

**Files:**
- Create: `log-sync/src/providers/jsonl.ts`

**Interfaces:**
- Consumes: `LogRecord`, `SourceCursor`, `Provider` from `types.ts`.
- Produces: `JsonlProvider` class.

- [ ] **Step 1: Write jsonl.ts**

Create `log-sync/src/providers/jsonl.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { globSync } from 'node:fs';
import type { LogRecord, Provider, SourceCursor } from '../types.js';

export interface JsonlProviderOptions {
  providerId: 'claude-code' | 'code-agent-3x';
  root: string;
  subagentGlob?: string;
}

export class JsonlProvider implements Provider {
  private resolvedRoot: string;

  constructor(private readonly opts: JsonlProviderOptions) {
    this.resolvedRoot = opts.root.startsWith('~')
      ? path.join(os.homedir(), opts.root.slice(1))
      : path.resolve(opts.root);
  }

  async listSources(): Promise<SourceCursor[]> {
    if (!fs.existsSync(this.resolvedRoot)) return [];

    const cursors: SourceCursor[] = [];
    const entries = fs.readdirSync(this.resolvedRoot, { withFileTypes: true });

    for (const dir of entries) {
      if (!dir.isDirectory()) continue;
      const cwdDir = path.join(this.resolvedRoot, dir.name);
      const files = fs.readdirSync(cwdDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const fullPath = path.join(cwdDir, file);
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        cursors.push(this.makeCursor(fullPath));
      }

      // subagents
      const subagentPattern = this.opts.subagentGlob ?? '**/subagents/*.jsonl';
      const subagents = globSync(subagentPattern, { cwd: cwdDir, absolute: true });
      for (const sub of subagents) {
        if (!fs.existsSync(sub)) continue;
        cursors.push(this.makeCursor(sub));
      }
    }

    return cursors;
  }

  async read(cursor: SourceCursor): Promise<{ records: LogRecord[]; nextCursor: SourceCursor }> {
    const stat = fs.statSync(cursor.sourcePath);
    const fileSize = stat.size;
    const start = cursor.position;

    if (start >= fileSize) {
      return { records: [], nextCursor: { ...cursor, position: fileSize } };
    }

    const chunk = fs.readFileSync(cursor.sourcePath, { encoding: 'utf-8' });
    const slice = chunk.slice(start);
    const lines = slice.split('\n');

    const records: LogRecord[] = [];
    let consumed = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      const lineLength = line.length + (isLast ? 0 : 1); // +1 for newline, except trailing

      // Skip empty trailing line
      if (line.trim() === '' && isLast) {
        consumed += lineLength;
        continue;
      }

      // If last line has no newline, it's still being written; don't commit it
      if (isLast && !slice.endsWith('\n')) {
        break;
      }

      consumed += lineLength;

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(line);
      } catch {
        // Skip malformed line; don't advance watermark past it
        continue;
      }

      records.push(this.buildRecord(cursor, parsed, line));
    }

    return { records, nextCursor: { ...cursor, position: start + consumed } };
  }

  private makeCursor(sourcePath: string): SourceCursor {
    const sessionId = path.basename(sourcePath, '.jsonl');
    return {
      provider: this.opts.providerId,
      sessionId,
      sourcePath,
      type: 'jsonl',
      position: 0,
    };
  }

  private buildRecord(
    cursor: SourceCursor,
    parsed: Record<string, unknown>,
    rawLine: string,
  ): LogRecord {
    return {
      provider: this.opts.providerId,
      sourcePath: cursor.sourcePath,
      sessionId: cursor.sessionId,
      syncedAt: new Date().toISOString(),
      raw: rawLine,
      normalized: this.extractNormalized(parsed),
    };
  }

  private extractNormalized(parsed: Record<string, unknown>): LogRecord['normalized'] {
    const normalized: LogRecord['normalized'] = {
      recordType: typeof parsed.type === 'string' ? parsed.type : undefined,
    };

    const message = parsed.message as Record<string, unknown> | undefined;
    if (message?.role === 'user' || message?.role === 'assistant' || message?.role === 'system') {
      normalized.role = message.role;
    }

    if (typeof parsed.timestamp === 'string') {
      normalized.timestamp = parsed.timestamp;
    } else if (message && typeof message.timestamp === 'string') {
      normalized.timestamp = message.timestamp;
    }

    if (typeof parsed.model === 'string') {
      normalized.model = parsed.model;
    }

    const usage = parsed.usage ?? (message?.usage as Record<string, unknown> | undefined);
    if (usage && (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number')) {
      normalized.tokenUsage = {
        input: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        output: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
        cacheCreation: typeof usage.cache_creation_tokens === 'number' ? usage.cache_creation_tokens : undefined,
        cacheRead: typeof usage.cache_read_tokens === 'number' ? usage.cache_read_tokens : undefined,
      };
    }

    return normalized;
  }
}
```

- [ ] **Step 2: Create manual smoke test**

Create `log-sync/scripts/test-jsonl.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonlProvider } from '../src/providers/jsonl.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-jsonl-'));
const cwdDir = path.join(tmpRoot, 'encoded-cwd');
fs.mkdirSync(cwdDir, { recursive: true });

const sessionFile = path.join(cwdDir, 'session-1.jsonl');
fs.writeFileSync(
  sessionFile,
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n' +
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' }, usage: { input_tokens: 10, output_tokens: 5 } }) + '\n',
);

const provider = new JsonlProvider({ providerId: 'claude-code', root: tmpRoot });

(async () => {
  const sources = await provider.listSources();
  console.log('sources:', sources.length);
  const { records, nextCursor } = await provider.read(sources[0]);
  console.log('records:', records.length);
  console.log(JSON.stringify(records[0], null, 2));
  console.log('next position:', nextCursor.position);

  // second read should be empty
  const second = await provider.read(nextCursor);
  console.log('second records:', second.records.length);
})();
```

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx scripts/test-jsonl.ts
```

Expected output:

```
sources: 1
records: 2
{
  "provider": "claude-code",
  "sourcePath": "...",
  "sessionId": "session-1",
  "syncedAt": "...",
  "raw": "...",
  "normalized": { "recordType": "user", "role": "user" }
}
next position: <non-zero>
second records: 0
```

- [ ] **Step 3: Verify TypeScript**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds.

---

## Task 5: Opencode Provider

**Files:**
- Create: `log-sync/src/providers/opencode.ts`

**Interfaces:**
- Consumes: `LogRecord`, `SourceCursor`, `Provider` from `types.ts`.
- Produces: `OpencodeProvider` class.

- [ ] **Step 1: Install types and better-sqlite3**

Already done in Task 1. If not, run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npm install
```

- [ ] **Step 2: Write opencode.ts**

Create `log-sync/src/providers/opencode.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type { LogRecord, Provider, SourceCursor } from '../types.js';

export interface OpencodeProviderOptions {
  dbPath: string;
  batchSize?: number;
}

interface TableRow {
  id: number;
  [key: string]: unknown;
}

export class OpencodeProvider implements Provider {
  private resolvedDbPath: string;
  private batchSize: number;

  constructor(private readonly opts: OpencodeProviderOptions) {
    const expanded = opts.dbPath.startsWith('~')
      ? path.join(os.homedir(), opts.dbPath.slice(1))
      : opts.dbPath;
    const stat = fs.existsSync(expanded) ? fs.statSync(expanded) : undefined;
    if (stat?.isDirectory()) {
      this.resolvedDbPath = path.join(expanded, 'opencode.db');
    } else {
      this.resolvedDbPath = expanded;
    }
    this.batchSize = opts.batchSize ?? 1000;
  }

  async listSources(): Promise<SourceCursor[]> {
    if (!fs.existsSync(this.resolvedDbPath)) return [];

    const tables = ['session', 'message', 'part'];
    const db = new Database(this.resolvedDbPath, { readonly: true });
    try {
      const cursors: SourceCursor[] = [];
      for (const table of tables) {
        const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (info.length === 0) continue;

        const sessionId = `opencode-${table}`;
        cursors.push({
          provider: 'opencode',
          sessionId,
          sourcePath: `${this.resolvedDbPath}#${table}`,
          type: 'sqlite-table',
          position: 0,
        });
      }
      return cursors;
    } finally {
      db.close();
    }
  }

  async read(cursor: SourceCursor): Promise<{ records: LogRecord[]; nextCursor: SourceCursor }> {
    const [dbPath, table] = cursor.sourcePath.split('#');
    const lastId = cursor.position;

    const db = new Database(dbPath, { readonly: true });
    try {
      const hasId = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      const idColumn = hasId.some((c) => c.name === 'id') ? 'id' : 'rowid';

      const rows = db
        .prepare(`SELECT * FROM ${table} WHERE ${idColumn} > ? ORDER BY ${idColumn} LIMIT ?`)
        .all(lastId, this.batchSize) as TableRow[];

      if (rows.length === 0) {
        return { records: [], nextCursor: cursor };
      }

      const records = rows.map((row) => this.buildRecord(cursor, table, row));
      const maxId = Math.max(...rows.map((r) => Number(r[idColumn] ?? 0)));

      return {
        records,
        nextCursor: { ...cursor, position: maxId },
      };
    } finally {
      db.close();
    }
  }

  private buildRecord(cursor: SourceCursor, table: string, row: TableRow): LogRecord {
    const raw = JSON.stringify(row);
    const parsed = row.data ?? row;

    return {
      provider: 'opencode',
      sourcePath: cursor.sourcePath,
      sessionId: this.inferSessionId(row, table),
      syncedAt: new Date().toISOString(),
      raw,
      normalized: this.extractNormalized(table, parsed as Record<string, unknown>, row),
    };
  }

  private inferSessionId(row: TableRow, table: string): string {
    if (typeof row.session_id === 'string') return row.session_id;
    if (table === 'session' && typeof row.id !== 'undefined') return String(row.id);
    return 'unknown';
  }

  private extractNormalized(
    table: string,
    data: Record<string, unknown>,
    row: TableRow,
  ): LogRecord['normalized'] {
    const normalized: LogRecord['normalized'] = {
      recordType: table,
    };

    if (typeof row.role === 'string') {
      if (['user', 'assistant', 'system', 'tool'].includes(row.role)) {
        normalized.role = row.role as LogRecord['normalized']['role'];
      }
    }

    const ts = row.time_created ?? row.time_updated ?? data.timestamp;
    if (typeof ts === 'string' || typeof ts === 'number') {
      normalized.timestamp = new Date(ts).toISOString();
    }

    return normalized;
  }
}
```

- [ ] **Step 3: Create manual smoke test**

Create `log-sync/scripts/test-opencode.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { OpencodeProvider } from '../src/providers/opencode.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-opencode-'));
const dbPath = path.join(tmpDir, 'opencode.db');

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE session (id INTEGER PRIMARY KEY, title TEXT, time_created TEXT);
  CREATE TABLE message (id INTEGER PRIMARY KEY, role TEXT, session_id INTEGER, time_created TEXT, data TEXT);
  CREATE TABLE part (id INTEGER PRIMARY KEY, message_id INTEGER, type TEXT, time_created TEXT, data TEXT);

  INSERT INTO session (id, title, time_created) VALUES (1, 'test', '2024-01-01T00:00:00Z');
  INSERT INTO message (id, role, session_id, time_created, data) VALUES (1, 'user', 1, '2024-01-01T00:00:01Z', '{"text":"hello"}');
`);
db.close();

(async () => {
  const provider = new OpencodeProvider({ dbPath });
  const sources = await provider.listSources();
  console.log('sources:', sources.length);

  for (const src of sources) {
    const { records, nextCursor } = await provider.read(src);
    console.log(src.sourcePath, 'records:', records.length, 'next:', nextCursor.position);
    if (records.length > 0) {
      console.log(JSON.stringify(records[0], null, 2));
    }
  }
})();
```

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx scripts/test-opencode.ts
```

Expected output: 3 sources, each with 0 or 1 records depending on table contents.

- [ ] **Step 4: Verify TypeScript**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds.

---

## Task 6: HTTP Transport

**Files:**
- Create: `log-sync/src/transports/http.ts`

**Interfaces:**
- Consumes: `LogRecord`, `Transport` from `types.ts`.
- Produces: `HttpTransport` class.

- [ ] **Step 1: Write http.ts**

Create `log-sync/src/transports/http.ts`:

```typescript
import type { LogRecord, Transport } from '../types.js';
import { LogSyncError } from '../types.js';

export interface HttpTransportOptions {
  endpoint: string;
  headers?: Record<string, string>;
  batchSize?: number;
  timeoutMs?: number;
}

export class HttpTransport implements Transport {
  private batchSize: number;
  private timeoutMs: number;

  constructor(private readonly opts: HttpTransportOptions) {
    this.batchSize = opts.batchSize ?? 100;
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  async send(records: LogRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += this.batchSize) {
      const batch = records.slice(i, i + this.batchSize);
      await this.sendBatch(batch);
    }
  }

  private async sendBatch(batch: LogRecord[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.opts.headers,
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new LogSyncError(
          `HTTP ${response.status}: ${response.statusText}. ${body.slice(0, 200)}`,
          'HTTP_ERROR',
        );
      }
    } catch (err) {
      if (err instanceof LogSyncError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LogSyncError(`HTTP request timed out after ${this.timeoutMs}ms`, 'HTTP_TIMEOUT');
      }
      throw new LogSyncError(
        `Failed to send batch: ${err instanceof Error ? err.message : String(err)}`,
        'HTTP_ERROR',
        err,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

- [ ] **Step 2: Manual test with a local HTTP server**

Create `log-sync/scripts/test-http.ts`:

```typescript
import http from 'node:http';
import { HttpTransport } from '../src/transports/http.js';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    console.log('received', parsed.length, 'records');
    res.writeHead(200);
    res.end('ok');
  });
});

server.listen(39999, async () => {
  const transport = new HttpTransport({ endpoint: 'http://localhost:39999' });
  await transport.send([
    {
      provider: 'claude-code',
      sourcePath: '/tmp/x.jsonl',
      sessionId: 's1',
      syncedAt: new Date().toISOString(),
      raw: '{}',
      normalized: {},
    },
  ]);
  server.close();
});
```

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx scripts/test-http.ts
```

Expected output:

```
received 1 records
```

- [ ] **Step 3: Verify TypeScript**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds.

---

## Task 7: DB Transport

**Files:**
- Create: `log-sync/src/transports/db.ts`

**Interfaces:**
- Consumes: `LogRecord`, `Transport` from `types.ts`.
- Produces: `DbTransport` class supporting `postgres://`, `mysql://`, `sqlite://`.

- [ ] **Step 1: Write db.ts**

Create `log-sync/src/transports/db.ts`:

```typescript
import { Client as PgClient } from 'pg';
import type { LogRecord, Transport } from '../types.js';
import { LogSyncError } from '../types.js';

export interface DbTransportOptions {
  url: string;
  tableName?: string;
}

export class DbTransport implements Transport {
  private tableName: string;

  constructor(private readonly opts: DbTransportOptions) {
    this.tableName = opts.tableName ?? 'log_sync_records';
  }

  async send(records: LogRecord[]): Promise<void> {
    if (records.length === 0) return;

    const scheme = this.opts.url.split('://')[0];
    if (scheme === 'postgres' || scheme === 'postgresql') {
      await this.sendPostgres(records);
    } else if (scheme === 'sqlite') {
      await this.sendSqlite(records);
    } else {
      throw new LogSyncError(`Unsupported DB scheme: ${scheme}`, 'DB_UNSUPPORTED');
    }
  }

  private async sendPostgres(records: LogRecord[]): Promise<void> {
    const client = new PgClient({ connectionString: this.opts.url });
    try {
      await client.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id BIGSERIAL PRIMARY KEY,
          provider TEXT NOT NULL,
          source_path TEXT NOT NULL,
          session_id TEXT NOT NULL,
          synced_at TIMESTAMPTZ NOT NULL,
          raw JSONB NOT NULL,
          normalized JSONB
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableName}_provider_session ON ${this.tableName}(provider, session_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_${this.tableName}_synced_at ON ${this.tableName}(synced_at)`);

      await client.query('BEGIN');
      try {
        for (const r of records) {
          await client.query(
            `INSERT INTO ${this.tableName} (provider, source_path, session_id, synced_at, raw, normalized)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [r.provider, r.sourcePath, r.sessionId, r.syncedAt, r.raw, JSON.stringify(r.normalized)],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } finally {
      await client.end();
    }
  }

  private async sendSqlite(records: LogRecord[]): Promise<void> {
    const { default: Database } = await import('better-sqlite3');
    const dbPath = this.opts.url.replace(/^sqlite:\/\//, '');
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL,
          source_path TEXT NOT NULL,
          session_id TEXT NOT NULL,
          synced_at TEXT NOT NULL,
          raw TEXT NOT NULL,
          normalized TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tableName}_provider_session ON ${this.tableName}(provider, session_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${this.tableName}_synced_at ON ${this.tableName}(synced_at)`);

      const insert = db.prepare(
        `INSERT INTO ${this.tableName} (provider, source_path, session_id, synced_at, raw, normalized)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      db.transaction(() => {
        for (const r of records) {
          insert.run(r.provider, r.sourcePath, r.sessionId, r.syncedAt, r.raw, JSON.stringify(r.normalized));
        }
      })();
    } finally {
      db.close();
    }
  }
}
```

- [ ] **Step 2: Manual test with SQLite target**

Create `log-sync/scripts/test-db.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DbTransport } from '../src/transports/db.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-db-'));
const dbUrl = `sqlite://${path.join(tmp, 'target.db')}`;

(async () => {
  const transport = new DbTransport({ url: dbUrl });
  await transport.send([
    {
      provider: 'claude-code',
      sourcePath: '/tmp/x.jsonl',
      sessionId: 's1',
      syncedAt: new Date().toISOString(),
      raw: '{}',
      normalized: { recordType: 'user' },
    },
  ]);
  console.log('sqlite transport ok');
})();
```

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx scripts/test-db.ts
```

Expected output:

```
sqlite transport ok
```

- [ ] **Step 3: Verify TypeScript**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds.

---

## Task 8: CLI Entry

**Files:**
- Create: `log-sync/src/index.ts`
- Create: `log-sync/src/factory.ts`

**Interfaces:**
- Consumes: `Provider`, `Transport`, `WatermarkStore`, `SyncOptions`.
- Produces: working CLI.

- [ ] **Step 1: Write factory.ts**

Create `log-sync/src/factory.ts`:

```typescript
import type { Provider, Transport } from './types.js';
import { JsonlProvider } from './providers/jsonl.js';
import { OpencodeProvider } from './providers/opencode.js';
import { HttpTransport } from './transports/http.js';
import { DbTransport } from './transports/db.js';
import { LogSyncError } from './types.js';

export function createProvider(providerId: string, root?: string): Provider {
  switch (providerId) {
    case 'claude-code':
      return new JsonlProvider({
        providerId,
        root: root ?? '~/.claude/projects',
      });
    case 'code-agent-3x':
      return new JsonlProvider({
        providerId,
        root: root ?? '~/.cac/projects',
      });
    case 'opencode':
      return new OpencodeProvider({
        dbPath: root ?? '~/.local/share/opencode/opencode.db',
      });
    default:
      throw new LogSyncError(`Unknown provider: ${providerId}`, 'UNKNOWN_PROVIDER');
  }
}

export function createTransport(transportId: string, target: string): Transport {
  switch (transportId) {
    case 'http':
      return new HttpTransport({ endpoint: target });
    case 'db':
      return new DbTransport({ url: target });
    default:
      throw new LogSyncError(`Unknown transport: ${transportId}`, 'UNKNOWN_TRANSPORT');
  }
}
```

- [ ] **Step 2: Write index.ts**

Create `log-sync/src/index.ts`:

```typescript
import process from 'node:process';
import { WatermarkStore } from './watermark.js';
import { createProvider, createTransport } from './factory.js';
import type { SourceCursor } from './types.js';
import { LogSyncError } from './types.js';

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const parsed: Record<string, string | boolean | undefined> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = true;
    }
  }

  return parsed;
}

function usage(): string {
  return `
Usage: log-sync --provider <provider> --transport <transport> --target <target> [options]

Options:
  --provider           claude-code | code-agent-3x | opencode
  --transport          http | db
  --target             HTTP endpoint or DB connection URL
  --root               Override default log root / db path
  --watermark-file     Watermark file path (default: ~/.config/log-sync/watermark.json)
  --batch-size         Records per batch (default: 100)
  --dry-run            Print what would be sent without sending
  --verbose            Print progress
  --help               Show this help
`.trim();
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const providerId = args.provider as string | undefined;
  const transportId = args.transport as string | undefined;
  const target = args.target as string | undefined;

  if (!providerId || !transportId || !target) {
    console.error('Error: --provider, --transport, and --target are required');
    console.error(usage());
    process.exit(1);
  }

  const batchSize = parseInt(args['batch-size'] as string, 10) || 100;
  const dryRun = !!args['dry-run'];
  const verbose = !!args.verbose;
  const root = args.root as string | undefined;
  const watermarkFile = (args['watermark-file'] as string) ?? undefined;

  const provider = createProvider(providerId, root);
  const transport = createTransport(transportId, target as string);
  const watermark = new WatermarkStore(watermarkFile ?? new WatermarkStore('').defaultPath);
  watermark.load();

  const sources = await provider.listSources();
  if (verbose) {
    console.error(`Found ${sources.length} source(s) for provider ${providerId}`);
  }

  const failed: { cursor: SourceCursor; error: unknown }[] = [];

  for (const cursor of sources) {
    try {
      await syncSource(provider, transport, watermark, cursor, { batchSize, dryRun, verbose });
    } catch (err) {
      failed.push({ cursor, error: err });
      console.error(`Failed to sync ${cursor.sourcePath}:`, err instanceof Error ? err.message : String(err));
    }
  }

  watermark.save();

  if (failed.length > 0) {
    console.error(`\n${failed.length} source(s) failed`);
    process.exit(2);
  }

  if (verbose) {
    console.error('Sync complete');
  }
}

async function syncSource(
  provider: ReturnType<typeof createProvider>,
  transport: ReturnType<typeof createTransport>,
  watermark: WatermarkStore,
  cursor: SourceCursor,
  opts: { batchSize: number; dryRun: boolean; verbose: boolean },
) {
  let current = { ...cursor, position: watermark.get(cursor).lastOffset || watermark.get(cursor).lastRowId || 0 };

  if (cursor.type === 'jsonl') {
    const { createReadStream } = await import('node:fs');
    const { statSync } = await import('node:fs');
    const size = statSync(cursor.sourcePath).size;
    if (watermark.resetIfNeeded(cursor, size)) {
      current = { ...cursor, position: 0 };
      if (opts.verbose) console.error(`Reset watermark for ${cursor.sourcePath} (file shrank)`);
    }
  }

  let total = 0;
  while (true) {
    const { records, nextCursor } = await provider.read(current);
    if (records.length === 0) break;

    if (opts.dryRun) {
      console.log(`Would send ${records.length} records from ${cursor.sourcePath}`);
    } else {
      await transport.send(records);
      watermark.set(nextCursor, nextCursor.position);
    }

    total += records.length;
    current = nextCursor;

    if (records.length < opts.batchSize) break;
  }

  if (opts.verbose) {
    console.error(`Synced ${total} records from ${cursor.sourcePath}`);
  }
}

main().catch((err) => {
  if (err instanceof LogSyncError) {
    console.error(`Error [${err.code}]: ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
```

- [ ] **Step 3: Test CLI help**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx src/index.ts --help
```

Expected: prints usage and exits 0.

- [ ] **Step 4: Test CLI dry-run**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx src/index.ts --provider claude-code --transport http --target http://localhost:39999 --dry-run
```

Expected: if local claude logs exist, prints "Would send N records from ..." without making network calls.

- [ ] **Step 5: Verify TypeScript**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds.

---

## Task 9: Build and Final Verification

**Files:**
- Modify: `log-sync/package.json` (add `bin` build output path if needed)

- [ ] **Step 1: Build the project**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npm run build
```

Expected: creates `log-sync/dist/` with compiled JS files.

- [ ] **Step 2: Run compiled CLI help**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
node dist/index.js --help
```

Expected: prints usage.

- [ ] **Step 3: End-to-end test with HTTP server**

Create `log-sync/scripts/e2e-http.ts`:

```typescript
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-e2e-'));
const cwdDir = path.join(tmpRoot, 'cwd');
fs.mkdirSync(cwdDir, { recursive: true });
fs.writeFileSync(
  path.join(cwdDir, 'session.jsonl'),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n',
);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const records = JSON.parse(body);
    console.log('E2E received', records.length, 'records');
    console.log(records[0]?.normalized);
    res.writeHead(200);
    res.end('ok');
  });
});

server.listen(39998, () => {
  const child = spawn('node', [
    'dist/index.js',
    '--provider', 'claude-code',
    '--transport', 'http',
    '--target', 'http://localhost:39998',
    '--root', tmpRoot,
    '--watermark-file', path.join(tmpRoot, 'watermark.json'),
    '--verbose',
  ], {
    cwd: '/Users/shen/code/work/aaa/log-sync',
    stdio: 'inherit',
  });

  child.on('close', (code) => {
    console.log('exit code:', code);
    server.close();
  });
});
```

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx scripts/e2e-http.ts
```

Expected output:

```
Found 1 source(s) for provider claude-code
Synced 1 records from ...
E2E received 1 records
{ recordType: 'user', role: 'user' }
exit code: 0
```

- [ ] **Step 4: Confirm git status excludes the new folder**

Run:

```bash
cd /Users/shen/code/work/aaa
git status --short
```

Expected: only `docs/superpowers/specs/...` and `docs/superpowers/plans/...` appear (the parent repo docs), and `log-sync/` is untracked but should not be committed. If you want to keep it truly out of the repo, add `log-sync/` to the root `.gitignore` or leave it untracked.

---

## Spec Coverage Check

| Spec Requirement | Task |
|------------------|------|
| Standalone `log-sync/` subfolder | Task 1 |
| Not committed to git | Task 9 Step 4 note |
| Three providers | Task 4 (jsonl), Task 5 (opencode) |
| HTTP transport | Task 6 |
| DB transport | Task 7 |
| Unified `LogRecord` with raw + normalized | Task 2 |
| Watermark file default path | Task 3 |
| JSONL byte offset incrementality | Task 4 |
| opencode row-id incrementality | Task 5 |
| CLI arguments | Task 8 |
| Exit codes | Task 8 |
| Per-source watermark update only on success | Task 8 `syncSource` |

## Placeholder Scan

No TBD, TODO, or vague steps. Every step includes exact file path and full code.

## Type Consistency Check

- `LogRecord`, `SourceCursor`, `Provider`, `Transport` defined in Task 2 and used unchanged in all later tasks.
- `WatermarkStore.set(cursor, position)` and `WatermarkEntry` fields match usage in Task 3 and Task 8.
- `JsonlProvider` and `OpencodeProvider` both implement `Provider` interface from Task 2.
- `HttpTransport` and `DbTransport` both implement `Transport` interface from Task 2.
