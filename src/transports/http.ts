import type { LogRecord, Transport } from '../types.js';
import { LogSyncError } from '../types.js';

export interface HttpTransportOptions {
  endpoint: string;
  headers?: Record<string, string>;
  batchSize?: number;
  timeoutMs?: number;
}

export class HttpTransport implements Transport {
  private batchSize: number;
  private timeoutMs: number;

  constructor(private readonly opts: HttpTransportOptions) {
    this.batchSize = opts.batchSize ?? 100;
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  async send(records: LogRecord[]): Promise<void> {
    for (let i = 0; i < records.length; i += this.batchSize) {
      const batch = records.slice(i, i + this.batchSize);
      await this.sendBatch(batch);
    }
  }

  private async sendBatch(batch: LogRecord[]): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.opts.headers,
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new LogSyncError(
          `HTTP ${response.status}: ${response.statusText}. ${body.slice(0, 200)}`,
          'HTTP_ERROR',
        );
      }
    } catch (err) {
      if (err instanceof LogSyncError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LogSyncError(`HTTP request timed out after ${this.timeoutMs}ms`, 'HTTP_TIMEOUT');
      }
      throw new LogSyncError(
        `Failed to send batch: ${err instanceof Error ? err.message : String(err)}`,
        'HTTP_ERROR',
        err,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
