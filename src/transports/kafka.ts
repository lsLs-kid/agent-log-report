import { Kafka, Producer, Partitioners, CompressionTypes } from 'kafkajs';
import type { LogRecord, Transport } from '../types.js';
import type { OpenCodeSessionDoc } from '../types.js';
import { LogSyncError } from '../types.js';

export interface KafkaTransportOptions {
  brokers: string[];
  topic: string;
  /** Max serialized bytes per message before trimming tool_output (default: 900_000) */
  maxMessageBytes?: number;
}

// Safety margin below broker max.message.bytes (default 1MB).
// GZIP typically gives 80-90% compression on JSON, but we trim before
// compression so the uncompressed JSON stays under this limit.
const DEFAULT_MAX_BYTES = 900_000;
const TRIM_OUTPUT_TO = 512; // chars, just enough to identify the tool call

export class KafkaTransport implements Transport {
  private kafka: Kafka;
  private producer: Producer;
  private topic: string;
  private maxMessageBytes: number;

  constructor(private readonly opts: KafkaTransportOptions) {
    this.topic = opts.topic;
    this.maxMessageBytes = opts.maxMessageBytes ?? DEFAULT_MAX_BYTES;
    this.kafka = new Kafka({
      clientId: 'log-sync',
      brokers: opts.brokers,
      ssl: false,
      sasl: undefined,
    });
    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  async send(records: LogRecord[]): Promise<void> {
    if (records.length === 0) return;

    try {
      await this.producer.connect();
      await this.producer.send({
        topic: this.topic,
        compression: CompressionTypes.GZIP,
        messages: records.map((r) => ({
          key: r.sessionId,
          value: this.serialize(r),
        })),
      });
    } catch (err) {
      throw new LogSyncError(
        `Failed to send to Kafka: ${err instanceof Error ? err.message : String(err)}`,
        'KAFKA_ERROR',
        err,
      );
    } finally {
      await this.producer.disconnect().catch(() => {});
    }
  }

  private serialize(record: LogRecord): string {
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json, 'utf8') <= this.maxMessageBytes) return json;

    // Message too large — trim tool_output fields and retry
    const trimmed = trimRecord(record);
    return JSON.stringify(trimmed);
  }
}

function trimRecord(record: LogRecord): LogRecord {
  const normalized = record.normalized as unknown as OpenCodeSessionDoc;
  if (normalized?.record_type !== 'opencode-session') return record;

  const messages = normalized.messages.map((msg) => ({
    ...msg,
    tool_calls: msg.tool_calls.map((tc) => ({
      ...tc,
      output: tc.output != null
        ? tc.output.slice(0, TRIM_OUTPUT_TO) + (tc.output.length > TRIM_OUTPUT_TO ? '…[trimmed]' : '')
        : tc.output,
    })),
  }));

  const trimmedDoc: OpenCodeSessionDoc = { ...normalized, messages };
  const raw = JSON.stringify(trimmedDoc);
  return { ...record, raw, normalized: trimmedDoc as unknown as typeof record.normalized };
}
