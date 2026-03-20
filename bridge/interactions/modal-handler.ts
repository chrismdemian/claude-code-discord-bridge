import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { McpRelay } from "../mcp-relay";

/** Build the "New Prompt" button for the session info embed */
export function buildNewPromptButton(
  sessionId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`prompt_new_${sessionId}`)
      .setLabel("New Prompt")
      .setEmoji("📝")
      .setStyle(ButtonStyle.Primary),
  );
}

/** Show the prompt modal when the "New Prompt" button is clicked */
export async function showPromptModal(
  interaction: ButtonInteraction,
  sessionId: string,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`prompt_modal_${sessionId}`)
    .setTitle("New Prompt");

  const promptInput = new TextInputBuilder()
    .setCustomId("prompt_text")
    .setLabel("Your prompt")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput),
  );

  await interaction.showModal(modal);
}

/** Handle the modal submit — extract text and send to Claude */
export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  sessionId: string,
  relay: McpRelay,
  userId: string,
): Promise<void> {
  const text = interaction.fields.getTextInputValue("prompt_text");

  if (!text.trim()) {
    await interaction.reply({
      content: "Prompt was empty.",
      ephemeral: true,
    });
    return;
  }

  const sent = relay.enqueueMessage(sessionId, text, userId);
  if (sent) {
    await interaction.reply({
      content: "✅ Prompt sent to Claude.",
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: "❌ Session has no channel plugin connected (read-only).",
      ephemeral: true,
    });
  }
}
