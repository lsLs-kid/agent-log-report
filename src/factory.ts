import type { Provider, Transport } from './types.js';
import { JsonlProvider } from './providers/jsonl.js';
import { OpencodeProvider } from './providers/opencode.js';
import { HttpTransport } from './transports/http.js';
import { KafkaTransport } from './transports/kafka.js';
import { LogSyncError } from './types.js';
import type { WatermarkStore } from './watermark.js';

export function createProvider(
  providerId: string,
  root?: string,
  batchSize?: number,
  watermark?: WatermarkStore,
): Provider {
  switch (providerId) {
    case 'claude-code':
      return new JsonlProvider({
        providerId,
        root: root ?? '~/.claude/projects',
        batchSize,
      });
    case 'code-agent-3x':
      return new JsonlProvider({
        providerId,
        root: root ?? '~/.cac/projects',
        batchSize,
      });
    case 'opencode': {
      if (!watermark) throw new LogSyncError('opencode provider requires a watermark store', 'MISSING_WATERMARK');
      return new OpencodeProvider({
        dbPath: root ?? '~/.local/share/opencode/db/ngagent.db',
        watermark,
      });
    }
    default:
      throw new LogSyncError(`Unknown provider: ${providerId}`, 'UNKNOWN_PROVIDER');
  }
}

export function createTransport(
  transportId: string,
  target: string,
  opts?: { batchSize?: number; timeoutMs?: number; headers?: Record<string, string>; topic?: string },
): Transport {
  switch (transportId) {
    case 'http':
      return new HttpTransport({
        endpoint: target,
        batchSize: opts?.batchSize,
        timeoutMs: opts?.timeoutMs,
        headers: opts?.headers,
      });
    case 'kafka': {
      // Strip any stray whitespace / CR / invisible chars that Windows shells may inject
      const brokers = target
        .split(',')
        .map((b) => b.replace(/[\r\n\t]/g, '').trim())
        .filter(Boolean);
      if (brokers.length === 0) {
        throw new LogSyncError('Kafka target must be a comma-separated list of brokers', 'INVALID_KAFKA_TARGET');
      }
      // Validate each broker looks like host:port
      for (const b of brokers) {
        const colon = b.lastIndexOf(':');
        const port = colon !== -1 ? Number(b.slice(colon + 1)) : NaN;
        if (colon === -1 || isNaN(port) || port < 1 || port > 65535) {
          throw new LogSyncError(
            `Invalid broker address "${b}" — expected format is host:port (e.g. 192.168.1.1:9092)`,
            'INVALID_KAFKA_BROKER',
          );
        }
      }
      if (!opts?.topic || opts.topic.trim() === '') {
        throw new LogSyncError('Kafka transport requires --topic', 'MISSING_KAFKA_TOPIC');
      }
      return new KafkaTransport({ brokers, topic: opts.topic });
    }
    default:
      throw new LogSyncError(`Unknown transport: ${transportId}`, 'UNKNOWN_TRANSPORT');
  }
}
