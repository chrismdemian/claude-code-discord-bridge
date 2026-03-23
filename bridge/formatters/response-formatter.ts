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
export function formatAssistantText(
  text: string,
  session: BridgeSession,
  meta?: ResponseMeta,
): FormattedMessage {
  let content = text;

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
