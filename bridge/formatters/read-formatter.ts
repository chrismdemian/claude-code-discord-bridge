import { AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { MAX_CONTENT_LENGTH } from "../constants";
import { extractResultText, truncate, countLines } from "./utils";
import { inferLanguage } from "./lang-map";

export function formatReadCall(toolUse: ToolUseBlock): FormattedMessage {
  const filePath = String(toolUse.input.file_path ?? "?");
  return {
    webhook: "editor",
    content: `📖 \`Read: ${truncate(filePath, 150)}\``,
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
  const numLines = countLines(text);
  const header = `📖 **${truncate(filePath, 100)}** (${numLines} lines)`;

  // Escape triple backticks
  const escaped = text.replace(/```/g, "` ` `");
  const codeBlock = `\`\`\`${lang}\n${escaped}\n\`\`\``;
  const fullContent = `${header}\n${codeBlock}`;

  // Fits in one message
  if (fullContent.length <= MAX_CONTENT_LENGTH) {
    return { webhook: "editor", content: fullContent };
  }

  // Too long: show first N + last N lines (non-overlapping), attach full
  const lines = text.split("\n");
  const headCount = Math.min(30, lines.length);
  const tailCount = Math.min(10, Math.max(0, lines.length - headCount));
  const omitted = lines.length - headCount - tailCount;

  const headLines = lines.slice(0, headCount).join("\n");
  const escapedHead = headLines.replace(/```/g, "` ` `");

  let preview: string;
  if (tailCount > 0 && omitted > 0) {
    const tailLines = lines.slice(-tailCount).join("\n");
    const escapedTail = tailLines.replace(/```/g, "` ` `");
    preview = `${header}\n\`\`\`${lang}\n${escapedHead}\n\`\`\`\n... ${omitted} lines omitted ...\n\`\`\`${lang}\n${escapedTail}\n\`\`\``;
  } else {
    preview = `${header}\n\`\`\`${lang}\n${escapedHead}\n\`\`\``;
  }

  const trimmedPreview = preview.length > MAX_CONTENT_LENGTH
    ? `${header}\n\`\`\`${lang}\n${truncate(escapedHead, MAX_CONTENT_LENGTH - header.length - 30)}\n\`\`\`\n*Full content in attached file*`
    : preview;

  const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), {
    name: filePath.split(/[/\\]/).pop() ?? "file.txt",
  });

  return {
    webhook: "editor",
    content: trimmedPreview,
    files: [attachment],
  };
}
