import { EmbedBuilder, type Client } from "discord.js";
import { COLORS, LOG_PREFIX } from "./constants";

const AWAY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_CHECK_INTERVAL_MS = 60 * 1000; // Check every minute
const BATCH_AWAY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes for early batch send
const BATCH_MIN_EVENTS = 3; // Minimum events to trigger early batch send
const MAX_PENDING_EVENTS = 20; // Cap per user

export interface AwayEvent {
  type: "completed" | "error" | "needs_input" | "working" | "info";
  sessionName: string;
  sessionForumPostId: string;
  summary: string;
  timestamp: number;
}

/**
 * Tracks user activity in Discord and accumulates significant events
 * while the user is away. Sends a DM summary when they return or
 * after a batch of events have accumulated.
 */
export class AwayTracker {
  private lastSeen = new Map<string, number>();
  private pendingEvents = new Map<string, AwayEvent[]>();
  private batchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private client: Client,
    private guildOwnerId: string,
  ) {
    // Initialize guild owner as "seen" so events before first interaction aren't queued
    this.lastSeen.set(guildOwnerId, Date.now());
  }

  /** Start the periodic batch-check timer */
  start(): void {
    this.batchTimer = setInterval(() => {
      this.checkAndSendBatched().catch((err) => {
        console.error(`${LOG_PREFIX} Away tracker batch check error:`, err);
      });
    }, BATCH_CHECK_INTERVAL_MS);
  }

  /** Stop the batch-check timer */
  destroy(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Mark a user as active. Called on any message or button click.
   * If transitioning from away to active with pending events, sends DM summary.
   */
  markActive(userId: string): void {
    const wasAway = this.isAway(userId);
    this.lastSeen.set(userId, Date.now());

    // If transitioning away -> active and has pending events, send summary
    if (wasAway && this.pendingEvents.has(userId)) {
      // Clear synchronously to prevent double-send from rapid markActive calls
      const events = this.pendingEvents.get(userId);
      this.pendingEvents.delete(userId);
      if (events && events.length > 0) {
        this.sendAwaySummaryForEvents(userId, events).catch((err) => {
          console.error(`${LOG_PREFIX} Failed to send away summary on return:`, err);
        });
      }
    }
  }

  /** Check if a user is away (no activity for 5+ minutes) */
  isAway(userId: string): boolean {
    const last = this.lastSeen.get(userId);
    if (!last) return true; // Never seen = assume away
    return Date.now() - last > AWAY_THRESHOLD_MS;
  }

  /** Add an event to a user's pending list (only if they're away) */
  addEvent(userId: string, event: AwayEvent): void {
    if (!this.isAway(userId)) return;

    const events = this.pendingEvents.get(userId) ?? [];
    events.push(event);

    // Cap at MAX_PENDING_EVENTS — drop oldest
    if (events.length > MAX_PENDING_EVENTS) {
      events.splice(0, events.length - MAX_PENDING_EVENTS);
    }

    this.pendingEvents.set(userId, events);
  }

  /** Send DM summary to user and clear their pending events */
  async sendAwaySummary(userId: string): Promise<void> {
    const events = this.pendingEvents.get(userId);
    if (!events || events.length === 0) return;

    // Clear immediately to prevent double-send
    this.pendingEvents.delete(userId);
    await this.sendAwaySummaryForEvents(userId, events);
  }

  /** Send a DM with the given events list */
  private async sendAwaySummaryForEvents(userId: string, events: AwayEvent[]): Promise<void> {
    const lines = events.map((e) => {
      const emoji =
        e.type === "completed" ? "\u2705" :
        e.type === "error" ? "\uD83D\uDD34" :
        e.type === "needs_input" ? "\uD83D\uDD14" :
        e.type === "working" ? "\uD83D\uDFE1" : "\u2139\uFE0F";
      return `${emoji} **${e.sessionName}** \u2014 ${e.summary}`;
    });

    const description = lines.join("\n").slice(0, 4000);

    try {
      const user = await this.client.users.fetch(userId);
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.BLUE)
            .setTitle("While you were away:")
            .setDescription(description)
            .setTimestamp(),
        ],
      });
    } catch (err) {
      // DMs might be disabled — nothing we can do
      console.error(`${LOG_PREFIX} Failed to send away summary DM:`, err);
    }
  }

  /**
   * Periodic check: if user has been away for 10+ min with 3+ events, send early.
   * Prevents events from sitting indefinitely if the user never returns to Discord.
   */
  private async checkAndSendBatched(): Promise<void> {
    // Collect IDs first to avoid modifying map during iteration
    const toSend: string[] = [];
    for (const [userId, events] of this.pendingEvents.entries()) {
      if (events.length === 0) continue;

      const last = this.lastSeen.get(userId);
      const awayDuration = last ? Date.now() - last : Infinity;

      if (awayDuration >= BATCH_AWAY_THRESHOLD_MS && events.length >= BATCH_MIN_EVENTS) {
        toSend.push(userId);
      }
    }
    for (const userId of toSend) {
      await this.sendAwaySummary(userId);
    }
  }
}
