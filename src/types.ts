export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
}

export interface NormalizedRecord {
  recordType?: string;
  role?: 'user' | 'assistant' | 'system' | 'tool';
  timestamp?: string;
  model?: string | null;
  tokenUsage?: TokenUsage;
  [key: string]: unknown;
}

export interface LogRecord {
  provider: 'claude-code' | 'code-agent-3x' | 'opencode';
  sourcePath: string;
  sessionId: string;
  syncedAt: string;
  userId?: string;
  normalized: NormalizedRecord;
}

export interface SourceCursor {
  provider: string;
  sessionId: string;
  sourcePath: string;
  type: 'jsonl' | 'sqlite-table';
  position: number;
  /** Provider-specific auxiliary watermark values to commit after a successful send */
  extra?: Record<string, number>;
}

export interface Provider {
  listSources(): Promise<SourceCursor[]>;
  read(cursor: SourceCursor): Promise<{ records: LogRecord[]; nextCursor: SourceCursor }>;
}

export interface Transport {
  send(records: LogRecord[]): Promise<void>;
}

export class LogSyncError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LogSyncError';
  }
}

export interface SyncOptions {
  batchSize: number;
  dryRun: boolean;
  verbose: boolean;
}

export interface OpenCodeToolCall {
  tool_name: string;
  call_id: string | null;
  status: string | null;
  input: unknown;
  output: string | null;
  is_error: boolean;
}

export interface OpenCodeReasoningPart {
  text: string;
  duration_ms: number | null;
}

export interface OpenCodeMessage {
  message_id: string;
  role: string;
  parent_message_id: string | null;
  timestamp: string | null;
  completed_at: string | null;
  generation_duration_ms: number | null;
  model_id: string | null;
  provider_id: string | null;
  agent: string | null;
  mode: string | null;
  cost: number | null;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    reasoning: number;
    total: number;
  } | null;
  finish_reason: string | null;
  text_parts: string[];
  reasoning_parts: OpenCodeReasoningPart[];
  tool_calls: OpenCodeToolCall[];
  has_patch: boolean;
  step_count: number;
}

export interface OpenCodeSessionDoc {
  record_type: 'opencode-session';
  session_id: string;
  title: string | null;
  cwd: string | null;
  project_id: string;
  version: string | null;
  model: string | null;
  is_subagent: boolean;
  parent_session_id: string | null;
  started_at: string | null;
  updated_at: string | null;
  cost_total: number;
  tokens_total: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    reasoning: number;
  };
  message_count: number;
  messages: OpenCodeMessage[];
}
