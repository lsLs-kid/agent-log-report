import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DbTransport } from '../src/transports/db.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-db-'));
const dbUrl = `sqlite://${path.join(tmp, 'target.db')}`;

(async () => {
  const transport = new DbTransport({ url: dbUrl });
  await transport.send([
    {
      provider: 'claude-code',
      sourcePath: '/tmp/x.jsonl',
      sessionId: 's1',
      syncedAt: new Date().toISOString(),
      raw: '{}',
      normalized: { recordType: 'user' },
    },
  ]);
  console.log('sqlite transport ok');
})();
