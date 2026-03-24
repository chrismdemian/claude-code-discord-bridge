import type { BridgeSession, FormattedMessage, TokenUsage } from "../types";
import type { RawTranscriptEntry } from "../types";
import { calculateCost, formatModelName } from "./cost";
import { formatDuration } from "./utils";

export interface ResponseMeta {
  model?: string;
  usage?: TokenUsage;
  durationMs?: number;
}

/** Format Claude's text response with optional metadata footer */
/** Convert markdown tables to code block format for Discord mobile readability */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect table: line with |, followed by separator line with |---|
    if (
      lines[i]?.includes("|") &&
      lines[i + 1]?.match(/^\s*\|[\s:|-]+\|\s*$/)
    ) {
      // Parse table rows
      const tableRows: string[][] = [];
      let j = i;
      while (j < lines.length && lines[j]?.includes("|")) {
        // Skip separator line
        if (lines[j].match(/^\s*\|[\s:|-]+\|\s*$/)) { j++; continue; }
        const cells = lines[j].split("|").map(c => c.trim()).filter(c => c !== "");
        if (cells.length > 0) tableRows.push(cells);
        j++;
      }

      if (tableRows.length > 0) {
        // Calculate column widths
        const colCount = Math.max(...tableRows.map(r => r.length));
        const widths = Array.from({ length: colCount }, (_, c) =>
          Math.max(...tableRows.map(r => (r[c] ?? "").length), 3)
        );

        // Render as code block
        result.push("```");
        for (let r = 0; r < tableRows.length; r++) {
          const row = tableRows[r];
          const padded = widths.map((w, c) => (row[c] ?? "").padEnd(w));
          result.push(padded.join("  "));
          // Add separator after header
          if (r === 0) {
            result.push(widths.map(w => "─".repeat(w)).join("──"));
          }
        }
        result.push("```");
      }

      i = j;
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

export function formatAssistantText(
  text: string,
  session: BridgeSession,
  meta?: ResponseMeta,
): FormattedMessage {
  // Convert markdown tables to monospaced code blocks for Discord mobile
  let content = convertTables(text);

  if (meta?.model || meta?.usage) {
    const parts: string[] = [];

    if (meta.model) {
      parts.push(formatModelName(meta.model));
    }
    if (meta.durationMs) {
      parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
    }
    if (meta.usage) {
      const totalTokens = (meta.usage.input_tokens + meta.usage.output_tokens) / 1000;
      // Only show when it rounds to at least 0.1k (50+ tokens)
      if (totalTokens >= 0.05) {
        parts.push(`${totalTokens.toFixed(1)}k tokens`);
      }
    }

    // Only show footer when there's more than just the model name —
    // model-only footers on short filler messages are noise
    if (parts.length > 1) {
      content += `\n-# ${parts.join(" · ")}`;
    }
  }

  return { webhook: "claude", content };
}

/** Format user's prompt as it appears in the transcript */
export function formatUserPrompt(text: string): FormattedMessage {
  const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
  return {
    webhook: "claude",
    content: `**You:**\n${quoted}`,
  };
}

/** Format system events (turn_duration, etc.) */
export function formatSystemEvent(
  entry: RawTranscriptEntry,
  session: BridgeSession,
): FormattedMessage | null {
  if (entry.subtype === "turn_duration" && entry.durationMs) {
    const duration = formatDuration(entry.durationMs);
    const parts = [`⏱️ ${duration}`];

    if (session.model && session.model !== "unknown") {
      parts[0] = `⏱️ ${formatModelName(session.model)} · ${duration}`;
    }

    return {
      webhook: "claude",
      content: `-# ${parts[0]}`,
    };
  }

  return null;
}
