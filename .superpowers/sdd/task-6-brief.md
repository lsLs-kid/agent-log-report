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

