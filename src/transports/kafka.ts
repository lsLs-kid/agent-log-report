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
  private connected = false;

  constructor(private readonly opts: KafkaTransportOptions) {
    this.topic = opts.topic;
    this.kafka = new Kafka({
      clientId: 'log-sync',
      brokers: opts.brokers,
      ssl: false,
      sasl: undefined,
      retry: { retries: 0 },
    });
    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  async send(records: LogRecord[]): Promise<void> {
    if (records.length === 0) return;

    try {
      await this.ensureConnected();

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
          this.logSendError(r, err);
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
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.producer.disconnect().catch(() => {});
    this.connected = false;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
  }

  private logSendError(record: LogRecord, err: unknown): void {
    const kafkaErr = err as { type?: string; code?: number } | undefined;
    const isTooLarge =
      kafkaErr?.type === 'MESSAGE_TOO_LARGE' ||
      kafkaErr?.type === 'RECORD_LIST_TOO_LARGE' ||
      kafkaErr?.code === 10 ||
      kafkaErr?.code === 18;

    if (isTooLarge) {
      const size = Buffer.byteLength(JSON.stringify(record), 'utf8');
      const mb = (size / 1024 / 1024).toFixed(2);
      console.error(
        `[kafka] record for session ${record.sessionId} is too large (${size} bytes, ${mb} MB). Increase broker 'message.max.bytes' to at least ${Math.ceil(size / 1024 / 1024)} MB.`,
      );
      return;
    }

    console.error(
      `[kafka] failed to send session ${record.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
