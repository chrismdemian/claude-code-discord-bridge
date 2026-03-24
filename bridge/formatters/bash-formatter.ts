import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import type { ToolUseBlock, ToolResultBlock, BridgeSession, FormattedMessage } from "../types";
import { COLORS, MAX_EMBED_DESCRIPTION } from "../constants";
import { extractResultText, truncate, wrapCodeBlock } from "./utils";

/** Threshold for attaching output as a .log file. Keep low to avoid multi-message floods on mobile. */
const FILE_ATTACHMENT_THRESHOLD = 1500;

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
  let text = extractResultText(result.content);
  // Strip "Shell cwd was reset" lines from bash output
  text = text.split("\n").filter(l => !l.startsWith("Shell cwd was reset")).join("\n");
  if (!text.trim()) return null;
  // Filter out the "no output" placeholder — not useful in Discord
  if (/^\(Bash completed with no output\)$/i.test(text.trim())) return null;

  // Error: red embed with stderr (truncated for mobile)
  if (result.is_error) {
    const embed = new EmbedBuilder()
      .setTitle("🔴 Command Failed")
      .setColor(COLORS.RED)
      .setDescription(wrapCodeBlock(truncate(text, 500), "ansi"));

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
