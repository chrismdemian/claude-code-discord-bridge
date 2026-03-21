import { AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { truncate } from "./utils";

/** Threshold for attaching diff as a file (bytes). Below this, splitMessage handles it. */
const FILE_ATTACHMENT_THRESHOLD = 8000;

/** Escape triple backticks inside diff content */
function escapeTicks(text: string): string {
  return text.replace(/```/g, "` ` `");
}

/** Build a unified diff string from old/new text */
function buildDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n").map((l) => `- ${l}`);
  const newLines = newStr.split("\n").map((l) => `+ ${l}`);
  return [...oldLines, ...newLines].join("\n");
}

export function formatEditCall(toolUse: ToolUseBlock): FormattedMessage {
  const filePath = String(toolUse.input.file_path ?? "?");
  return {
    webhook: "claude",
    content: `✏️ \`Edit: ${truncate(filePath, 800)}\``,
  };
}

export function formatEditResult(
  toolUse: ToolUseBlock,
  _result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  const filePath = String(toolUse.input.file_path ?? "?");

  // Handle MultiEdit (array of edits)
  if (Array.isArray(toolUse.input.edits)) {
    const edits = toolUse.input.edits as Array<{
      old_string?: string;
      new_string?: string;
    }>;
    if (edits.length === 0) return null;

    const diffs: string[] = [];
    for (const edit of edits) {
      if (edit.old_string != null && edit.new_string != null) {
        diffs.push(buildDiff(String(edit.old_string), String(edit.new_string)));
      }
    }

    const diffText = diffs.join("\n\n");
    return formatDiffOutput(filePath, diffText, edits.length);
  }

  // Single Edit
  const oldStr = toolUse.input.old_string;
  const newStr = toolUse.input.new_string;
  if (oldStr == null || newStr == null) return null;

  const diffText = buildDiff(String(oldStr), String(newStr));
  return formatDiffOutput(filePath, diffText, 1);
}

function formatDiffOutput(
  filePath: string,
  diffText: string,
  _editCount: number,
): FormattedMessage {
  const escaped = escapeTicks(diffText);
  const codeBlock = `\`\`\`diff\n${escaped}\n\`\`\``;

  // Short/medium diffs: send as content — splitMessage handles chunking
  if (codeBlock.length <= FILE_ATTACHMENT_THRESHOLD) {
    return { webhook: "claude", content: codeBlock };
  }

  // Very long diff — show first ~40 lines as preview + attach full diff
  const lines = escaped.split("\n");
  const previewLines = lines.slice(0, 40).join("\n");
  const suffix = lines.length > 40 ? `\n... +${lines.length - 40} more lines (see attached file)` : "";
  const preview = `\`\`\`diff\n${previewLines}${suffix}\n\`\`\``;

  const attachment = new AttachmentBuilder(Buffer.from(diffText, "utf-8"), {
    name: `${filePath.split(/[/\\]/).pop() ?? "edit"}.diff`,
  });

  return {
    webhook: "claude",
    content: preview,
    files: [attachment],
  };
}
