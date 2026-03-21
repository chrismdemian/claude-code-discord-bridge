import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { truncate } from "./utils";
import { inferLanguage } from "./lang-map";

export function formatWriteCall(toolUse: ToolUseBlock): FormattedMessage {
  const filePath = String(toolUse.input.file_path ?? "?");
  return {
    webhook: "claude",
    content: `📝 \`Write: ${truncate(filePath, 800)}\``,
  };
}

export function formatWriteResult(
  toolUse: ToolUseBlock,
  _result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  const content = toolUse.input.content;
  const filePath = String(toolUse.input.file_path ?? "?");

  // If no content in the input, nothing to show (call header already displayed)
  if (content == null) return null;

  const fullText = String(content);
  const lang = inferLanguage(filePath);

  // Show first 30 lines as preview
  const lines = fullText.split("\n");
  const previewCount = Math.min(30, lines.length);
  const preview = lines.slice(0, previewCount).join("\n");
  const escaped = preview.replace(/```/g, "` ` `");
  const suffix = lines.length > previewCount ? `\n... +${lines.length - previewCount} more lines` : "";

  const codeBlock = `\`\`\`${lang}\n${escaped}\n\`\`\`${suffix}`;

  // splitMessage in MessageSender will handle chunking if needed
  return { webhook: "claude", content: codeBlock };
}
