import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonlProvider } from '../src/providers/jsonl.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-malformed-'));
const encodedCwd = path.join(tmpDir, 'encoded-cwd');
fs.mkdirSync(encodedCwd, { recursive: true });

const sessionFile = path.join(encodedCwd, 'session-1.jsonl');
// Good line, then malformed line, then another good line
// File ends with newline, so split('\n') gives 4 lines (last one empty)
const content =
  '{"type":"user","message":{"role":"user","content":"hello"}}\n' +
  'this is not json\n' +
  '{"type":"assistant","message":{"role":"assistant","content":"world"}}\n';
fs.writeFileSync(sessionFile, content);

const provider = new JsonlProvider({ providerId: 'claude-code', root: tmpDir });

(async () => {
  const sources = await provider.listSources();
  console.log('sources:', sources.length);

  const cursor = sources[0];
  const result1 = await provider.read(cursor);
  console.log('first read records:', result1.records.length);
  console.log('first read position:', result1.nextCursor.position);

  // The malformed line should NOT advance the watermark.
  // Lines: good(59+1=60) + malformed(16+1=17) + good(69+1=70) + empty(0)
  // The two good lines should be consumed: 60 + 70 = 130
  // The malformed line should be skipped: not included in consumed
  const expectedPos = 130;
  console.log('expected position:', expectedPos);

  if (result1.nextCursor.position === expectedPos) {
    console.log('PASS: watermark stopped at malformed line, consumed good lines after it');
  } else {
    console.log('FAIL: watermark at', result1.nextCursor.position, 'expected', expectedPos);
    process.exit(1);
  }

  // Verify the malformed line was truly skipped (not in records)
  if (result1.records.length === 2) {
    console.log('PASS: got 2 records (malformed line excluded)');
  } else {
    console.log('FAIL: got', result1.records.length, 'records');
    process.exit(1);
  }

  // Verify record types
  if (result1.records[0].normalized.recordType === 'user' &&
      result1.records[1].normalized.recordType === 'assistant') {
    console.log('PASS: records are user then assistant');
  } else {
    console.log('FAIL: record types are', result1.records.map(r => r.normalized.recordType));
    process.exit(1);
  }

  // Now simulate a new line being appended (still incomplete, no trailing newline)
  fs.appendFileSync(sessionFile, '{"type":"tool_result"}');

  const result2 = await provider.read(result1.nextCursor);
  console.log('second read records:', result2.records.length);
  console.log('second read position:', result2.nextCursor.position);

  // The incomplete last line should NOT advance watermark
  if (result2.nextCursor.position === expectedPos) {
    console.log('PASS: watermark did not advance past incomplete last line');
  } else {
    console.log('FAIL: watermark advanced to', result2.nextCursor.position);
    process.exit(1);
  }

  // Now complete the line with a newline
  fs.appendFileSync(sessionFile, '\n');

  const result3 = await provider.read(result2.nextCursor);
  console.log('third read records:', result3.records.length);
  console.log('third read position:', result3.nextCursor.position);

  if (result3.records.length === 1 && result3.records[0].normalized.recordType === 'tool_result') {
    console.log('PASS: third read got the tool_result record');
  } else {
    console.log('FAIL: third read did not get tool_result record');
    process.exit(1);
  }

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('All malformed-line watermark tests passed!');
})();
