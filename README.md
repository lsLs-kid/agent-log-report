# agent-log-report

将本地 AI 编码 Agent 的会话日志增量同步到外部目标（Kafka、HTTP 接口、数据库）的 TypeScript 工具库。支持 opencode、Claude Code、Code Agent 3.x 三种 Agent。

---

## 支持的组合

| Agent (provider) | 日志格式 | 默认路径 |
|---|---|---|
| `opencode` | SQLite | `~/.local/share/opencode/db/ngagent.db` |
| `claude-code` | JSONL | `~/.claude/projects/` |
| `code-agent-3x` | JSONL | `~/.cac/projects/` |

| 目标 (transport) | target 格式 |
|---|---|
| `kafka` | 逗号分隔的 `ip:port`，PLAINTEXT，无鉴权 |
| `http` | `https://...`，POST JSON 数组 |
| `db` | `postgres://...` / `mysql://...` / `sqlite:///path` |

---

## 安装依赖

需要 Node.js ≥ 20。

```bash
npm install
```

---

## 两种使用方式

### 方式一：终端命令

适合手动测试和调试。

```bash
# 查看帮助
npx tsx src/index.ts --help

# opencode → Kafka（干跑，不实际发送）
npx tsx src/index.ts \
  --provider opencode \
  --transport kafka \
  --target "10.0.0.1:9092,10.0.0.2:9092,10.0.0.3:9092" \
  --topic agent-logs \
  --dry-run --verbose

# claude-code → HTTP
npx tsx src/index.ts \
  --provider claude-code \
  --transport http \
  --target "https://ingest.example.com/logs"

# opencode → PostgreSQL
npx tsx src/index.ts \
  --provider opencode \
  --transport db \
  --target "postgres://user:pass@localhost:5432/mydb"

# opencode → 本地 SQLite（快速验证）
npx tsx src/index.ts \
  --provider opencode \
  --transport db \
  --target "sqlite:///tmp/test.db" \
  --verbose
```

### 方式二：TS 代码直接调用

适合在 opencode 等 Agent 的 session idle 事件里嵌入调用。

```typescript
import { sync } from './agent-log-report/src/mod.js';

// 在 session idle 回调里触发
const result = await sync({
  provider:  'opencode',
  transport: 'kafka',
  target:    '10.0.0.1:9092,10.0.0.2:9092,10.0.0.3:9092',
  topic:     'agent-logs',
});

// result.totalSent — 本次发出的记录数，0 表示无增量
// result.errors   — 建议 fail-silent，不要让同步错误中断主流程
if (result.errors.length > 0) {
  console.warn('log-sync errors:', result.errors);
}
```

`sync()` 是幂等的：水位持久化在本地文件，每次调用只发上次之后新增的内容，多次调用同一个没有变化的 session 不会重复发送。

---

## 完整参数说明

| TS 字段 (`SyncConfig`) | CLI 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `provider` | `--provider` | ✓ | — | Agent 类型：`opencode` / `claude-code` / `code-agent-3x` |
| `transport` | `--transport` | ✓ | — | 目标类型：`kafka` / `http` / `db` |
| `target` | `--target` | ✓ | — | 目标地址（格式见上表） |
| `topic` | `--topic` | kafka 时必填 | — | Kafka topic 名 |
| `root` | `--root` | 否 | 各 provider 默认路径 | 覆盖日志根目录或 db 文件路径 |
| `watermarkFile` | `--watermark-file` | 否 | `~/.config/log-sync/watermark.json` | 水位文件路径；多实例时各用不同路径互相隔离 |
| `batchSize` | `--batch-size` | 否 | `100` | 每批发送记录数；opencode session 粒度下一般无需调整 |
| — | `--dry-run` | 否 | — | 只打印将发什么，不发送、不更新水位（仅 CLI） |
| — | `--verbose` | 否 | — | 打印进度到 stderr（仅 CLI） |

---

## 发送的数据格式

### opencode

以 **session 为粒度**，每条记录代表一个完整会话（包含所有消息及工具调用）。下游按 `session_id` upsert 覆盖即可，无需在服务端做 JOIN。

```jsonc
{
  "provider": "opencode",
  "sessionId": "ses_xxx",
  "syncedAt": "2025-05-02T10:00:00.000Z",
  "raw": "...",           // 与 normalized 相同的 JSON 字符串
  "normalized": {
    "record_type": "opencode-session",
    "session_id": "ses_xxx",
    "title": "Fix auth bug",
    "cwd": "/Users/dev/myproject",
    "model": "kimi-k2.6",
    "cost_total": 0.042,
    "tokens_total": { "input": 14873, "output": 187, "cache_read": 0, "cache_write": 0, "reasoning": 0 },
    "message_count": 16,
    "messages": [
      {
        "message_id": "msg_xxx",
        "role": "user",
        "timestamp": "2025-05-02T10:00:01.000Z",
        "text_parts": ["请帮我修复认证 bug"],
        "tool_calls": [],
        "reasoning_parts": [],
        "has_patch": false,
        "step_count": 0
      },
      {
        "message_id": "msg_yyy",
        "role": "assistant",
        "model_id": "kimi-k2.6",
        "provider_id": "volcengine-plan",
        "generation_duration_ms": 7775,
        "tokens": { "input": 14873, "output": 187, "total": 15060, ... },
        "tool_calls": [
          {
            "tool_name": "read",
            "call_id": "read:0",
            "status": "completed",
            "input": { "filePath": "/src/auth.ts" },
            "output": "...(截断到 16KB)",
            "is_error": false
          }
        ],
        "reasoning_parts": [{ "text": "...", "duration_ms": 2196 }],
        "text_parts": ["已修复，改动如下..."],
        "has_patch": true,
        "step_count": 3
      }
    ]
  }
}
```

### claude-code / code-agent-3x

以 **消息行为粒度**，每条 JSONL 行对应一条记录。`normalized` 提取了 `role`、`timestamp`、`model`、`tokenUsage`，`raw` 保留原始行内容。

---

## 增量同步原理

- **JSONL**（claude-code / code-agent-3x）：记录每个文件的字节偏移量，下次从上次结束位置继续读；仅处理完整行，末尾未完成的行等下次再读；文件缩小时自动重置（日志轮转场景）。
- **opencode**：用 SQLite `rowid`（不是 text 类型的 id 字段）做水位，分别追踪 message 表和 part 表的最大 rowid，下次只查找有新内容的 session，重新组装完整 session 文档后发送。

水位默认持久化到 `~/.config/log-sync/watermark.json`，通过 `--watermark-file` 可以指定其他路径（多个 Agent 实例时隔离各自的水位）。

---

## 目标端建表说明（db transport）

首次发送时自动建表，表名默认为 `log_sync_records`，结构：

```sql
-- PostgreSQL / MySQL 示意
CREATE TABLE log_sync_records (
  id          BIGSERIAL PRIMARY KEY,
  provider    TEXT NOT NULL,
  source_path TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  synced_at   TIMESTAMPTZ NOT NULL,
  raw         JSONB NOT NULL,       -- MySQL: JSON
  normalized  JSONB                 -- MySQL: JSON
);
-- 自动创建索引：(provider, session_id) 和 (synced_at)
```

opencode 以 session 粒度发送，下游若要实现 upsert，在 `session_id` 上加唯一约束后改用 `INSERT ... ON CONFLICT DO UPDATE` 即可；默认是 append 写入（每次变化追加一条新记录）。

---

## 开发

```bash
# 类型检查
npm run lint

# 构建到 dist/（生产部署时用）
npm run build
```
