import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { BridgeSession } from "../types";
import type { McpRelay } from "../mcp-relay";
import { buildPlanProgressEmbed } from "../formatters/plan-formatter";

/**
 * Shared logic for all execute variants (options 1-3).
 * Sends the option number as a channel notification message.
 * Note: Formal plan mode (ExitPlanMode) creates a blocking terminal prompt
 * that cannot be controlled remotely. The MCP server instructions tell Claude
 * to avoid formal plan mode for Discord users and output plans as regular text
 * instead, which can be approved via normal Discord messages.
 */
async function executePlan(
  interaction: ButtonInteraction,
  session: BridgeSession,
  relay: McpRelay,
  option: string,
): Promise<void> {
  const channelSent = relay.enqueueMessage(session.sessionId, option, interaction.user.id);

  if (!channelSent) {
    await interaction.reply({
      content: "Session is read-only (no channel plugin connected).",
      ephemeral: true,
    });
    return;
  }

  // Initialize execution tracking
  if (session.planSteps.length > 0) {
    session.planCurrentStep = 0;
    session.planSteps[0].status = "working";
    session.planLastEditAt = 0;

    const progressEmbed = buildPlanProgressEmbed(session.planTitle, session.planSteps);
    await interaction.update({ embeds: [progressEmbed], components: [] });
  } else {
    // No steps parsed — just dismiss buttons
    const embed = EmbedBuilder.from(interaction.message.embeds[0]?.data ?? {});
    await interaction.update({ embeds: [embed], components: [] });
  }
}

/**
 * Option 1: "Yes, auto-accept edits"
 */
export async function handlePlanExecute(
  interaction: ButtonInteraction,
  session: BridgeSession,
  relay: McpRelay,
): Promise<void> {
  await executePlan(interaction, session, relay, "1");
}

/**
 * Option 2: "Yes, manually approve edits"
 */
export async function handlePlanApprove(
  interaction: ButtonInteraction,
  session: BridgeSession,
  relay: McpRelay,
): Promise<void> {
  await executePlan(interaction, session, relay, "3");
}

/**
 * Option 4: "Type here to tell Claude what to change"
 * Shows a modal for the user to type modification instructions.
 */
export async function handlePlanModify(
  interaction: ButtonInteraction,
  session: BridgeSession,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`plan_modify_modal_${session.sessionId}`)
    .setTitle("Modify Plan");

  const input = new TextInputBuilder()
    .setCustomId("modification_text")
    .setLabel("Tell Claude what to change")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(true)
    .setPlaceholder("e.g. Skip step 3 and add error handling...");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(input),
  );

  await interaction.showModal(modal);
}

/** Handle Modify modal submission — sends modification text to Claude */
export async function handlePlanModifySubmit(
  interaction: ModalSubmitInteraction,
  session: BridgeSession,
  relay: McpRelay,
): Promise<void> {
  const text = interaction.fields.getTextInputValue("modification_text");
  relay.enqueueMessage(session.sessionId, text, interaction.user.id);
  await interaction.reply({
    content: "📝 Modification sent to Claude.",
    ephemeral: true,
  });
}
