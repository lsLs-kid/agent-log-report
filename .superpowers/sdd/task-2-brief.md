## Task 2: Core Types

**Files:**
- Create: `log-sync/src/types.ts`

**Interfaces:**
- Produces: `LogRecord`, `SourceCursor`, `Provider`, `Transport`, `LogSyncError`, `SyncOptions`.

- [ ] **Step 1: Write types.ts**

Create `log-sync/src/types.ts`:

```typescript
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
}

export interface NormalizedRecord {
  recordType?: string;
  role?: 'user' | 'assistant' | 'system' | 'tool';
  timestamp?: string;
  model?: string;
  tokenUsage?: TokenUsage;
  [key: string]: unknown;
}

export interface LogRecord {
  provider: 'claude-code' | 'code-agent-3x' | 'opencode';
  sourcePath: string;
  sessionId: string;
  syncedAt: string;
  raw: string;
  normalized: NormalizedRecord;
}

export interface SourceCursor {
  provider: string;
  sessionId: string;
  sourcePath: string;
  type: 'jsonl' | 'sqlite-table';
  position: number;
}

export interface Provider {
  listSources(): Promise<SourceCursor[]>;
  read(cursor: SourceCursor): Promise<{ records: LogRecord[]; nextCursor: SourceCursor }>;
}

export interface Transport {
  send(records: LogRecord[]): Promise<void>;
}

export class LogSyncError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LogSyncError';
  }
}

export interface SyncOptions {
  batchSize: number;
  dryRun: boolean;
  verbose: boolean;
}
```

- [ ] **Step 2: Verify types compile**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds with no output.

---

