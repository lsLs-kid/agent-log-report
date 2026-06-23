import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonlProvider } from '../src/providers/jsonl.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-jsonl-'));
const cwdDir = path.join(tmpRoot, 'encoded-cwd');
fs.mkdirSync(cwdDir, { recursive: true });

const sessionFile = path.join(cwdDir, 'session-1.jsonl');
fs.writeFileSync(
  sessionFile,
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n' +
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' }, usage: { input_tokens: 10, output_tokens: 5 } }) + '\n',
);

const provider = new JsonlProvider({ providerId: 'claude-code', root: tmpRoot });

(async () => {
  const sources = await provider.listSources();
  console.log('sources:', sources.length);
  const { records, nextCursor } = await provider.read(sources[0]);
  console.log('records:', records.length);
  console.log(JSON.stringify(records[0], null, 2));
  console.log('next position:', nextCursor.position);

  // second read should be empty
  const second = await provider.read(nextCursor);
  console.log('second records:', second.records.length);
})();
