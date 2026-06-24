import process from 'node:process';
import { WatermarkStore } from './watermark.js';
import { createProvider } from './factory.js';
import { sync } from './sync.js';
import { LogSyncError } from './types.js';
import type { SourceCursor } from './types.js';

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
  --transport          http | kafka
  --target             HTTP endpoint or comma-separated Kafka brokers
  --topic              Kafka topic (required when transport is kafka)
  --root               Override default log root / db path
  --watermark-file     Watermark file path (default: ~/.config/log-sync/watermark.json)
  --batch-size         Records per batch (default: 100)
  --user-id            Employee ID to attach to each record
  --dry-run            Print what would be sent without sending
  --verbose            Print progress
  --help               Show this help

Examples:
  log-sync --provider claude-code --transport http --target http://localhost:3000/logs
  log-sync --provider claude-code --transport kafka --target 192.168.1.10:9092,192.168.1.11:9092,192.168.1.12:9092 --topic agent-logs
  log-sync --provider opencode --transport kafka --target 127.0.0.1:9092 --topic agent-logs --user-id u123456
`.trim();
}

function initialPosition(cursor: SourceCursor, watermark: WatermarkStore): number {
  const entry = watermark.get(cursor);
  return cursor.type === 'jsonl' ? entry.lastOffset : (entry.lastRowId ?? 0);
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

  const rawBatchSize = args['batch-size'] as string | undefined;
  const batchSize = rawBatchSize ? parseInt(rawBatchSize, 10) : 100;
  const dryRun = !!args['dry-run'];
  const verbose = !!args.verbose;
  const watermarkFile = (args['watermark-file'] as string | undefined) ?? WatermarkStore.defaultPath();

  if (dryRun) {
    const watermark = new WatermarkStore(watermarkFile);
    watermark.load();
    const provider = createProvider(providerId, args.root as string | undefined, batchSize, watermark, args['user-id'] as string | undefined);
    const sources = await provider.listSources();
    if (verbose) console.error(`Found ${sources.length} source(s) for provider ${providerId}`);
    for (const cursor of sources) {
      let current = { ...cursor, position: initialPosition(cursor, watermark) };
      let total = 0;
      while (true) {
        const { records, nextCursor } = await provider.read(current);
        if (records.length === 0) break;
        console.log(`Would send ${records.length} records from ${cursor.sourcePath}`);
        total += records.length;
        current = nextCursor;
        if (records.length < batchSize) break;
      }
      if (verbose) console.error(`Synced ${total} records from ${cursor.sourcePath}`);
    }
    if (verbose) console.error('Sync complete');
    process.exit(0);
  }

  const result = await sync({
    provider: providerId,
    transport: transportId,
    target,
    topic: args.topic as string | undefined,
    root: args.root as string | undefined,
    watermarkFile,
    batchSize,
    userId: args['user-id'] as string | undefined,
  });

  if (verbose) {
    console.error(`Synced ${result.totalSent} record(s) total`);
    for (const e of result.errors) {
      console.error(`  Failed ${e.sourcePath}: ${e.error instanceof Error ? e.error.message : String(e.error)}`);
    }
    console.error('Sync complete');
  }

  if (result.errors.length > 0) {
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof LogSyncError) {
    console.error(`Error [${err.code}]: ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
