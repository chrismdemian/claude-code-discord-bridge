import type {
  ToolUseBlock,
  ToolResultBlock,
  BridgeSession,
  DiscordConfig,
  FormattedMessage,
} from "./types";
import { truncate, extractResultText, wrapCodeBlock } from "./formatters/utils";

// Tool-specific formatters
import { formatBashCall, formatBashResult } from "./formatters/bash-formatter";
import { formatEditCall, formatEditResult } from "./formatters/edit-formatter";
import { formatReadCall, formatReadResult } from "./formatters/read-formatter";
import { formatWriteCall, formatWriteResult } from "./formatters/write-formatter";
import {
  formatGlobCall,
  formatGlobResult,
  formatGrepCall,
  formatGrepResult,
} from "./formatters/search-formatter";
import { formatAgentCall, formatAgentResult } from "./formatters/agent-formatter";
import {
  formatWebFetchCall,
  formatWebFetchResult,
  formatWebSearchCall,
  formatWebSearchResult,
} from "./formatters/web-formatter";

// ── Webhook routing ──────────────────────────────────────────────────────

type WebhookName = keyof DiscordConfig["webhooks"];

const TOOL_WEBHOOK_MAP: Record<string, WebhookName> = {
  Bash: "terminal",
  Read: "editor",
  Edit: "editor",
  Write: "editor",
  MultiEdit: "editor",
  Glob: "editor",
  Grep: "editor",
  NotebookEdit: "editor",
  WebSearch: "claude",
  WebFetch: "claude",
  Agent: "claude",
  TodoRead: "claude",
  TodoWrite: "claude",
};

export function getToolWebhook(toolName: string): WebhookName {
  if (TOOL_WEBHOOK_MAP[toolName]) return TOOL_WEBHOOK_MAP[toolName];
  if (toolName.startsWith("mcp__plugin_playwright")) return "playwright";
  if (toolName.startsWith("mcp__")) return "system";
  return "claude";
}

// ── Call formatters (tool_use → brief header) ────────────────────────────

type CallFormatterFn = (toolUse: ToolUseBlock) => FormattedMessage;

const CALL_FORMATTERS: Record<string, CallFormatterFn> = {
  Bash: formatBashCall,
  Edit: formatEditCall,
  MultiEdit: formatEditCall,
  Read: formatReadCall,
  Write: formatWriteCall,
  Glob: formatGlobCall,
  Grep: formatGrepCall,
  Agent: formatAgentCall,
  WebFetch: formatWebFetchCall,
  WebSearch: formatWebSearchCall,
};

function defaultCallFormatter(toolUse: ToolUseBlock): FormattedMessage {
  const inputStr = truncate(JSON.stringify(toolUse.input), 120);
  return {
    webhook: getToolWebhook(toolUse.name),
    content: `🔧 \`${toolUse.name}(${inputStr})\``,
  };
}

/** Format a tool_use block into a brief summary message */
export function formatToolCall(toolUse: ToolUseBlock): FormattedMessage {
  const formatter = CALL_FORMATTERS[toolUse.name];
  if (formatter) return formatter(toolUse);
  return defaultCallFormatter(toolUse);
}

// ── Result formatters (tool_result → rich output) ────────────────────────

type ResultFormatterFn = (
  toolUse: ToolUseBlock,
  result: ToolResultBlock,
  session: BridgeSession,
) => FormattedMessage | FormattedMessage[] | null;

const RESULT_FORMATTERS: Record<string, ResultFormatterFn> = {
  Bash: formatBashResult,
  Edit: formatEditResult,
  MultiEdit: formatEditResult,
  Read: formatReadResult,
  Write: formatWriteResult,
  Glob: formatGlobResult,
  Grep: formatGrepResult,
  Agent: formatAgentResult,
  WebFetch: formatWebFetchResult,
  WebSearch: formatWebSearchResult,
};

function defaultResultFormatter(
  toolUse: ToolUseBlock,
  result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  const prefix = result.is_error ? "Error: " : "";
  const truncated = truncate(text, 1800);

  return {
    webhook: getToolWebhook(toolUse.name),
    content: `${prefix}${wrapCodeBlock(truncated)}`,
  };
}

/**
 * Format a tool_result block into rich Discord messages.
 * @param toolName - Name of the tool that produced this result
 * @param toolUse - The original tool_use block (may be undefined for untracked tools)
 * @param result - The tool_result block from the transcript
 * @param session - Current bridge session state
 */
export function formatToolResult(
  toolName: string,
  toolUse: ToolUseBlock | undefined,
  result: ToolResultBlock,
  session: BridgeSession,
): FormattedMessage | FormattedMessage[] | null {
  // If we don't have the original tool_use, create a synthetic one
  const effectiveToolUse: ToolUseBlock = toolUse ?? {
    type: "tool_use",
    id: result.tool_use_id,
    name: toolName,
    input: {},
  };

  const formatter = RESULT_FORMATTERS[toolName];
  if (formatter) return formatter(effectiveToolUse, result, session);
  return defaultResultFormatter(effectiveToolUse, result, session);
}
