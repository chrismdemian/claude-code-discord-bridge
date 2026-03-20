import * as path from "node:path";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
} from "discord.js";
import type { BridgeSession } from "../types";
import { COLORS, LOG_PREFIX } from "../constants";

/** Format a byte count as a human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Sanitize a filename to prevent path traversal */
function sanitizeFilename(name: string): string {
  // Strip path components — only keep the basename
  let safe = path.basename(name);
  // Remove any remaining traversal patterns
  safe = safe.replace(/\.\./g, "_");
  return safe || "unnamed";
}

/** Build a file confirmation embed with "Ask Claude" button */
function buildFileConfirmEmbed(
  filename: string,
  size: number,
  contentType: string,
  savedPath: string,
  sessionId: string,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const embed = new EmbedBuilder()
    .setColor(COLORS.GREEN)
    .setTitle("📎 File Received")
    .setDescription("✅ Available to Claude in this session")
    .addFields(
      { name: "File", value: filename, inline: true },
      { name: "Size", value: formatBytes(size), inline: true },
      { name: "Type", value: contentType || "unknown", inline: true },
      { name: "Saved to", value: `\`${savedPath}\`` },
    );

  // Custom IDs limited to 100 chars — truncate filename if needed
  const prefix = `file_ask_${sessionId}_`;
  const maxFilenameLen = 100 - prefix.length;
  const truncatedName = filename.length > maxFilenameLen
    ? filename.slice(0, maxFilenameLen)
    : filename;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}${truncatedName}`)
      .setLabel("Ask Claude About This File")
      .setEmoji("💬")
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB (Discord's non-Nitro upload limit)

/** Handle file attachments on a message in a session forum post */
export async function handleFileAttachment(
  message: Message,
  session: BridgeSession,
): Promise<void> {
  for (const attachment of message.attachments.values()) {
    try {
      // Reject oversized files
      if (attachment.size > MAX_FILE_SIZE) {
        await message.reply(`❌ File \`${attachment.name}\` is too large (${formatBytes(attachment.size)}). Max: 25 MB.`).catch(() => {});
        continue;
      }

      const filename = sanitizeFilename(attachment.name ?? "unnamed");
      const savePath = path.join(session.cwd, filename);

      // Download and save the file
      const response = await fetch(attachment.url);
      if (!response.ok) {
        await message.reply(`❌ Failed to download \`${filename}\` (HTTP ${response.status}).`).catch(() => {});
        continue;
      }
      const buffer = await response.arrayBuffer();
      await Bun.write(savePath, buffer);

      // Send confirmation embed with "Ask Claude" button
      const { embeds, components } = buildFileConfirmEmbed(
        filename,
        attachment.size,
        attachment.contentType ?? "unknown",
        savePath,
        session.sessionId,
      );

      await message.reply({ embeds, components });
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to handle file attachment:`, err);
      await message.reply("❌ Failed to save file.").catch(() => {});
    }
  }
}
