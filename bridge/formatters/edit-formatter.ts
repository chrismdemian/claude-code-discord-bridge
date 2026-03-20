import { AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { MAX_CONTENT_LENGTH } from "../constants";
import { truncate } from "./utils";

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
    webhook: "editor",
    content: `✏️ \`Edit: ${truncate(filePath, 150)}\``,
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
  editCount: number,
): FormattedMessage {
  const header =
    editCount > 1
      ? `✏️ **${truncate(filePath, 100)}** (${editCount} edits)`
      : `✏️ **${truncate(filePath, 100)}**`;

  const escaped = escapeTicks(diffText);
  const codeBlock = `\`\`\`diff\n${escaped}\n\`\`\``;
  const fullContent = `${header}\n${codeBlock}`;

  // Fits in one message
  if (fullContent.length <= MAX_CONTENT_LENGTH) {
    return { webhook: "editor", content: fullContent };
  }

  // Too long — summary + .diff attachment
  const summary = `${header}\n*Diff too large to display inline (see attached file)*`;
  const attachment = new AttachmentBuilder(Buffer.from(diffText, "utf-8"), {
    name: `${filePath.split(/[/\\]/).pop() ?? "edit"}.diff`,
  });

  return {
    webhook: "editor",
    content: summary,
    files: [attachment],
  };
}
