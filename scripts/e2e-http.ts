import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-sync-e2e-'));
const cwdDir = path.join(tmpRoot, 'cwd');
fs.mkdirSync(cwdDir, { recursive: true });
fs.writeFileSync(
  path.join(cwdDir, 'session.jsonl'),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n',
);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const records = JSON.parse(body);
    console.log('E2E received', records.length, 'records');
    console.log(records[0]?.normalized);
    res.writeHead(200);
    res.end('ok');
  });
});

server.listen(39998, () => {
  const child = spawn('node', [
    'dist/index.js',
    '--provider', 'claude-code',
    '--transport', 'http',
    '--target', 'http://localhost:39998',
    '--root', tmpRoot,
    '--watermark-file', path.join(tmpRoot, 'watermark.json'),
    '--verbose',
  ], {
    cwd: '/Users/shen/code/work/aaa/log-sync',
    stdio: 'inherit',
  });

  child.on('close', (code) => {
    console.log('exit code:', code);
    server.close();
  });
});
