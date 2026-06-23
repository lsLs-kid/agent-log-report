## Task 9: Build and Final Verification

**Files:**
- Modify: `log-sync/package.json` (add `bin` build output path if needed)

- [ ] **Step 1: Build the project**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npm run build
```

Expected: creates `log-sync/dist/` with compiled JS files.

- [ ] **Step 2: Run compiled CLI help**

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
node dist/index.js --help
```

Expected: prints usage.

- [ ] **Step 3: End-to-end test with HTTP server**

Create `log-sync/scripts/e2e-http.ts`:

```typescript
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
```

Run:

```bash
cd /Users/shen/code/work/aaa/log-sync
npx tsx scripts/e2e-http.ts
```

Expected output:

```
Found 1 source(s) for provider claude-code
Synced 1 records from ...
E2E received 1 records
{ recordType: 'user', role: 'user' }
exit code: 0
```

- [ ] **Step 4: Confirm git status excludes the new folder**

Run:

```bash
cd /Users/shen/code/work/aaa
git status --short
```

Expected: only `docs/superpowers/specs/...` and `docs/superpowers/plans/...` appear (the parent repo docs), and `log-sync/` is untracked but should not be committed. If you want to keep it truly out of the repo, add `log-sync/` to the root `.gitignore` or leave it untracked.

---

## Spec Coverage Check

| Spec Requirement | Task |
|------------------|------|
| Standalone `log-sync/` subfolder | Task 1 |
| Not committed to git | Task 9 Step 4 note |
| Three providers | Task 4 (jsonl), Task 5 (opencode) |
| HTTP transport | Task 6 |
| DB transport | Task 7 |
| Unified `LogRecord` with raw + normalized | Task 2 |
| Watermark file default path | Task 3 |
| JSONL byte offset incrementality | Task 4 |
| opencode row-id incrementality | Task 5 |
| CLI arguments | Task 8 |
| Exit codes | Task 8 |
| Per-source watermark update only on success | Task 8 `syncSource` |

## Placeholder Scan

No TBD, TODO, or vague steps. Every step includes exact file path and full code.

## Type Consistency Check

- `LogRecord`, `SourceCursor`, `Provider`, `Transport` defined in Task 2 and used unchanged in all later tasks.
- `WatermarkStore.set(cursor, position)` and `WatermarkEntry` fields match usage in Task 3 and Task 8.
- `JsonlProvider` and `OpencodeProvider` both implement `Provider` interface from Task 2.
- `HttpTransport` and `DbTransport` both implement `Transport` interface from Task 2.
