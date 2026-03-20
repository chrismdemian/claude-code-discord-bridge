import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { truncate, countLines } from "./utils";
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
  const filePath = String(toolUse.input.file_path ?? "?");
  const content = toolUse.input.content;

  // If no content in the input, just show the write notice
  if (content == null) {
    return {
      webhook: "claude",
      content: `📝 **${truncate(filePath, 800)}** (created)`,
    };
  }

  const fullText = String(content);
  const lang = inferLanguage(filePath);
  const numLines = countLines(fullText);
  const header = `📝 **${truncate(filePath, 800)}** (${numLines} lines)`;

  // Show first 30 lines as preview
  const lines = fullText.split("\n");
  const previewCount = Math.min(30, lines.length);
  const preview = lines.slice(0, previewCount).join("\n");
  const escaped = preview.replace(/```/g, "` ` `");
  const suffix = lines.length > previewCount ? `\n... +${lines.length - previewCount} more lines` : "";

  const codeBlock = `\`\`\`${lang}\n${escaped}\n\`\`\`${suffix}`;
  const fullContent = `${header}\n${codeBlock}`;

  // splitMessage in MessageSender will handle chunking if needed
  return { webhook: "claude", content: fullContent };
}
