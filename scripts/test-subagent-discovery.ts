import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonlProvider } from '../src/providers/jsonl.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-subagent-'));
const encodedCwd = path.join(tmpDir, 'encoded-cwd');
const subagentsDir = path.join(encodedCwd, 'subagents');
fs.mkdirSync(subagentsDir, { recursive: true });

const mainFile = path.join(encodedCwd, 'main.jsonl');
fs.writeFileSync(mainFile, '{"type":"user"}\n');

const subagentFile = path.join(subagentsDir, 'agent-1.jsonl');
fs.writeFileSync(subagentFile, '{"type":"assistant"}\n');

const provider = new JsonlProvider({ providerId: 'claude-code', root: tmpDir });

(async () => {
  const sources = await provider.listSources();
  console.log('sources found:', sources.length);
  for (const s of sources) {
    console.log('  -', s.sessionId, '@', s.sourcePath);
  }

  const mainSource = sources.find(s => s.sessionId === 'main');
  const subagentSource = sources.find(s => s.sessionId === 'agent-1');

  if (!mainSource) {
    console.log('FAIL: main source not found');
    process.exit(1);
  }
  if (!subagentSource) {
    console.log('FAIL: subagent source not found');
    process.exit(1);
  }
  if (!subagentSource.sourcePath.includes('subagents')) {
    console.log('FAIL: subagent path does not include subagents dir:', subagentSource.sourcePath);
    process.exit(1);
  }

  // Verify the subagent file is actually readable
  const readResult = await provider.read(subagentSource);
  if (readResult.records.length !== 1) {
    console.log('FAIL: subagent read returned', readResult.records.length, 'records');
    process.exit(1);
  }

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('All subagent discovery tests passed!');
})();
