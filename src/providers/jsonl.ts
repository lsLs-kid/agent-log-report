import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LogRecord, Provider, SourceCursor } from '../types.js';

export interface JsonlProviderOptions {
  providerId: 'claude-code' | 'code-agent-3x';
  root: string;
  subagentGlob?: string;
  batchSize?: number;
  userId?: string;
}

function globSyncFallback(pattern: string, options: { cwd: string; absolute: boolean }): string[] {
  const results: string[] = [];
  const cwd = options.cwd;

  function recurse(dir: string, relativePrefix: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        recurse(fullPath, relativePath);
      } else if (entry.isFile()) {
        // pattern is '**/subagents/*.jsonl'
        // Match: any depth, directory named 'subagents', file ending with '.jsonl'
        if (relativePath.endsWith('.jsonl')) {
          const parts = relativePath.split(path.sep);
          // Check if any directory in the path is named 'subagents'
          const hasSubagentsDir = parts.slice(0, -1).some((p) => p === 'subagents');
          if (hasSubagentsDir) {
            results.push(options.absolute ? fullPath : relativePath);
          }
        }
      }
    }
  }

  recurse(cwd, '');
  return results;
}

export class JsonlProvider implements Provider {
  private resolvedRoot: string;
  private batchSize: number;

  constructor(private readonly opts: JsonlProviderOptions) {
    this.resolvedRoot = opts.root.startsWith('~')
      ? path.join(os.homedir(), opts.root.slice(1))
      : path.resolve(opts.root);
    this.batchSize = opts.batchSize ?? 1000;
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
      const globFn = (fs as unknown as Record<string, unknown>).globSync as
        | ((pattern: string, options: { cwd: string; absolute: boolean }) => string[])
        | undefined;
      const subagents = globFn
        ? globFn(subagentPattern, { cwd: cwdDir, absolute: true })
        : globSyncFallback(subagentPattern, { cwd: cwdDir, absolute: true });
      for (const sub of subagents) {
        const resolvedSub = path.resolve(cwdDir, sub);
        if (!fs.existsSync(resolvedSub)) continue;
        cursors.push(this.makeCursor(resolvedSub));
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

    // Read up to batchSize * 4KB bytes (heuristic average line size)
    const maxBytes = this.batchSize * 4096;
    const readSize = Math.min(maxBytes, fileSize - start);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(cursor.sourcePath, 'r');
    let bytesRead: number;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, readSize, start);
    } finally {
      fs.closeSync(fd);
    }

    let text = buffer.toString('utf-8', 0, bytesRead);
    // If we didn't read to EOF, cut to last complete line
    if (start + bytesRead < fileSize) {
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        // No complete line in this chunk; don't advance
        return { records: [], nextCursor: { ...cursor, position: start } };
      }
      text = text.slice(0, lastNewline + 1);
    }

    const lines = text.split('\n');
    const records: LogRecord[] = [];
    let consumedBytes = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      const rawLine = line + (isLast ? '' : '\n');
      const lineBytes = Buffer.byteLength(rawLine, 'utf-8');

      // Skip empty trailing line
      if (line.trim() === '' && isLast) {
        consumedBytes += lineBytes;
        continue;
      }

      // If last line has no newline, it's still being written; don't commit it
      if (isLast && !text.endsWith('\n')) {
        break;
      }

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(line);
      } catch {
        // Skip malformed line; don't advance watermark past it
        continue;
      }

      consumedBytes += lineBytes;
      records.push(this.buildRecord(cursor, parsed, line));
    }

    return { records, nextCursor: { ...cursor, position: start + consumedBytes } };
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
      userId: this.opts.userId,
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

    const usage = (parsed.usage ?? message?.usage) as Record<string, unknown> | undefined;
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
