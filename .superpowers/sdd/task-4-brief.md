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

