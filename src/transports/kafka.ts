import { Kafka, Producer, Partitioners, CompressionTypes } from 'kafkajs';
import type { LogRecord, Transport } from '../types.js';
import { LogSyncError } from '../types.js';

export interface KafkaTransportOptions {
  brokers: string[];
  topic: string;
}

export class KafkaTransport implements Transport {
  private kafka: Kafka;
  private producer: Producer;
  private topic: string;

  constructor(private readonly opts: KafkaTransportOptions) {
    this.topic = opts.topic;
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

      const failed: { sessionId: string; error: unknown }[] = [];

      for (const r of records) {
        try {
          await this.producer.send({
            topic: this.topic,
            compression: CompressionTypes.GZIP,
            messages: [{ key: r.sessionId, value: JSON.stringify(r) }],
          });
        } catch (err) {
          failed.push({ sessionId: r.sessionId, error: err });
          console.error(
            `[kafka] failed to send session ${r.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (failed.length > 0 && failed.length === records.length) {
        // All failed — surface as error so the caller knows nothing went through
        throw new LogSyncError(
          `All ${records.length} record(s) failed to send`,
          'KAFKA_ALL_FAILED',
        );
      }
      // Partial failure: already logged per-record, remaining records sent OK
    } catch (err) {
      if (err instanceof LogSyncError) throw err;
      throw new LogSyncError(
        `Failed to send to Kafka: ${err instanceof Error ? err.message : String(err)}`,
        'KAFKA_ERROR',
        err,
      );
    } finally {
      await this.producer.disconnect().catch(() => {});
    }
  }
}
