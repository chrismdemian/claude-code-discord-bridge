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

function formatSearchOutput(_header: string, text: string): FormattedMessage {
  const escaped = text.replace(/```/g, "` ` `");
  const codeBlock = `\`\`\`\n${escaped}\n\`\`\``;

  // Short output: send inline
  if (codeBlock.length <= FILE_ATTACHMENT_THRESHOLD) {
    return { webhook: "claude", content: codeBlock };
  }

  // Long output: just show count + attach full results (no preview dump)
  const lineCount = text.split("\n").filter(l => l.trim()).length;
  const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), {
    name: "results.txt",
  });

  return {
    webhook: "claude",
    content: `*${lineCount} results — see attached*`,
    files: [attachment],
  };
}
