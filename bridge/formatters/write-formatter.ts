import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { truncate } from "./utils";
import { inferLanguage } from "./lang-map";
import { MAX_CONTENT_LENGTH } from "../constants";

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

  if (content == null) return null;

  const fullText = String(content);
  const lang = inferLanguage(filePath);
  const fileName = filePath.split(/[/\\]/).pop() ?? "file.txt";
  const lineCount = fullText.split("\n").length;

  const escaped = fullText.replace(/```/g, "` ` `");
  const codeBlock = `\`\`\`${lang}\n${escaped}\n\`\`\``;

  // Make collapsible — same pattern as Read
  if (codeBlock.length <= MAX_CONTENT_LENGTH) {
    return {
      webhook: "claude",
      content: codeBlock,
      collapsedText: `*${lineCount} lines written — \`${fileName}\`*`,
    };
  }

  // Too long — just show summary (no inline dump)
  return {
    webhook: "claude",
    content: `*${lineCount} lines written — \`${fileName}\`*`,
  };
}
