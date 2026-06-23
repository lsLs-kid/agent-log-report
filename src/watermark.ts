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

  static defaultPath(): string {
    return path.join(os.homedir(), '.config', 'log-sync', 'watermark.json');
  }

  constructor(private readonly filePath: string) {}

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
