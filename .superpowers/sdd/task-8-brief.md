## Task 8: CLI Entry

**Files:**
- Create: `log-sync/src/index.ts`
- Create: `log-sync/src/factory.ts`

**Interfaces:**
- Consumes: `Provider`, `Transport`, `WatermarkStore`, `SyncOptions`.
- Produces: working CLI.

- [ ] **Step 1: Write factory.ts**

Create `log-sync/src/factory.ts`:

```typescript
import type { Provider, Transport } from './types.js';
import { JsonlProvider } from './providers/jsonl.js';
import { OpencodeProvider } from './providers/opencode.js';
import { HttpTransport } from './transports/http.js';
import { DbTransport } from './transports/db.js';
import { LogSyncError } from './types.js';

export function createProvider(providerId: string, root?: string): Provider {
  switch (providerId) {
    case 'claude-code':
      return new JsonlProvider({
        providerId,
        root: root ?? '~/.claude/projects',
      });
    case 'code-agent-3x':
      return new JsonlProvider({
        providerId,
        root: root ?? '~/.cac/projects',
      });
    case 'opencode':
      return new OpencodeProvider({
        dbPath: root ?? '~/.local/share/opencode/opencode.db',
      });
    default:
      throw new LogSyncError(`Unknown provider: ${providerId}`, 'UNKNOWN_PROVIDER');
  }
}

export function createTransport(transportId: string, target: string): Transport {
  switch (transportId) {
    case 'http':
      return new HttpTransport({ endpoint: target });
    case 'db':
      return new DbTransport({ url: target });
    default:
      throw new LogSyncError(`Unknown transport: ${transportId}`, 'UNKNOWN_TRANSPORT');
  }
}
```

- [ ] **Step 2: Write index.ts**

Create `log-sync/src/index.ts`:

```typescript
import process from 'node:process';
import { WatermarkStore } from './watermark.js';
import { createProvider, createTransport } from './factory.js';
import type { SourceCursor } from './types.js';
import { LogSyncError } from './types.js';

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const parsed: Record<string, string | boolean | undefined> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i++;
    } else {
      parsed[key] = true;
    }
  }

  return parsed;
}

function usage(): string {
  return `
Usage: log-sync --provider <provider> --transport <transport> --target <target> [options]

Options:
  --provider           claude-code | code-agent-3x | opencode
  --transport          http | db
  --target             HTTP endpoint or DB connection URL
  --root               Override default log root / db path
  --watermark-file     Watermark file path (default: ~/.config/log-sync/watermark.json)
  --batch-size         Records per batch (default: 100)
  --dry-run            Print what would be sent without sending
  --verbose            Print progress
  --help               Show this help
`.trim();
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const providerId = args.provider as string | undefined;
  const transportId = args.transport as string | undefined;
  const target = args.target as string | undefined;

  if (!providerId || !transportId || !target) {
    console.error('Error: --provider, --transport, and --target are required');
    console.error(usage());
    process.exit(1);
  }

  const batchSize = parseInt(args['batch-size'] as string, 10) || 100;
  const dryRun = !!args['dry-run'];
  const verbose = !!args.verbose;
  const root = args.root as string | undefined;
  const watermarkFile = (args['watermark-file'] as string) ?? undefined;

  const provider = createProvider(providerId, root);
  const transport = createTransport(transportId, target as string);
  const watermark = new WatermarkStore(watermarkFile ?? new WatermarkStore('').defaultPath);
  watermark.load();

  const sources = await provider.listSources();
  if (verbose) {
    console.error(`Found ${sources.length} source(s) for provider ${providerId}`);
  }

  const failed: { cursor: SourceCursor; error: unknown }[] = [];

  for (const cursor of sources) {
    try {
      await syncSource(provider, transport, watermark, cursor, { batchSize, dryRun, verbose });
    } catch (err) {
      failed.push({ cursor, error: err });
      console.error(`Failed to sync ${cursor.sourcePath}:`, err instanceof Error ? err.message : String(err));
    }
  }

  watermark.save();

  if (failed.length > 0) {
    console.error(`\n${failed.length} source(s) failed`);
    process.exit(2);
  }

  if (verbose) {
    console.error('Sync complete');
  }
}

async function syncSource(
  provider: ReturnType<typeof createProvider>,
  transport: ReturnType<typeof createTransport>,
  watermark: WatermarkStore,
  cursor: SourceCursor,
  opts: { batchSize: number; dryRun: boolean; verbose: boolean },
) {
  let current = { ...cursor, position: watermark.get(cursor).lastOffset || watermark.get(cursor).lastRowId || 0 };

  if (cursor.type === 'jsonl') {
    const { createReadStream } = await import('node:fs');
    const { statSync } = await import('node:fs');
    const size = statSync(cursor.sourcePath).size;
    if (watermark.resetIfNeeded(cursor, size)) {
      current = { ...cursor, position: 0 };
      if (opts.verbose) console.error(`Reset watermark for ${cursor.sourcePath} (file shrank)`);
    }
  }

  let total = 0;
  while (true) {
    const { records, nextCursor } = await provider.read(current);
    if (records.length === 0) break;

    if (opts.dryRun) {
      console.log(`Would send ${records.length} records from ${cursor.sourcePath}`);
    } else {
      await transport.send(records);
      watermark.set(nextCursor, nextCursor.position);
    }

    total += records.length;
    current = nextCursor;

    if (records.length < opts.batchSize) break;
  }

  if (opts.verbose) {
    console.error(`Synced ${total} records from ${cursor.sourcePath}`);
  }
}

main().catch((err) => {
  if (err instanceof LogSyncError) {
    console.error(`Error [${err.code}]: ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
```

- [ ] **Step 3: Test CLI help**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx src/index.ts --help
```

Expected: prints usage and exits 0.

- [ ] **Step 4: Test CLI dry-run**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx src/index.ts --provider claude-code --transport http --target http://localhost:39999 --dry-run
```

Expected: if local claude logs exist, prints "Would send N records from ..." without making network calls.

- [ ] **Step 5: Verify TypeScript**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsc --noEmit
```

Expected: succeeds.

---

