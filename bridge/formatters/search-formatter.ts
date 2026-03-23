import { AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { extractResultText, truncate } from "./utils";

/** Threshold for attaching results as a file. Keep low to avoid multi-message floods on mobile. */
const FILE_ATTACHMENT_THRESHOLD = 1500;

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
  session: BridgeSession,
): FormattedMessage | null {
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  return formatSearchOutput(text, session.cwd);
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
  session: BridgeSession,
): FormattedMessage | null {
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  return formatSearchOutput(text, session.cwd);
}

/** Strip the project cwd prefix from paths to show relative paths */
function stripCwdPrefix(text: string, cwd: string): string {
  if (!cwd) return text;
  // Normalize separators and create variants to match
  const variants = [
    cwd,
    cwd.replace(/\\/g, "/"),
    cwd.replace(/\//g, "\\"),
    cwd.toLowerCase(),
    cwd.toLowerCase().replace(/\\/g, "/"),
  ];
  let result = text;
  for (const prefix of variants) {
    // Replace prefix + separator with relative path
    result = result.split(prefix + "/").join("./");
    result = result.split(prefix + "\\").join("./");
  }
  return result;
}

function formatSearchOutput(text: string, cwd: string): FormattedMessage {
  // Strip absolute paths down to relative
  let cleaned = stripCwdPrefix(text, cwd);

  // Filter out node_modules lines — never useful in Discord
  const lines = cleaned.split("\n");
  const filtered = lines.filter(l => !l.includes("node_modules"));
  const removedCount = lines.length - filtered.length;
  cleaned = filtered.join("\n");
  if (removedCount > 0 && cleaned.trim()) {
    cleaned += `\n(${removedCount} node_modules results hidden)`;
  } else if (removedCount > 0) {
    cleaned = `(all ${removedCount} results were in node_modules)`;
  }

  const escaped = cleaned.replace(/```/g, "` ` `");
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
