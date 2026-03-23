import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { extractResultText, truncate, wrapCodeBlock } from "./utils";

export function formatAgentCall(toolUse: ToolUseBlock): FormattedMessage {
  const agentType = String(toolUse.input.subagent_type ?? "Agent");
  const description = String(toolUse.input.description ?? "");
  const prompt = truncate(String(toolUse.input.prompt ?? ""), 100);
  const summary = description || prompt;

  return {
    webhook: "claude",
    content: `🤖 **${agentType}** · ${summary}`,
  };
}

/** Parse <usage> block from agent output to build a compact summary */
function parseUsage(text: string): { summary: string; cleaned: string } | null {
  const usageMatch = text.match(/<usage>\s*([\s\S]*?)\s*<\/usage>/);
  if (!usageMatch) return null;

  const usageBlock = usageMatch[1];
  const parts: string[] = [];

  const toolUses = usageBlock.match(/tool_uses[:\s]+(\d+)/i);
  if (toolUses) parts.push(`${toolUses[1]} tool uses`);

  const tokens = usageBlock.match(/total_tokens[:\s]+(\d+)/i);
  if (tokens) {
    const k = Math.round(parseInt(tokens[1], 10) / 1000);
    parts.push(`${k}k tokens`);
  }

  const duration = usageBlock.match(/duration_ms[:\s]+(\d+)/i);
  if (duration) {
    const secs = (parseInt(duration[1], 10) / 1000).toFixed(1);
    parts.push(`${secs}s`);
  }

  const summary = parts.length > 0 ? `Done · ${parts.join(" · ")}` : "Done";
  const cleaned = text.replace(/<usage>\s*[\s\S]*?<\/usage>\s*/g, "").trim();
  return { summary, cleaned };
}

export function formatAgentResult(
  _toolUse: ToolUseBlock,
  result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  let text = extractResultText(result.content);
  if (!text.trim()) return null;

  // Parse usage block for compact summary
  const usage = parseUsage(text);
  if (usage) {
    text = usage.cleaned;
  }

  // Strip internal metadata lines (agentId, SendMessage references, etc.)
  text = text
    .replace(/^agentId:.*$/gm, "")
    .replace(/\(use SendMessage.*?\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Just show the summary line — agent output is too verbose for Discord
  if (usage) {
    return {
      webhook: "claude",
      content: `-# 🤖 ${usage.summary}`,
    };
  }

  // Fallback: truncate heavily
  return {
    webhook: "claude",
    content: truncate(text, 500),
  };
}
