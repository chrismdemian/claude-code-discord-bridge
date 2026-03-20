import { AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { extractResultText, truncate } from "./utils";

/** Threshold for attaching results as a file (bytes). Below this, splitMessage handles it. */
const FILE_ATTACHMENT_THRESHOLD = 8000;

export function formatGlobCall(toolUse: ToolUseBlock): FormattedMessage {
  const pattern = String(toolUse.input.pattern ?? "?");
  return {
    webhook: "claude",
    content: `🔍 \`Glob: ${truncate(pattern, 800)}\``,
  };
}

export function formatGlobResult(
  _toolUse: ToolUseBlock,
  result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  return formatSearchOutput("🔍 Glob results", text);
}

export function formatGrepCall(toolUse: ToolUseBlock): FormattedMessage {
  const pattern = String(toolUse.input.pattern ?? "?");
  return {
    webhook: "claude",
    content: `🔍 \`Grep: "${truncate(pattern, 800)}"\``,
  };
}

export function formatGrepResult(
  _toolUse: ToolUseBlock,
  result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  return formatSearchOutput("🔍 Grep results", text);
}

function formatSearchOutput(header: string, text: string): FormattedMessage {
  const escaped = text.replace(/```/g, "` ` `");
  const codeBlock = `\`\`\`\n${escaped}\n\`\`\``;
  const fullContent = `${header}\n${codeBlock}`;

  // Short/medium output: send as content — splitMessage handles chunking
  if (fullContent.length <= FILE_ATTACHMENT_THRESHOLD) {
    return { webhook: "claude", content: fullContent };
  }

  // Very long — show first ~40 lines as preview + attach full results
  const lines = escaped.split("\n");
  const previewLines = lines.slice(0, 40).join("\n");
  const suffix = lines.length > 40 ? `\n... +${lines.length - 40} more lines (see attached file)` : "";
  const preview = `${header}\n\`\`\`\n${previewLines}${suffix}\n\`\`\``;
  const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), {
    name: "results.txt",
  });

  return {
    webhook: "claude",
    content: preview,
    files: [attachment],
  };
}
