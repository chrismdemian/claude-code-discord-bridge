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
      parts.push(`${totalTokens.toFixed(1)}k tokens`);
    }

    if (parts.length > 0) {
      content += `\n-# ${parts.join(" · ")}`;
    }
  }

  return { webhook: "claude", content };
}

/** Format user's prompt as it appears in the transcript */
export function formatUserPrompt(text: string): FormattedMessage {
  return {
    webhook: "claude",
    content: text.split('\n').map(line => `> ${line}`).join('\n'),
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
