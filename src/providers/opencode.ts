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
        const tableName = validateSqlIdentifier(table);
        const info = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
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
    const sepIndex = cursor.sourcePath.indexOf('#');
    const dbPath = cursor.sourcePath.slice(0, sepIndex);
    const table = cursor.sourcePath.slice(sepIndex + 1);
    const lastId = cursor.position;

    const db = new Database(dbPath, { readonly: true });
    const tableName = validateSqlIdentifier(table);
    try {
      const hasId = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
      const rawIdColumn = hasId.some((c) => c.name === 'id') ? 'id' : 'rowid';
      const idColumn = validateSqlIdentifier(rawIdColumn);

      const rows = db
        .prepare(`SELECT * FROM ${tableName} WHERE ${idColumn} > ? ORDER BY ${idColumn} LIMIT ?`)
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
    if (typeof row.session_id === 'number') return String(row.session_id);
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

function validateSqlIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}
