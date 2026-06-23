import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { OpencodeProvider } from '../src/providers/opencode.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-opencode-'));
const dbPath = path.join(tmpDir, 'opencode.db');

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE session (id INTEGER PRIMARY KEY, title TEXT, time_created TEXT);
  CREATE TABLE message (id INTEGER PRIMARY KEY, role TEXT, session_id INTEGER, time_created TEXT, data TEXT);
  CREATE TABLE part (id INTEGER PRIMARY KEY, message_id INTEGER, type TEXT, time_created TEXT, data TEXT);

  INSERT INTO session (id, title, time_created) VALUES (1, 'test', '2024-01-01T00:00:00Z');
  INSERT INTO message (id, role, session_id, time_created, data) VALUES (1, 'user', 1, '2024-01-01T00:00:01Z', '{"text":"hello"}');
`);
db.close();

(async () => {
  const provider = new OpencodeProvider({ dbPath });
  const sources = await provider.listSources();
  console.log('sources:', sources.length);

  for (const src of sources) {
    const { records, nextCursor } = await provider.read(src);
    console.log(src.sourcePath, 'records:', records.length, 'next:', nextCursor.position);
    if (records.length > 0) {
      console.log(JSON.stringify(records[0], null, 2));
    }
  }
})();
