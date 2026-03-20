import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { COLORS, MAX_CONTENT_LENGTH, MAX_EMBED_DESCRIPTION } from "../constants";
import { extractResultText, truncate, wrapCodeBlock } from "./utils";

export function formatBashCall(toolUse: ToolUseBlock): FormattedMessage {
  const command = truncate(String(toolUse.input.command ?? "..."), 200);
  return {
    webhook: "terminal",
    content: `🖥️ \`$ ${command}\``,
  };
}

export function formatBashResult(
  toolUse: ToolUseBlock,
  result: ToolResultBlock,
  _session: BridgeSession,
): FormattedMessage | null {
  const text = extractResultText(result.content);
  if (!text.trim()) return null;

  // Error: red embed with stderr
  if (result.is_error) {
    const embed = new EmbedBuilder()
      .setTitle("🔴 Command Failed")
      .setColor(COLORS.RED)
      .setDescription(wrapCodeBlock(truncate(text, MAX_EMBED_DESCRIPTION - 20), "ansi"));

    if (toolUse.input.command) {
      embed.addFields({
        name: "Command",
        value: `\`${truncate(String(toolUse.input.command), 200)}\``,
        inline: false,
      });
    }

    return { webhook: "terminal", embeds: [embed] };
  }

  // Short output: inline code block
  if (text.length <= MAX_CONTENT_LENGTH - 20) {
    return {
      webhook: "terminal",
      content: wrapCodeBlock(text, "ansi"),
    };
  }

  // Long output: truncated preview + .log attachment
  const preview = text.slice(0, MAX_CONTENT_LENGTH - 60) + "\n... (truncated, see attached log)";
  const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), {
    name: "output.log",
  });

  return {
    webhook: "terminal",
    content: wrapCodeBlock(preview, "ansi"),
    files: [attachment],
  };
}
