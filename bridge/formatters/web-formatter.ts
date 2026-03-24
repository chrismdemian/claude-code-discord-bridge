import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { extractResultText, truncate } from "./utils";
import { MAX_CONTENT_LENGTH } from "../constants";

export function formatWebFetchCall(toolUse: ToolUseBlock): FormattedMessage {
  const url = truncate(String(toolUse.input.url ?? "?"), 800);
  return {
    webhook: "claude",
    content: `🌐 \`Fetch: ${url}\``,
  };
}

export function formatWebFetchResult(
  _toolUse: ToolUseBlock,
  result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  const byteCount = new TextEncoder().encode(text).length;
  const lineCount = text.split("\n").length;

  // Short response: show inline
  if (text.length < 500 && lineCount <= 10) {
    return { webhook: "claude", content: text };
  }

  // Medium response: collapsible
  if (text.length <= MAX_CONTENT_LENGTH) {
    return {
      webhook: "claude",
      content: text,
      collapsedText: `*${byteCount} bytes — ${lineCount} lines*`,
    };
  }

  // Long response: just summary
  return {
    webhook: "claude",
    content: `*${byteCount} bytes — ${lineCount} lines (too long for inline)*`,
  };
}

export function formatWebSearchCall(toolUse: ToolUseBlock): FormattedMessage {
  const query = truncate(String(toolUse.input.query ?? "?"), 800);
  return {
    webhook: "claude",
    content: `🔎 \`Search: "${query}"\``,
  };
}

export function formatWebSearchResult(
  _toolUse: ToolUseBlock,
  result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  const lineCount = text.split("\n").length;

  // Short: inline. Long: collapsible
  if (text.length < 500 && lineCount <= 10) {
    return { webhook: "claude", content: text };
  }

  if (text.length <= MAX_CONTENT_LENGTH) {
    return {
      webhook: "claude",
      content: text,
      collapsedText: `*${lineCount} search results*`,
    };
  }

  return {
    webhook: "claude",
    content: `*${lineCount} search results (too long for inline)*`,
  };
}
