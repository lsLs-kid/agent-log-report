# agent-log-report

将本地 AI 编码 Agent 的会话日志增量同步到外部目标（Kafka、HTTP 接口）的 TypeScript 工具库。支持 opencode、Claude Code、Code Agent 3.x 三种 Agent。

---

## 支持的组合

| Agent (provider) | 日志格式 | 默认路径 |
|---|---|---|
| `opencode` | SQLite | `~/.local/share/opencode/opencode.db` 和 `~/.local/share/opencode/db/ngagent.db`（自动发现） |
| `claude-code` | JSONL | `~/.claude/projects/` |
| `code-agent-3x` | JSONL | `~/.cac/projects/` |

| 目标 (transport) | target 格式 |
|---|---|
| `kafka` | 逗号分隔的 `ip:port`，PLAINTEXT，无鉴权，GZIP 压缩 |
| `http` | `https://...`，POST JSON 数组 |

---

## 安装依赖

需要 Node.js ≥ 20。`sqlite3` 是原生 Node 绑定，用于读取 opencode 的 SQLite 数据库（支持 WAL 模式）。安装时会尝试下载预编译二进制，如果平台没有预编译包，需要本地有 C++ 编译工具链。

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

# opencode → Kafka（干跑，不实际发送，不更新水位）
npx tsx src/index.ts \
  --provider opencode \
  --transport kafka \
  --target "10.0.0.1:9092,10.0.0.2:9092,10.0.0.3:9092" \
  --topic agent-logs \
  --user-id u123456 \
  --dry-run --verbose

# claude-code → HTTP
npx tsx src/index.ts \
  --provider claude-code \
  --transport http \
  --target "https://ingest.example.com/logs"
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
  userId:    'u123456',
});

// result.totalSent — 本次发出的记录数，0 表示无增量
// result.errors   — 建议 fail-silent，不要让同步错误中断主流程
if (result.errors.length > 0) {
  console.warn('log-sync errors:', result.errors);
}
```

`sync()` 是幂等的：水位在每次成功发送后立即落盘，发送失败不更新水位，下次调用会重试同样的数据。

---

## 完整参数说明

| TS 字段 (`SyncConfig`) | CLI 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `provider` | `--provider` | ✓ | — | Agent 类型：`opencode` / `claude-code` / `code-agent-3x` |
| `transport` | `--transport` | ✓ | — | 目标类型：`kafka` / `http` |
| `target` | `--target` | ✓ | — | 目标地址（格式见上表） |
| `topic` | `--topic` | kafka 时必填 | — | Kafka topic 名 |
| `userId` | `--user-id` | 否 | — | 用户工号，会附加到每条记录 |
| `root` | `--root` | 否 | opencode 自动发现两个默认 db；其他见上表 | 覆盖日志根目录或 db 文件路径；opencode 指定后只读该路径 |
| `watermarkFile` | `--watermark-file` | 否 | `~/.config/log-sync/watermark.json` | 水位文件路径；多实例时各用不同路径互相隔离 |
| `batchSize` | `--batch-size` | 否 | `100` | 每批发送记录数；opencode session 粒度下一般无需调整 |
| — | `--dry-run` | 否 | — | 只打印将发什么，不发送、不更新水位（仅 CLI） |
| — | `--verbose` | 否 | — | 打印进度到 stderr（仅 CLI） |

---

## 发送的数据格式

每条 Kafka / HTTP 记录的结构：

```jsonc
{
  "provider": "opencode",
  "sourcePath": "/path/to/ngagent.db",
  "sessionId": "ses_xxx",
  "userId": "u123456",
  "syncedAt": "2025-05-02T10:00:00.000Z",
  "normalized": { /* 见下方 */ }
}
```

### opencode

以 **session 为粒度**，`normalized` 是一个完整的会话文档，下游按 `session_id` upsert 覆盖即可，无需在服务端做 JOIN。

```jsonc
{
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
      "tokens": { "input": 14873, "output": 187, "total": 15060, "cache_read": 0, "cache_write": 0, "reasoning": 0 },
      "tool_calls": [
        {
          "tool_name": "read",
          "call_id": "read:0",
          "status": "completed",
          "input": { "filePath": "/src/auth.ts" },
          "output": "...文件内容（最长 16KB）",
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
```

### claude-code / code-agent-3x

以**消息行为粒度**，每条 JSONL 行对应一条记录。`normalized` 提取了 `role`、`timestamp`、`model`、`tokenUsage`。

---

## 增量同步原理

- **JSONL**（claude-code / code-agent-3x）：记录每个文件的字节偏移量，下次从上次结束位置继续读；仅处理完整行，末尾未完成的行等下次再读；文件缩小时自动重置（日志轮转场景）。
- **opencode**：用 SQLite `rowid`（不是 text 类型的 id 字段）做水位，分别追踪 message 表和 part 表的最大 rowid，下次只查找有新内容的 session，重新组装完整 session 文档后发送。默认同时扫描 `~/.local/share/opencode/opencode.db` 和 `~/.local/share/opencode/db/ngagent.db`，每个数据库独立水位；`--root` 指定路径时只读该路径。

水位在**每次成功发送后立即落盘**，发送失败不更新水位，重试时会重发同样的数据。默认路径 `~/.config/log-sync/watermark.json`，通过 `--watermark-file` 可指定其他路径。

---

## 关于 Kafka 压缩

发送时自动使用 GZIP 压缩（producer 侧），broker 和消费端对此透明——消费端看到的仍然是解压后的原始 JSON，无需额外处理。压缩的作用是减少网络传输量和 broker 存储占用，JSON 文本通常能压缩 80-90%。

如果单条记录（通常是一个完整 opencode session）压缩后仍超过 broker 的 `message.max.bytes`，发送会失败并提示具体大小。此时需要在 Kafka broker 侧调大 `message.max.bytes`（以及 `replica.fetch.max.bytes`、`fetch.message.max.bytes` 等关联参数），客户端没有单独的消息大小上限可配。

---

## 开发

```bash
# 类型检查
npm run lint

# 构建到 dist/（生产部署时用）
npm run build
```
