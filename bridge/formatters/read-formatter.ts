import { AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { MAX_CONTENT_LENGTH } from "../constants";
import { extractResultText, truncate } from "./utils";
import { inferLanguage } from "./lang-map";

export function formatReadCall(toolUse: ToolUseBlock): FormattedMessage {
  const filePath = String(toolUse.input.file_path ?? "?");
  return {
    webhook: "claude",
    content: `📖 \`Read: ${truncate(filePath, 800)}\``,
  };
}

export function formatReadResult(
  toolUse: ToolUseBlock,
  result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  let text = extractResultText(result.content);
  if (!text.trim()) return null;

  // Strip Claude Code's line number prefixes (e.g. "     1→" or "  42→")
  text = text.replace(/^ *\d+→/gm, "");

  const filePath = String(toolUse.input.file_path ?? "?");
  const fileName = filePath.split(/[/\\]/).pop() ?? "file.txt";
  const lang = inferLanguage(filePath);
  const lineCount = text.split("\n").length;

  // Escape triple backticks
  const escaped = text.replace(/```/g, "` ` `");
  const codeBlock = `\`\`\`${lang}\n${escaped}\n\`\`\``;

  // If it fits in one message, make it collapsible (show/hide button)
  if (codeBlock.length <= MAX_CONTENT_LENGTH) {
    return {
      webhook: "claude",
      content: codeBlock,
      collapsedText: `*${lineCount} lines — \`${fileName}\`*`,
    };
  }

  // Too long for inline even when expanded — attach as file
  const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), {
    name: fileName,
  });

  return {
    webhook: "claude",
    content: `*${lineCount} lines — see attached*`,
    files: [attachment],
  };
}
