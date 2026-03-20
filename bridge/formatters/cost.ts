import type { TokenUsage } from "../types";

type Rate = { input: number; output: number; cacheWrite: number; cacheRead: number };

/** Token pricing per million tokens */
const RATES: Record<string, Rate> = {
  "claude-opus-4-6": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

/** Fast mode pricing per million tokens (2x standard for opus) */
const FAST_RATES: Record<string, Rate> = {
  "claude-opus-4-6": { input: 30, output: 150, cacheWrite: 37.5, cacheRead: 3 },
};

/** Find rate by partial model name match, with fast mode support */
function findRate(model: string, speed?: string): Rate {
  const isFast = speed === "fast";

  // Exact match first
  if (isFast && FAST_RATES[model]) return FAST_RATES[model];
  if (RATES[model]) return isFast ? (FAST_RATES[model] ?? RATES[model]) : RATES[model];

  // Fuzzy match
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return isFast ? FAST_RATES["claude-opus-4-6"] : RATES["claude-opus-4-6"];
  if (lower.includes("haiku")) return RATES["claude-haiku-3-5"];
  if (lower.includes("sonnet")) return RATES["claude-sonnet-4-6"];

  // Default to sonnet pricing
  return RATES["claude-sonnet-4-6"];
}

/** Calculate dollar cost from token usage and model */
export function calculateCost(usage: TokenUsage, model: string): number {
  const rate = findRate(model, usage.speed);
  return (
    usage.input_tokens * rate.input +
    usage.output_tokens * rate.output +
    (usage.cache_creation_input_tokens ?? 0) * rate.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * rate.cacheRead
  ) / 1_000_000;
}

/** Shorten model name for display: "claude-opus-4-6" → "opus-4-6" */
export function formatModelName(model: string): string {
  return model.replace(/^claude-/, "");
}
