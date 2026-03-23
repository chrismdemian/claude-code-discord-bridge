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
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  const filePath = String(toolUse.input.file_path ?? "?");
  const lang = inferLanguage(filePath);

  // Escape triple backticks
  const escaped = text.replace(/```/g, "` ` `");
  const codeBlock = `\`\`\`${lang}\n${escaped}\n\`\`\``;

  // Fits in one message — no header needed (call header already shown)
  if (codeBlock.length <= MAX_CONTENT_LENGTH) {
    return { webhook: "claude", content: codeBlock };
  }

  // Too long: attach full file with a brief summary (Discord auto-previews text files)
  const lineCount = text.split("\n").length;
  const fileName = filePath.split(/[/\\]/).pop() ?? "file.txt";

  const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), {
    name: fileName,
  });

  return {
    webhook: "claude",
    content: `*${lineCount} lines — see attached*`,
    files: [attachment],
  };
}
