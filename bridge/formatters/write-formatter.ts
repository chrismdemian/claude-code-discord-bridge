import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { MAX_CONTENT_LENGTH } from "../constants";
import { truncate, countLines } from "./utils";
import { inferLanguage } from "./lang-map";

export function formatWriteCall(toolUse: ToolUseBlock): FormattedMessage {
  const filePath = String(toolUse.input.file_path ?? "?");
  return {
    webhook: "editor",
    content: `📝 \`Write: ${truncate(filePath, 150)}\``,
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
      webhook: "editor",
      content: `📝 **${truncate(filePath, 100)}** (created)`,
    };
  }

  const fullText = String(content);
  const lang = inferLanguage(filePath);
  const numLines = countLines(fullText);
  const header = `📝 **${truncate(filePath, 100)}** (${numLines} lines)`;

  // Show first 20 lines
  const lines = fullText.split("\n");
  const preview = lines.slice(0, 20).join("\n");
  const escaped = preview.replace(/```/g, "` ` `");
  const suffix = lines.length > 20 ? `\n... +${lines.length - 20} more lines` : "";

  const codeBlock = `\`\`\`${lang}\n${escaped}\n\`\`\`${suffix}`;
  const fullContent = `${header}\n${codeBlock}`;

  if (fullContent.length <= MAX_CONTENT_LENGTH) {
    return { webhook: "editor", content: fullContent };
  }

  // Truncate preview further if needed
  return {
    webhook: "editor",
    content: `${header}\n\`\`\`${lang}\n${truncate(escaped, MAX_CONTENT_LENGTH - header.length - 30)}\n\`\`\``,
  };
}
