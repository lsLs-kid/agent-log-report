import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LogRecord, Provider, SourceCursor, OpenCodeSessionDoc, OpenCodeMessage, OpenCodeToolCall, OpenCodeReasoningPart } from '../types.js';
import type { WatermarkStore } from '../watermark.js';

export interface OpencodeProviderOptions {
  dbPaths: string[];
  watermark: WatermarkStore;
  userId?: string;
}

interface SessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string | null;
  directory: string | null;
  version: string | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  tokens_reasoning: number | null;
  time_created: number;
  time_updated: number;
  [key: string]: unknown;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
  [key: string]: unknown;
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
  [key: string]: unknown;
}

function msToIso(ms: number | null | undefined): string | null {
  if (ms == null || ms === 0) return null;
  return new Date(ms).toISOString();
}

const TOOL_OUTPUT_LIMIT = 16384;

// sql.js query helpers — wrap prepare/step/getAsObject into familiar all()/get() style

type SqlJsDb = {
  prepare(sql: string): SqlJsStmt;
  close(): void;
};

type SqlJsStmt = {
  bind(params: unknown[]): boolean;
  step(): boolean;
  getAsObject(params?: unknown[]): Record<string, unknown>;
  free(): void;
  reset(): void;
};

function sqlAll(db: SqlJsDb, sql: string, params: unknown[]): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function sqlGet(db: SqlJsDb, sql: string, params: unknown[]): Record<string, unknown> | undefined {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (!stmt.step()) return undefined;
    return stmt.getAsObject();
  } finally {
    stmt.free();
  }
}

async function openSqlJs(dbPath: string): Promise<SqlJsDb> {
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(dbPath);
  return new SQL.Database(buf) as unknown as SqlJsDb;
}

export class OpencodeProvider implements Provider {
  private resolvedDbPaths: string[];
  private watermark: WatermarkStore;

  constructor(private readonly opts: OpencodeProviderOptions) {
    this.resolvedDbPaths = opts.dbPaths
      .map((dbPath) => {
        const expanded = dbPath.startsWith('~')
          ? path.join(os.homedir(), dbPath.slice(1))
          : dbPath;
        const stat = fs.existsSync(expanded) ? fs.statSync(expanded) : undefined;
        if (stat?.isDirectory()) {
          return path.join(expanded, 'opencode.db');
        }
        return expanded;
      })
      .filter((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    this.watermark = opts.watermark;
  }

  async listSources(): Promise<SourceCursor[]> {
    return this.resolvedDbPaths.map((dbPath) => ({
      provider: 'opencode',
      sessionId: `opencode-sessions-${path.basename(dbPath, '.db')}`,
      sourcePath: dbPath,
      type: 'sqlite-table',
      position: 0,
    }));
  }

  async read(cursor: SourceCursor): Promise<{ records: LogRecord[]; nextCursor: SourceCursor }> {
    const lastMsgRowid = this.watermark.getExtra(cursor, 'msg-rowid');
    const lastPartRowid = this.watermark.getExtra(cursor, 'part-rowid');

    const db = await openSqlJs(cursor.sourcePath);
    try {
      const changedFromMsg = sqlAll(
        db,
        'SELECT DISTINCT session_id FROM message WHERE rowid > ? ORDER BY rowid',
        [lastMsgRowid],
      ) as { session_id: string }[];

      const changedFromPart = sqlAll(
        db,
        'SELECT DISTINCT session_id FROM part WHERE rowid > ? ORDER BY rowid',
        [lastPartRowid],
      ) as { session_id: string }[];

      const changedIds = new Set<string>([
        ...changedFromMsg.map((r) => r.session_id),
        ...changedFromPart.map((r) => r.session_id),
      ]);

      if (changedIds.size === 0) {
        return { records: [], nextCursor: cursor };
      }

      const newMsgRow = sqlGet(db, 'SELECT MAX(rowid) AS m FROM message WHERE rowid > ?', [lastMsgRowid]);
      const newMsgRowid = (newMsgRow?.m as number | null) ?? lastMsgRowid;

      const newPartRow = sqlGet(db, 'SELECT MAX(rowid) AS m FROM part WHERE rowid > ?', [lastPartRowid]);
      const newPartRowid = (newPartRow?.m as number | null) ?? lastPartRowid;

      const records: LogRecord[] = [];
      for (const sessionId of changedIds) {
        const record = this.buildSessionRecord(db, cursor, sessionId);
        if (record) records.push(record);
      }

      // Return new watermark values in nextCursor.extra so the caller
      // can commit them only after a successful send.
      return {
        records,
        nextCursor: {
          ...cursor,
          extra: { 'msg-rowid': newMsgRowid, 'part-rowid': newPartRowid },
        },
      };
    } finally {
      db.close();
    }
  }

  private buildSessionRecord(db: SqlJsDb, cursor: SourceCursor, sessionId: string): LogRecord | null {
    const sessionRow = sqlGet(db, 'SELECT * FROM session WHERE id = ?', [sessionId]) as SessionRow | undefined;
    if (!sessionRow) return null;

    const messageRows = sqlAll(
      db,
      'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id',
      [sessionId],
    ) as MessageRow[];

    const partRows = sqlAll(
      db,
      'SELECT id, message_id, session_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id',
      [sessionId],
    ) as PartRow[];

    const partsByMsg = new Map<string, PartRow[]>();
    for (const part of partRows) {
      const existing = partsByMsg.get(part.message_id);
      if (existing) existing.push(part);
      else partsByMsg.set(part.message_id, [part]);
    }

    const messages: OpenCodeMessage[] = messageRows.map((msgRow) =>
      this.buildMessage(msgRow, partsByMsg.get(msgRow.id) ?? []),
    );

    const doc: OpenCodeSessionDoc = {
      record_type: 'opencode-session',
      session_id: sessionRow.id,
      title: sessionRow.title ?? null,
      cwd: sessionRow.directory ?? null,
      project_id: sessionRow.project_id,
      version: sessionRow.version ?? null,
      model: sessionRow.model ?? null,
      is_subagent: sessionRow.parent_id !== null,
      parent_session_id: sessionRow.parent_id ?? null,
      started_at: msToIso(sessionRow.time_created),
      updated_at: msToIso(sessionRow.time_updated),
      cost_total: sessionRow.cost ?? 0,
      tokens_total: {
        input: sessionRow.tokens_input ?? 0,
        output: sessionRow.tokens_output ?? 0,
        cache_read: sessionRow.tokens_cache_read ?? 0,
        cache_write: sessionRow.tokens_cache_write ?? 0,
        reasoning: sessionRow.tokens_reasoning ?? 0,
      },
      message_count: messages.length,
      messages,
    };

    return {
      provider: 'opencode',
      sourcePath: cursor.sourcePath,
      sessionId: sessionRow.id,
      syncedAt: new Date().toISOString(),
      userId: this.opts.userId,
      normalized: doc as unknown as import('../types.js').NormalizedRecord,
    };
  }

  private buildMessage(row: MessageRow, parts: PartRow[]): OpenCodeMessage {
    const data = safeParseJson(row.data);
    const tokens = data.tokens as Record<string, unknown> | undefined;
    const cache = (tokens?.cache as Record<string, unknown>) ?? {};
    const timeField = data.time as Record<string, unknown> | undefined;
    const createdMs = (timeField?.created as number | undefined) ?? row.time_created;
    const completedMs = (timeField?.completed as number | undefined) ?? null;

    const modelField = data.model;
    const modelId =
      (typeof modelField === 'object' && modelField !== null
        ? (modelField as Record<string, unknown>).modelID
        : undefined) ??
      data.modelID ??
      null;
    const providerId =
      (typeof modelField === 'object' && modelField !== null
        ? (modelField as Record<string, unknown>).providerID
        : undefined) ??
      data.providerID ??
      null;

    const text_parts: string[] = [];
    const reasoning_parts: OpenCodeReasoningPart[] = [];
    const tool_calls: OpenCodeToolCall[] = [];
    let has_patch = false;
    let step_count = 0;

    for (const part of parts) {
      const d = safeParseJson(part.data);
      const partType = d.type as string | undefined;
      switch (partType) {
        case 'text':
          if (typeof d.text === 'string' && d.text) text_parts.push(d.text);
          break;
        case 'reasoning': {
          const t = d.time as Record<string, unknown> | undefined;
          const start = (t?.start as number | undefined) ?? null;
          const end = (t?.end as number | undefined) ?? null;
          reasoning_parts.push({
            text: typeof d.text === 'string' ? d.text : '',
            duration_ms: start != null && end != null && end > start ? end - start : null,
          });
          break;
        }
        case 'tool': {
          const state = (d.state as Record<string, unknown>) ?? {};
          const rawOutput = state.output;
          const output =
            typeof rawOutput === 'string'
              ? rawOutput.slice(0, TOOL_OUTPUT_LIMIT)
              : rawOutput != null
                ? JSON.stringify(rawOutput).slice(0, TOOL_OUTPUT_LIMIT)
                : null;
          tool_calls.push({
            tool_name: (d.tool as string | undefined) ?? '',
            call_id: (d.callID as string | undefined) ?? null,
            status: (state.status as string | undefined) ?? null,
            input: state.input ?? null,
            output,
            is_error: state.status === 'error',
          });
          break;
        }
        case 'patch':
        case 'file':
          has_patch = true;
          break;
        case 'step-start':
          step_count++;
          break;
      }
    }

    return {
      message_id: row.id,
      role: (data.role as string | undefined) ?? 'unknown',
      parent_message_id: (data.parentID as string | undefined) ?? null,
      timestamp: msToIso(createdMs),
      completed_at: msToIso(completedMs),
      generation_duration_ms:
        completedMs != null && createdMs != null && completedMs > createdMs
          ? completedMs - createdMs
          : null,
      model_id: modelId as string | null,
      provider_id: providerId as string | null,
      agent: (data.agent as string | undefined) ?? null,
      mode: (data.mode as string | undefined) ?? null,
      cost: (data.cost as number | undefined) ?? null,
      tokens:
        tokens != null
          ? {
              input: (tokens.input as number) ?? 0,
              output: (tokens.output as number) ?? 0,
              cache_read: (cache.read as number) ?? 0,
              cache_write: (cache.write as number) ?? 0,
              reasoning: (tokens.reasoning as number) ?? 0,
              total: (tokens.total as number) ?? 0,
            }
          : null,
      finish_reason: (data.finish as string | undefined) ?? null,
      text_parts,
      reasoning_parts,
      tool_calls,
      has_patch,
      step_count,
    };
  }
}

function safeParseJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function validateSqlIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}
