import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { MAX_CONTENT_LENGTH } from "../constants";
import { extractResultText, truncate } from "./utils";

export function formatAgentCall(toolUse: ToolUseBlock): FormattedMessage {
  const subagentType = toolUse.input.subagent_type
    ? ` (${String(toolUse.input.subagent_type)})`
    : "";
  const prompt = truncate(String(toolUse.input.prompt ?? ""), 100);
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

  // Wrap in code block to prevent Discord markdown rendering of agent output
  if (text.length <= MAX_CONTENT_LENGTH - 20) {
    return { webhook: "claude", content: `\`\`\`\n${text.replace(/```/g, "` ` `")}\n\`\`\`` };
  }
  return { webhook: "claude", content: `\`\`\`\n${truncate(text.replace(/```/g, "` ` `"), MAX_CONTENT_LENGTH - 20)}\n\`\`\`` };
}
