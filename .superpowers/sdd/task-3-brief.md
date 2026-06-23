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

