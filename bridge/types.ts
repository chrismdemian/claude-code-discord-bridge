import type { EmbedBuilder, AttachmentBuilder } from "discord.js";

/** Formatted message ready to send to Discord */
export interface FormattedMessage {
  webhook: keyof DiscordConfig["webhooks"];
  content?: string;
  embeds?: EmbedBuilder[];
  files?: AttachmentBuilder[];
}

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
  workingMessageId: string | null;
  // Plan mode state
  planMode: boolean;
  planSteps: PlanStep[];
  planMessageId: string | null;
  planTitle: string;
  planCurrentStep: number; // -1 = not executing, 0+ = current step index
  planLastEditAt: number; // timestamp of last progress embed edit (throttling)
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

/** Transcript JSONL entry (narrow typed version for structured processing) */
export interface TranscriptEntry {
  type: "assistant" | "user" | "system" | "progress";
  message?: AssistantMessage | UserMessage;
  subtype?: string;
  durationMs?: number;
  agent_progress?: AgentProgress;
}

/** Union of all content block types */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ThinkingBlock
  | ToolResultBlock;

/** Raw transcript JSONL entry — matches the real file format which has many extra fields */
export interface RawTranscriptEntry {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    model?: string;
    usage?: TokenUsage;
  };
  durationMs?: number;
  uuid?: string;
  timestamp?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  sessionId?: string;
  cwd?: string;
  customTitle?: string;
  [key: string]: unknown;
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

// ── Hook Payload Types ─────────────────────────────────────────────────
// Each interface matches the JSON body Claude Code sends for that hook event.
// All fields except session_id are optional — hooks may evolve over time.

export interface SessionStartHook {
  session_id: string;
  cwd?: string;
}

export interface SessionEndHook {
  session_id: string;
  reason?: string; // 'clear' | 'resume' | 'logout' | 'exit'
}

export interface PermissionRequestHook {
  hook_type: string;
  session_id: string;
  pid: number;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  description?: string;
}

export interface StopHook {
  session_id: string;
  last_assistant_message?: string;
}

export interface StopFailureHook {
  session_id: string;
  failure_type?: string; // 'rate_limit' | 'authentication_failed' | 'billing_error' | 'server_error'
  error?: string;
}

export interface PostToolUseHook {
  session_id: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface PostToolUseFailureHook {
  session_id: string;
  tool_name?: string;
  error?: string;
}

export interface PreCompactHook {
  session_id: string;
}

export interface PostCompactHook {
  session_id: string;
  compact_summary?: string;
  tokens_before?: number;
  tokens_after?: number;
}

export interface SubagentStartHook {
  session_id: string;
  agent_id?: string;
  agent_type?: string;
  prompt?: string;
}

export interface SubagentStopHook {
  session_id: string;
  agent_id?: string;
  result?: string;
}

export interface NotificationHook {
  session_id: string;
  notification_type?: string;
  message?: string;
}

export interface UserPromptSubmitHook {
  session_id: string;
  prompt?: string;
}

export interface TaskCompletedHook {
  session_id: string;
  task_id?: string;
  task_name?: string;
}

export interface TeammateIdleHook {
  session_id: string;
  teammate_id?: string;
}

export interface ConfigChangeHook {
  session_id: string;
  key?: string;
  value?: unknown;
}

export interface WorktreeCreateHook {
  session_id: string;
  name?: string;
  branch?: string;
  path?: string;
}

export interface WorktreeRemoveHook {
  session_id: string;
  name?: string;
}

/** A single step in a plan */
export interface PlanStep {
  description: string;
  status: "pending" | "working" | "done";
}

/** Access control configuration */
export interface AccessConfig {
  allowedUsers: string[];
}
