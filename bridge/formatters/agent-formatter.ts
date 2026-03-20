import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { extractResultText, truncate, wrapCodeBlock } from "./utils";

export function formatAgentCall(toolUse: ToolUseBlock): FormattedMessage {
  const subagentType = toolUse.input.subagent_type
    ? ` (${String(toolUse.input.subagent_type)})`
    : "";
  const prompt = truncate(String(toolUse.input.prompt ?? ""), 800);
  return {
    webhook: "claude",
    content: `🤖 \`Agent${subagentType}: "${prompt}"\``,
  };
}

export function formatAgentResult(
  _toolUse: ToolUseBlock,
  result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  // Wrap in code block to prevent Discord markdown rendering of agent output.
  // splitMessage in MessageSender will handle chunking and preserve code blocks.
  return {
    webhook: "claude",
    content: wrapCodeBlock(text),
  };
}
