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

/** Shorten an absolute file path to a relative one by stripping the project cwd */
export function shortenPath(filePath: string, cwd?: string): string {
  if (!cwd || !filePath) return filePath;
  // Normalize to forward slashes for comparison
  const normPath = filePath.replace(/\\/g, "/").toLowerCase();
  const normCwd = cwd.replace(/\\/g, "/").toLowerCase();
  const cwdWithSlash = normCwd.endsWith("/") ? normCwd : normCwd + "/";
  if (normPath.startsWith(cwdWithSlash)) {
    return filePath.slice(cwdWithSlash.length).replace(/\\/g, "/");
  }
  // Also try original casing
  const origNorm = filePath.replace(/\\/g, "/");
  const origCwd = (cwd.replace(/\\/g, "/") + "/");
  if (origNorm.startsWith(origCwd)) {
    return origNorm.slice(origCwd.length);
  }
  return filePath;
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
 * Handles:
 *   .../termwatch--claude-worktrees-velvety-jingling-moonbeam → termwatch
 *   .../.claude/worktrees/mellow-coalescing-bear → parent project name
 *   C:\Users\chris → home (not "chris")
 *   C:\Users\chris\Projects → Projects (generic)
 */
export function parseProjectName(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");

  // Worktree variant 1: encoded path with --claude-worktrees-
  const worktreeMarker = "--claude-worktrees-";
  const idx = normalized.indexOf(worktreeMarker);
  if (idx !== -1) {
    const parentPath = normalized.slice(0, idx);
    return path.basename(parentPath);
  }

  // Worktree variant 2: .claude/worktrees/<name> inside a project
  const cwMatch = normalized.match(/(.+?)\/.claude\/worktrees\/([^/]+)/);
  if (cwMatch) {
    return path.basename(cwMatch[1]);
  }

  const basename = path.basename(normalized);
  const parent = path.basename(path.dirname(normalized));

  // Unhelpful names: user's home dir, generic folders
  const unhelpful = new Set(["users", "home", "projects", "documents", "desktop", "downloads"]);
  if (unhelpful.has(basename.toLowerCase())) {
    return `${basename} (general)`;
  }

  // If parent is "Users" (home dir), show as "home"
  if (parent.toLowerCase() === "users") {
    return `${basename} (home)`;
  }

  return basename;
}
