import { Kafka, Producer, Partitioners } from 'kafkajs';
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
      await this.producer.send({
        topic: this.topic,
        messages: records.map((r) => ({
          key: r.sessionId,
          value: JSON.stringify(r),
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
}
