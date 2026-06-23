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

