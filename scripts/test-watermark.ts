import { WatermarkStore } from '../src/watermark.js';
import fs from 'node:fs';
import os from 'node:path';

const tmp = '/tmp/log-sync-watermark-test.json';
if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

const store = new WatermarkStore(tmp);
store.load();

const cursor = {
  provider: 'claude-code',
  sessionId: 's1',
  sourcePath: '/tmp/test.jsonl',
  type: 'jsonl' as const,
  position: 0,
};

console.log('initial:', store.get(cursor));
store.set(cursor, 123);
store.save();

const store2 = new WatermarkStore(tmp);
store2.load();
console.log('reloaded:', store2.get(cursor));

const reset = store2.resetIfNeeded(cursor, 50);
console.log('reset triggered:', reset);
console.log('after reset:', store2.get(cursor));
