import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Embed,
} from "discord.js";
import type { PermissionRequestHook } from "../types";
import { COLORS } from "../constants";
import { truncate } from "../formatters/utils";

/**
 * Build the permission request embed with Approve/Deny/Context buttons.
 * Sent via bot client (not webhook) so InteractionCreate routes correctly.
 */
export function buildPermissionEmbed(
  payload: PermissionRequestHook,
  description: string,
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle("🔐 Permission Request")
    .setColor(COLORS.YELLOW)
    .setDescription(
      `Claude wants to run:\n\`\`\`\n${truncate(description, 1800)}\n\`\`\``,
    )
    .addFields(
      { name: "Tool", value: payload.tool_name, inline: true },
      {
        name: "Session",
        value: payload.session_id.slice(0, 18),
        inline: true,
      },
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`perm_approve_${payload.session_id}`)
      .setLabel("Approve")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`perm_deny_${payload.session_id}`)
      .setLabel("Deny")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`perm_context_${payload.session_id}`)
      .setLabel("Show Context")
      .setEmoji("👁️")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Build an updated embed after the user clicks Approve or Deny.
 * Clones the original embed and changes color + title.
 */
export function buildResolvedEmbed(
  originalEmbed: Embed,
  approved: boolean,
): EmbedBuilder {
  const embed = EmbedBuilder.from(originalEmbed.data);
  if (approved) {
    embed.setColor(COLORS.GREEN).setTitle("✅ Permission Approved");
  } else {
    embed.setColor(COLORS.RED).setTitle("❌ Permission Denied");
  }
  return embed;
}

/**
 * Build an updated embed when the permission request times out.
 */
export function buildTimeoutEmbed(originalEmbed: Embed): EmbedBuilder {
  return EmbedBuilder.from(originalEmbed.data)
    .setColor(COLORS.GRAY)
    .setTitle("⏰ Permission Timed Out (auto-denied)");
}
