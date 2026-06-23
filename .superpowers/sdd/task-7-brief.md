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

