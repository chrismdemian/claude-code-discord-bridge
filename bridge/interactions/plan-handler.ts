import {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { BridgeSession } from "../types";
import type { McpRelay } from "../mcp-relay";
import { COLORS } from "../constants";
import { buildPlanProgressEmbed } from "../formatters/plan-formatter";

/** Handle Execute button — sends "yes" to Claude and starts step tracking */
export async function handlePlanExecute(
  interaction: ButtonInteraction,
  session: BridgeSession,
  relay: McpRelay,
): Promise<void> {
  // Enqueue "yes" to Claude to execute the plan
  const sent = relay.enqueueMessage(session.sessionId, "yes", interaction.user.id);
  if (!sent) {
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

    // Replace plan embed with progress embed
    const progressEmbed = buildPlanProgressEmbed(session.planTitle, session.planSteps);
    await interaction.update({ embeds: [progressEmbed], components: [] });
  } else {
    // No steps parsed — just dismiss buttons
    const embed = EmbedBuilder.from(interaction.message.embeds[0]?.data ?? {});
    await interaction.update({ embeds: [embed], components: [] });
  }
}

/** Handle Modify button — shows a modal for the user to type modifications */
export async function handlePlanModify(
  interaction: ButtonInteraction,
  session: BridgeSession,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`plan_modify_modal_${session.sessionId}`)
    .setTitle("Modify Plan");

  const input = new TextInputBuilder()
    .setCustomId("modification_text")
    .setLabel("Describe how to modify the plan")
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

/** Handle Clear button — sends /clear to Claude and grays out the embed */
export async function handlePlanClear(
  interaction: ButtonInteraction,
  session: BridgeSession,
  relay: McpRelay,
): Promise<void> {
  const sent = relay.enqueueMessage(session.sessionId, "/clear", interaction.user.id);
  if (!sent) {
    await interaction.reply({
      content: "Session is read-only (no channel plugin connected).",
      ephemeral: true,
    });
    return;
  }

  // Reset plan state
  session.planMode = false;
  session.planSteps = [];
  session.planCurrentStep = -1;
  session.planMessageId = null;
  session.planTitle = "";

  const embed = new EmbedBuilder()
    .setColor(COLORS.GRAY)
    .setTitle("🗑️ Context Cleared")
    .setDescription("Plan dismissed. Context will be cleared.")
    .setTimestamp();

  await interaction.update({ embeds: [embed], components: [] });
}

/** Handle Chat button — removes buttons, user continues typing normally */
export async function handlePlanChat(
  interaction: ButtonInteraction,
  session: BridgeSession,
): Promise<void> {
  // Keep the plan embed but remove buttons
  const embed = EmbedBuilder.from(interaction.message.embeds[0]?.data ?? {});
  await interaction.update({ embeds: [embed], components: [] });

  // Reset plan message tracking so we don't try to edit it
  session.planMessageId = null;
}
