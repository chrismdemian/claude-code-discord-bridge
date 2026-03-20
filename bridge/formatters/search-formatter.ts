import { AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { MAX_CONTENT_LENGTH } from "../constants";
import { extractResultText, truncate } from "./utils";

export function formatGlobCall(toolUse: ToolUseBlock): FormattedMessage {
  const pattern = String(toolUse.input.pattern ?? "?");
  return {
    webhook: "editor",
    content: `🔍 \`Glob: ${truncate(pattern, 150)}\``,
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
    webhook: "editor",
    content: `🔍 \`Grep: "${truncate(pattern, 140)}"\``,
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

  if (fullContent.length <= MAX_CONTENT_LENGTH) {
    return { webhook: "editor", content: fullContent };
  }

  // Too long — truncate + attach full
  const preview = `${header}\n\`\`\`\n${truncate(escaped, MAX_CONTENT_LENGTH - header.length - 30)}\n\`\`\``;
  const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), {
    name: "results.txt",
  });

  return {
    webhook: "editor",
    content: preview,
    files: [attachment],
  };
}
