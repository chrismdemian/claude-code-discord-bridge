import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { BridgeSession, PlanStep } from "../types";
import { COLORS, MAX_EMBED_DESCRIPTION } from "../constants";
import { truncate } from "./utils";

/** Extract a title from plan text — first heading or first non-empty line */
export function extractPlanTitle(planText: string): string {
  const lines = planText.split("\n");
  for (const line of lines.slice(0, 10)) {
    const heading = line.match(/^#{1,3}\s+(.+)/);
    if (heading) return truncate(heading[1].trim(), 60);
  }
  // Fall back to first non-empty line
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return truncate(trimmed, 60);
  }
  return "Plan";
}

/** Parse numbered/bulleted steps from plan markdown text */
export function parsePlanSteps(planText: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of planText.split("\n")) {
    // Match: "1. Step description", "2) Step description", "- Step", "* Step"
    const match = line.match(/^\s*(?:\d+[\.\)]\s+|[-*]\s+)(.+)/);
    if (match) {
      steps.push({ description: match[1].trim(), status: "pending" });
    }
  }
  return steps;
}

/** Build the initial plan embed with action buttons */
export function buildPlanEmbed(
  planText: string,
  steps: PlanStep[],
  title: string,
  session: BridgeSession,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setColor(COLORS.GREEN)
    .setTitle(`📋 Plan: ${title}`)
    .setDescription(truncate(planText, MAX_EMBED_DESCRIPTION))
    .setFooter({ text: "Context remaining: N/A" })
    .setTimestamp();

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  // Only add buttons if session has channel plugin (bidirectional)
  if (session.hasChannelPlugin) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`plan_execute_${session.sessionId}`)
        .setLabel("Execute")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`plan_modify_${session.sessionId}`)
        .setLabel("Modify")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`plan_clear_${session.sessionId}`)
        .setLabel("Clear Context")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`plan_chat_${session.sessionId}`)
        .setLabel("Chat")
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(row);
  }

  return { embeds: [embed], components };
}

/** Build the execution progress embed (replaces the plan embed in-place) */
export function buildPlanProgressEmbed(
  title: string,
  steps: PlanStep[],
): EmbedBuilder {
  const lines = steps.map((step, i) => {
    const icon =
      step.status === "done" ? "✅" :
      step.status === "working" ? "🟡" : "⬜";
    const label = step.status.toUpperCase();
    return `${icon} Step ${i + 1} of ${steps.length}: ${step.description}  [${label}]`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.GREEN)
    .setTitle(`📋 Plan Execution: ${title}`)
    .setDescription(lines.join("\n"))
    .setTimestamp();
}

/** Build the completed plan embed (all steps done) */
export function buildPlanCompletedEmbed(
  title: string,
  steps: PlanStep[],
): EmbedBuilder {
  const lines = steps.map((step, i) =>
    `✅ Step ${i + 1} of ${steps.length}: ${step.description}  [DONE]`,
  );

  return new EmbedBuilder()
    .setColor(COLORS.GREEN)
    .setTitle(`📋 Plan Complete: ${title}`)
    .setDescription(lines.join("\n"))
    .setTimestamp();
}
