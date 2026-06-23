import { Client as PgClient } from 'pg';
import type { LogRecord, Transport } from '../types.js';
import { LogSyncError } from '../types.js';

const VALID_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_TABLE_NAME_LEN = 43; // leaves room for "idx_<table>_provider_session" under 64 chars

export interface DbTransportOptions {
  url: string;
  tableName?: string;
}

export class DbTransport implements Transport {
  private tableName: string;

  constructor(private readonly opts: DbTransportOptions) {
    const name = opts.tableName ?? 'log_sync_records';
    if (!VALID_TABLE_NAME.test(name) || name.length > MAX_TABLE_NAME_LEN) {
      throw new LogSyncError('Invalid table name', 'DB_INVALID_TABLE');
    }
    this.tableName = name;
  }

  async send(records: LogRecord[]): Promise<void> {
    if (records.length === 0) return;

    const scheme = this.opts.url.split('://')[0];
    if (scheme === 'postgres' || scheme === 'postgresql') {
      await this.sendPostgres(records);
    } else if (scheme === 'mysql') {
      await this.sendMysql(records);
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
        try {
          await client.query('ROLLBACK');
        } catch (_rollbackErr) {
          // ignore rollback errors; rethrow original
        }
        throw err;
      }
    } finally {
      await client.end();
    }
  }

  private async sendMysql(records: LogRecord[]): Promise<void> {
    const { createConnection } = await import('mysql2/promise');
    const conn = await createConnection({ uri: this.opts.url });
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          provider VARCHAR(255) NOT NULL,
          source_path TEXT NOT NULL,
          session_id VARCHAR(255) NOT NULL,
          synced_at DATETIME(3) NOT NULL,
          raw JSON NOT NULL,
          normalized JSON,
          INDEX idx_${this.tableName}_provider_session (provider, session_id),
          INDEX idx_${this.tableName}_synced_at (synced_at)
        )
      `);

      await conn.beginTransaction();
      try {
        for (const r of records) {
          await conn.query(
            `INSERT INTO ${this.tableName} (provider, source_path, session_id, synced_at, raw, normalized)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [r.provider, r.sourcePath, r.sessionId, r.syncedAt, r.raw, JSON.stringify(r.normalized)],
          );
        }
        await conn.commit();
      } catch (err) {
        try {
          await conn.rollback();
        } catch (_rollbackErr) {
          // ignore rollback errors; rethrow original
        }
        throw err;
      }
    } finally {
      await conn.end();
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
