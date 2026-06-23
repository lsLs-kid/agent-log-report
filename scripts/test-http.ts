import http from 'node:http';
import { HttpTransport } from '../src/transports/http.js';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    console.log('received', parsed.length, 'records');
    res.writeHead(200);
    res.end('ok');
  });
});

server.listen(39999, async () => {
  const transport = new HttpTransport({ endpoint: 'http://localhost:39999' });
  await transport.send([
    {
      provider: 'claude-code',
      sourcePath: '/tmp/x.jsonl',
      sessionId: 's1',
      syncedAt: new Date().toISOString(),
      raw: '{}',
      normalized: {},
    },
  ]);
  server.close();
});
