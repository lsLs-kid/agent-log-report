import type { Provider, Transport } from './types.js';
import { JsonlProvider } from './providers/jsonl.js';
import { OpencodeProvider } from './providers/opencode.js';
import { HttpTransport } from './transports/http.js';
import { DbTransport } from './transports/db.js';
import { KafkaTransport } from './transports/kafka.js';
import { LogSyncError } from './types.js';

export function createProvider(providerId: string, root?: string, batchSize?: number): Provider {
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
    case 'opencode':
      return new OpencodeProvider({
        dbPath: root ?? '~/.local/share/opencode/opencode.db',
        batchSize,
      });
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
    case 'db':
      return new DbTransport({ url: target });
    case 'kafka': {
      const brokers = target.split(',').map((b) => b.trim()).filter(Boolean);
      if (brokers.length === 0) {
        throw new LogSyncError('Kafka target must be a comma-separated list of brokers', 'INVALID_KAFKA_TARGET');
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
