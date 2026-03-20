/** Session state tracked by the bridge */
export interface BridgeSession {
  sessionId: string;
  pid: number;
  cwd: string;
  startedAt: string;
  forumPostId: string;
  threadId: string;
  model: string;
  status: "active" | "working" | "idle" | "error" | "completed";
  hasChannelPlugin: boolean;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
  lastActivity: number;
  transcriptPath: string;
  transcriptOffset: number;
}

/** Discord resource IDs stored after setup */
export interface DiscordConfig {
  guildId: string;
  forumChannelId: string;
  dashboardChannelId: string;
  alertsChannelId: string;
  categoryId: string;
  webhooks: {
    claude: WebhookRef;
    terminal: WebhookRef;
    editor: WebhookRef;
    playwright: WebhookRef;
    git: WebhookRef;
    system: WebhookRef;
  };
}

export interface WebhookRef {
  id: string;
  token: string;
}

/** Transcript JSONL entry */
export interface TranscriptEntry {
  type: "assistant" | "user" | "system" | "progress";
  message?: AssistantMessage | UserMessage;
  subtype?: string;
  durationMs?: number;
  agent_progress?: AgentProgress;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextBlock | ToolUseBlock | ThinkingBlock)[];
  model?: string;
  usage?: TokenUsage;
}

export interface UserMessage {
  role: "user";
  content: (TextBlock | ToolResultBlock)[];
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ToolResultContent[];
  is_error?: boolean;
}

export interface ToolResultContent {
  type: "text" | "image";
  text?: string;
  source?: { type: string; media_type: string; data: string };
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AgentProgress {
  agentId: string;
  status: "started" | "working" | "completed" | "error";
  prompt?: string;
  result?: string;
}

/** Hook payloads POSTed to the bridge */
export interface HookPayload {
  hook_type: string;
  session_id: string;
  pid: number;
  cwd: string;
  [key: string]: unknown;
}

/** Plugin registration when MCP server connects to bridge */
export interface PluginRegistration {
  sessionId: string;
  pid: number;
  cwd: string;
}
