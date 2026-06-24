import { WatermarkStore } from './watermark.js';
import { createProvider, createTransport } from './factory.js';
import type { Provider, Transport, SourceCursor } from './types.js';

export interface SyncConfig {
  /** claude-code | code-agent-3x | opencode */
  provider: string;
  /** http | db | kafka */
  transport: string;
  /** HTTP endpoint, DB URL, or comma-separated Kafka brokers */
  target: string;
  /** Kafka topic (required when transport is kafka) */
  topic?: string;
  /** Override default log root / db path */
  root?: string;
  /** Watermark file path (default: ~/.config/log-sync/watermark.json) */
  watermarkFile?: string;
  /** Records per batch (default: 100) */
  batchSize?: number;
}

export interface SyncResult {
  /** Total records sent across all sources */
  totalSent: number;
  /** Sources that failed, with their errors */
  errors: { sourcePath: string; error: unknown }[];
}

/**
 * Run an incremental sync. Safe to call on every session idle — only new
 * records since the last run are sent, watermarks are persisted after each
 * source.
 */
export async function sync(config: SyncConfig): Promise<SyncResult> {
  const batchSize = config.batchSize ?? 100;
  const watermarkFile = config.watermarkFile ?? WatermarkStore.defaultPath();

  const watermark = new WatermarkStore(watermarkFile);
  watermark.load();

  const provider = createProvider(config.provider, config.root, batchSize, watermark);
  const transport = createTransport(config.transport, config.target, {
    batchSize,
    topic: config.topic,
  });

  const sources = await provider.listSources();
  let totalSent = 0;
  const errors: SyncResult['errors'] = [];

  for (const cursor of sources) {
    try {
      const sent = await syncSource(provider, transport, watermark, cursor, batchSize);
      totalSent += sent;
    } catch (err) {
      errors.push({ sourcePath: cursor.sourcePath, error: err });
    }
  }

  return { totalSent, errors };
}

async function syncSource(
  provider: Provider,
  transport: Transport,
  watermark: WatermarkStore,
  cursor: SourceCursor,
  batchSize: number,
): Promise<number> {
  let current = { ...cursor, position: getInitialPosition(cursor, watermark) };

  if (cursor.type === 'jsonl') {
    const { statSync } = await import('node:fs');
    const size = statSync(cursor.sourcePath).size;
    if (watermark.resetIfNeeded(cursor, size)) {
      current = { ...cursor, position: 0 };
    }
  }

  let total = 0;
  while (true) {
    const { records, nextCursor } = await provider.read(current);
    if (records.length === 0) break;

    await transport.send(records);
    // Commit watermark only after successful send
    watermark.set(nextCursor, nextCursor.position);
    if (nextCursor.extra) {
      for (const [key, value] of Object.entries(nextCursor.extra)) {
        watermark.setExtra(nextCursor, key, value);
      }
    }
    watermark.save();
    total += records.length;
    current = nextCursor;

    if (records.length < batchSize) break;
  }

  return total;
}

function getInitialPosition(cursor: SourceCursor, watermark: WatermarkStore): number {
  const entry = watermark.get(cursor);
  return cursor.type === 'jsonl' ? entry.lastOffset : (entry.lastRowId ?? 0);
}
