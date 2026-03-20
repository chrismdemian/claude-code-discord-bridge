import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { MAX_CONTENT_LENGTH } from "../constants";
import { extractResultText, truncate } from "./utils";

export function formatWebFetchCall(toolUse: ToolUseBlock): FormattedMessage {
  const url = truncate(String(toolUse.input.url ?? "?"), 200);
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

  return {
    webhook: "claude",
    content: truncate(text, MAX_CONTENT_LENGTH),
  };
}

export function formatWebSearchCall(toolUse: ToolUseBlock): FormattedMessage {
  const query = truncate(String(toolUse.input.query ?? "?"), 150);
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

  return {
    webhook: "claude",
    content: truncate(text, MAX_CONTENT_LENGTH),
  };
}
