import * as path from "node:path";
import { EmbedBuilder, type Client, type TextChannel, type Message } from "discord.js";
import type { BridgeSession } from "./types";
import { COLORS, LOG_PREFIX } from "./constants";
import { formatDuration } from "./formatters/utils";

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds
const DEBOUNCE_MS = 2_000; // 2 seconds

/**
 * Manages a single pinned embed in the #dashboard channel that shows
 * all active Claude Code sessions at a glance. Auto-refreshes every 30s
 * and on session state changes.
 */
export class Dashboard {
  private dashboardMessageId: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmbedJson = "";
  private updating = false;

  constructor(
    private sessions: Map<string, BridgeSession>,
    private client: Client,
    private dashboardChannelId: string,
  ) {}

  /** Initialize: find or create the pinned dashboard message, start refresh timer */
  async initialize(): Promise<void> {
    try {
      const channel = await this.fetchChannel();
      if (!channel) return;

      // Look for an existing bot-pinned message
      this.dashboardMessageId = await this.findPinnedMessage(channel);

      if (this.dashboardMessageId) {
        console.log(`${LOG_PREFIX} Dashboard: reusing pinned message ${this.dashboardMessageId}`);
        await this.updateMessage();
      } else {
        // Create a new message and pin it
        const embed = this.buildEmbed();
        const msg = await channel.send({ embeds: [embed] });
        await msg.pin().catch(() => {});
        this.dashboardMessageId = msg.id;
        this.lastEmbedJson = JSON.stringify(embed.toJSON());
        console.log(`${LOG_PREFIX} Dashboard: created and pinned message ${msg.id}`);
      }

      // Start periodic refresh
      this.refreshTimer = setInterval(() => {
        this.updateMessage().catch((err) => {
          console.error(`${LOG_PREFIX} Dashboard refresh error:`, err);
        });
      }, REFRESH_INTERVAL_MS);
    } catch (err) {
      console.error(`${LOG_PREFIX} Dashboard initialization failed:`, err);
    }
  }

  /** Stop the periodic refresh timer */
  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Trigger a debounced immediate update (called on session state changes) */
  async refresh(): Promise<void> {
    if (this.debounceTimer) return; // Already scheduled

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.updateMessage().catch((err) => {
        console.error(`${LOG_PREFIX} Dashboard refresh error:`, err);
      });
    }, DEBOUNCE_MS);
  }

  /** Build the dashboard embed from current session state */
  private buildEmbed(): EmbedBuilder {
    const activeSessions = Array.from(this.sessions.values());

    const lines = activeSessions.map((s) => {
      const statusEmoji =
        s.status === "active" ? "\uD83D\uDFE2" :
        s.status === "working" ? "\uD83D\uDFE1" :
        s.status === "error" ? "\uD83D\uDD34" : "\u2B1C";
      const projectName = path.basename(s.cwd);
      const statusText = s.status === "error" ? "needs input" : s.status;
      const ago = formatDuration(Math.max(0, Date.now() - s.lastActivity));
      const costStr = `$${s.cost.toFixed(2)}`;
      return `${statusEmoji} **${projectName}**  \`${statusText}\`  ${ago} ago  ${costStr}`;
    });

    const totalCost = activeSessions.reduce((sum, s) => sum + s.cost, 0);
    const description = lines.length > 0 ? lines.join("\n") : "*No active sessions*";

    return new EmbedBuilder()
      .setColor(COLORS.BLUE)
      .setTitle("Claude Code Sessions")
      .setDescription(description)
      .setFooter({
        text: `Active: ${activeSessions.length}  |  Today: $${totalCost.toFixed(2)}`,
      });
  }

  /** Find an existing bot-pinned message in the dashboard channel */
  private async findPinnedMessage(channel: TextChannel): Promise<string | null> {
    try {
      const pinned = await channel.messages.fetchPinned();
      const botId = this.client.user?.id;
      if (!botId) return null;

      const botPinned = pinned.find((m: Message) => m.author.id === botId);
      return botPinned?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Fetch the dashboard text channel */
  private async fetchChannel(): Promise<TextChannel | null> {
    try {
      const channel = await this.client.channels.fetch(this.dashboardChannelId);
      if (channel && "send" in channel) return channel as TextChannel;
      return null;
    } catch {
      return null;
    }
  }

  /** Update the dashboard message (edit in-place) */
  private async updateMessage(): Promise<void> {
    if (this.updating || !this.dashboardMessageId) return;
    this.updating = true;

    try {
      const embed = this.buildEmbed();
      const embedJson = JSON.stringify(embed.toJSON());

      // Skip edit if nothing changed (timestamp added after comparison)
      if (embedJson === this.lastEmbedJson) return;
      this.lastEmbedJson = embedJson;

      // Add timestamp only when actually sending the update
      embed.setTimestamp();

      const channel = await this.fetchChannel();
      if (!channel) return;

      const msg = await channel.messages.fetch(this.dashboardMessageId).catch(() => null);
      if (!msg) {
        // Message was deleted — recreate and re-pin
        console.log(`${LOG_PREFIX} Dashboard message deleted, recreating...`);
        this.dashboardMessageId = null;
        this.lastEmbedJson = "";
        const newMsg = await channel.send({ embeds: [embed] });
        await newMsg.pin().catch(() => {});
        this.dashboardMessageId = newMsg.id;
        this.lastEmbedJson = embedJson;
        return;
      }

      await msg.edit({ embeds: [embed] });
    } catch (err: unknown) {
      // Handle deleted message (Discord error code 10008)
      if (err && typeof err === "object" && "code" in err && (err as { code: number }).code === 10008) {
        console.log(`${LOG_PREFIX} Dashboard message not found (10008), will recreate`);
        this.dashboardMessageId = null;
        this.lastEmbedJson = "";
      } else {
        console.error(`${LOG_PREFIX} Dashboard update failed:`, err);
      }
    } finally {
      this.updating = false;
    }
  }
}
