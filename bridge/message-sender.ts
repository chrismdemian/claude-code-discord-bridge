import {
  WebhookClient,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
  type WebhookMessageCreateOptions,
} from "discord.js";
import type { DiscordConfig } from "./types";
import { LOG_PREFIX } from "./constants";

type WebhookName = keyof DiscordConfig["webhooks"];

// Leave headroom for code block markers that splitMessage may append (```\n = 4 chars)
const MAX_MESSAGE_LENGTH = 1980;

/**
 * Sends messages to Discord via a single "Claude" webhook with automatic
 * message splitting. Differentiation between tool types happens through
 * emoji prefixes and embed colors in the formatters.
 */
export class MessageSender {
  private clients: Map<string, WebhookClient>;

  constructor(webhooks: DiscordConfig["webhooks"]) {
    this.clients = new Map();
    for (const [name, ref] of Object.entries(webhooks)) {
      this.clients.set(name, new WebhookClient({ id: ref.id, token: ref.token }));
    }
    console.log(
      `${LOG_PREFIX} MessageSender initialized with ${this.clients.size} webhooks`,
    );
  }

  /** Send a text message via a named webhook into a forum post thread.
   *  Returns the message ID of the first chunk (for later editing). */
  async sendAsWebhook(
    webhookName: WebhookName,
    threadId: string,
    content: string,
    options?: Partial<WebhookMessageCreateOptions>,
  ): Promise<string | undefined> {
    const client = this.clients.get(webhookName);
    if (!client) {
      console.error(`${LOG_PREFIX} Unknown webhook: ${webhookName}`);
      return undefined;
    }

    if (!content.trim()) return undefined;
    const chunks = splitMessage(content, MAX_MESSAGE_LENGTH);
    let firstMessageId: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      try {
        // Only attach embeds/files to the first chunk to avoid duplicates
        const chunkOptions = i === 0 ? options : undefined;
        const msg = await client.send({
          content: chunks[i],
          threadId,
          flags: MessageFlags.SuppressNotifications,
          ...chunkOptions,
        });
        if (i === 0) firstMessageId = msg.id;
      } catch (err) {
        console.error(
          `${LOG_PREFIX} Failed to send via ${webhookName} webhook:`,
          err,
        );
      }
    }
    return firstMessageId;
  }

  /** Send an embed via a named webhook */
  async sendEmbed(
    webhookName: WebhookName,
    threadId: string,
    embed: EmbedBuilder,
  ): Promise<void> {
    const client = this.clients.get(webhookName);
    if (!client) return;

    try {
      await client.send({ embeds: [embed], threadId, flags: MessageFlags.SuppressNotifications });
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to send embed via ${webhookName}:`,
        err,
      );
    }
  }

  /** Delete a webhook message */
  async deleteMessage(
    webhookName: WebhookName,
    messageId: string,
    threadId: string,
  ): Promise<void> {
    const client = this.clients.get(webhookName);
    if (!client) return;

    try {
      await client.deleteMessage(messageId, threadId);
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to delete message ${messageId} via ${webhookName}:`,
        err,
      );
    }
  }

  /** Edit an existing webhook message */
  async editMessage(
    webhookName: WebhookName,
    messageId: string,
    threadId: string,
    newContent: string,
  ): Promise<void> {
    const client = this.clients.get(webhookName);
    if (!client) return;

    try {
      await client.editMessage(messageId, {
        content: newContent,
        threadId,
      });
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to edit message ${messageId} via ${webhookName}:`,
        err,
      );
    }
  }

  /** Send a file attachment via a named webhook */
  async sendFile(
    webhookName: WebhookName,
    threadId: string,
    attachment: AttachmentBuilder,
    content?: string,
  ): Promise<void> {
    const client = this.clients.get(webhookName);
    if (!client) return;

    try {
      await client.send({
        files: [attachment],
        content,
        threadId,
        flags: MessageFlags.SuppressNotifications,
      });
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to send file via ${webhookName}:`,
        err,
      );
    }
  }

  /** Get a raw webhook client by name (for direct send operations) */
  getClient(webhookName: string): WebhookClient | undefined {
    return this.clients.get(webhookName);
  }

  /** Clean up all webhook clients */
  destroy(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
  }
}

/**
 * Split text into chunks that fit within Discord's message limit.
 * Priority: split at newlines > spaces > hard cut.
 * Handles code block boundaries (closes/reopens ``` across chunks).
 */
export function splitMessage(
  text: string,
  maxLength: number = MAX_MESSAGE_LENGTH,
): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = "";

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = -1;

    // Try to split at a newline
    const searchRegion = remaining.slice(0, maxLength);
    const lastNewline = searchRegion.lastIndexOf("\n");
    if (lastNewline > maxLength * 0.3) {
      splitIdx = lastNewline + 1; // include the newline in the current chunk
    }

    // Fall back to space
    if (splitIdx === -1) {
      const lastSpace = searchRegion.lastIndexOf(" ");
      if (lastSpace > maxLength * 0.3) {
        splitIdx = lastSpace + 1;
      }
    }

    // Hard cut as last resort
    if (splitIdx === -1) {
      splitIdx = maxLength;
    }

    let chunk = remaining.slice(0, splitIdx);
    remaining = remaining.slice(splitIdx);

    // Handle code block boundaries
    const codeBlockMatches = chunk.match(/```/g);
    if (codeBlockMatches) {
      const count = codeBlockMatches.length;
      if (count % 2 !== 0) {
        // Odd number of ``` — code block is split across chunks
        if (inCodeBlock) {
          // We were in a code block and it's closing + opening a new one,
          // or just closing. Either way, the state toggles.
          inCodeBlock = false;
        } else {
          // Opening a code block that doesn't close in this chunk
          // Extract the language hint from the opening ```
          const openMatch = chunk.match(/```(\w*)\n?/);
          codeBlockLang = openMatch?.[1] ?? "";
          // Close the code block at end of this chunk
          chunk += "\n```";
          // Prepend opening to next chunk
          remaining = `\`\`\`${codeBlockLang}\n` + remaining;
          inCodeBlock = true;
        }
      }
    } else if (inCodeBlock && remaining.length > 0) {
      // Still inside a code block from a previous split, chunk has no ```
      chunk += "\n```";
      remaining = `\`\`\`${codeBlockLang}\n` + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}
