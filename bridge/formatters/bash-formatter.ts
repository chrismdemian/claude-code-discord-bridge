import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { COLORS, MAX_EMBED_DESCRIPTION } from "../constants";
import { extractResultText, truncate, wrapCodeBlock } from "./utils";

/** Threshold for attaching output as a .log file (bytes). Below this, splitMessage handles it. */
const FILE_ATTACHMENT_THRESHOLD = 8000;

export function formatBashCall(toolUse: ToolUseBlock): FormattedMessage {
  const command = truncate(String(toolUse.input.command ?? "..."), 900);
  return {
    webhook: "claude",
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
  // Filter out the "no output" placeholder — not useful in Discord
  if (/^\(Bash completed with no output\)$/i.test(text.trim())) return null;

  // Error: red embed with stderr
  if (result.is_error) {
    const embed = new EmbedBuilder()
      .setTitle("🔴 Command Failed")
      .setColor(COLORS.RED)
      .setDescription(wrapCodeBlock(truncate(text, MAX_EMBED_DESCRIPTION - 20), "ansi"));

    if (toolUse.input.command) {
      embed.addFields({
        name: "Command",
        value: `\`${truncate(String(toolUse.input.command), 900)}\``,
        inline: false,
      });
    }

    return { webhook: "claude", embeds: [embed] };
  }

  // Short/medium output: send as content — splitMessage handles chunking
  if (text.length <= FILE_ATTACHMENT_THRESHOLD) {
    return {
      webhook: "claude",
      content: wrapCodeBlock(text, "ansi"),
    };
  }

  // Very long output: preview + .log attachment for the full content
  const previewLines = text.split("\n").slice(0, 40).join("\n");
  const preview = `${previewLines}\n... (full output in attached log)`;
  const attachment = new AttachmentBuilder(Buffer.from(text, "utf-8"), {
    name: "output.log",
  });

  return {
    webhook: "claude",
    content: wrapCodeBlock(preview, "ansi"),
    files: [attachment],
  };
}
