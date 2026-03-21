import * as path from "node:path";
import type { ToolResultContent } from "../types";

/** Truncate text to maxLength, appending "..." if truncated */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/** Format milliseconds as human-readable duration */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/** Extract plain text from a tool result content (string or ToolResultContent[]) */
export function extractResultText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null && "type" in item) {
      const block = item as ToolResultContent;
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

/** Wrap text in a Discord code block with optional language hint */
export function wrapCodeBlock(text: string, lang: string = ""): string {
  // Escape any triple backticks in the content to prevent breaking out
  const escaped = text.replace(/```/g, "` ` `");
  return `\`\`\`${lang}\n${escaped}\n\`\`\``;
}

/** Count the number of lines in text */
export function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

/**
 * Extract a human-readable project name from a working directory path.
 * Handles worktree paths like:
 *   .../termwatch--claude-worktrees-velvety-jingling-moonbeam → termwatch/velvety-jingling-moonbeam
 */
export function parseProjectName(cwd: string): string {
  const worktreeMarker = "--claude-worktrees-";
  const idx = cwd.indexOf(worktreeMarker);
  if (idx !== -1) {
    const parentPath = cwd.slice(0, idx);
    const parentName = path.basename(parentPath);
    const worktreeName = cwd.slice(idx + worktreeMarker.length);
    // worktreeName may contain path separators if there are subdirs — take just the name part
    const cleanName = worktreeName.split(/[/\\]/)[0];
    return `${parentName}/${cleanName}`;
  }
  return path.basename(cwd);
}
