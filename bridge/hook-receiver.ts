import { EmbedBuilder, type Client, type TextChannel, type ThreadChannel } from "discord.js";
import type { MessageSender } from "./message-sender";
import type {
  BridgeSession,
  DiscordConfig,
  PermissionRequestHook,
  SessionEndHook,
  StopFailureHook,
  PostToolUseFailureHook,
  PreCompactHook,
  PostCompactHook,
  SubagentStartHook,
  SubagentStopHook,
  NotificationHook,
  TaskCompletedHook,
  TeammateIdleHook,
  ConfigChangeHook,
  WorktreeCreateHook,
  WorktreeRemoveHook,
} from "./types";
import { COLORS, LOG_PREFIX } from "./constants";
import { truncate, formatDuration } from "./formatters/utils";
import {
  buildPermissionEmbed,
  buildTimeoutEmbed,
} from "./interactions/permission-handler";
import { trackForAwaySummary, classifyNotification, NotificationTier } from "./notifications";
import type { AwayTracker } from "./away-tracker";

/** Map URL slugs from hooks.json to canonical hook type names */
const SLUG_TO_HOOK: Record<string, string> = {
  "session-start": "SessionStart",
  "session-end": "SessionEnd",
  "permission-request": "PermissionRequest",
  stop: "Stop",
  "stop-failure": "StopFailure",
  "post-tool-use": "PostToolUse",
  "post-tool-use-failure": "PostToolUseFailure",
  "pre-compact": "PreCompact",
  "post-compact": "PostCompact",
  "subagent-start": "SubagentStart",
  "subagent-stop": "SubagentStop",
  notification: "Notification",
  "user-prompt-submit": "UserPromptSubmit",
  "task-completed": "TaskCompleted",
  "teammate-idle": "TeammateIdle",
  "config-change": "ConfigChange",
  "worktree-create": "WorktreeCreate",
  "worktree-remove": "WorktreeRemove",
};

/** High-severity failure types that warrant an @mention in #alerts */
const ALERT_FAILURE_TYPES = new Set([
  "rate_limit",
  "authentication_failed",
  "billing_error",
  "server_error",
]);

/** State for a pending permission request awaiting Discord button click */
export interface PermissionResult {
  approved: boolean;
  allowForSession?: boolean;
}

export interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  messageId: string;
  forumPostId: string;
  toolInput: Record<string, unknown>;
  toolName: string;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Receives and processes hook events POSTed by Claude Code (HTTP hooks)
 * and by hook scripts (command hooks like permission-request.ts).
 *
 * Posts formatted embeds/messages to the session's Discord forum post.
 * Manages the permission approval flow with Discord buttons.
 */
export class HookReceiver {
  private pendingPermissions = new Map<string, PendingPermission>();

  constructor(
    private sessions: Map<string, BridgeSession>,
    private sender: MessageSender,
    private client: Client,
    private discordConfig: DiscordConfig,
    private awayTracker?: AwayTracker,
    private guildOwnerId?: string,
  ) {}

  /**
   * Main dispatcher. Called by the HTTP server for every POST /hooks/{slug}.
   * @param slug - URL path slug (e.g. "session-start")
   * @param payload - Parsed JSON body from Claude Code
   * @returns Response object to send back (important for blocking hooks)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handleHook(slug: string, payload: any): Promise<unknown> {
    const hookType = SLUG_TO_HOOK[slug];
    if (!hookType) {
      console.warn(`${LOG_PREFIX} Unknown hook slug: ${slug}`);
      return { ok: true };
    }

    const sessionId = payload.session_id as string | undefined;
    if (sessionId) {
      console.log(`${LOG_PREFIX} Hook received: ${hookType} (session=${sessionId.slice(0, 8)})`);
    } else {
      console.log(`${LOG_PREFIX} Hook received: ${hookType} (no session_id)`);
    }

    switch (hookType) {
      case "SessionStart":
        return this.handleSessionStart(payload);
      case "SessionEnd":
        return this.handleSessionEnd(payload as SessionEndHook);
      case "PermissionRequest":
        return this.handlePermissionRequest(payload as PermissionRequestHook);
      case "Stop":
        // No-op: the Stop hook fires at the end of every Claude turn, not just
        // user-initiated stops. The transcript tailer already shows Claude's
        // response, so posting here would duplicate the last message and show
        // a misleading "Claude stopped" label on every normal response.
        return { ok: true };
      case "StopFailure":
        return this.handleStopFailure(payload as StopFailureHook);
      case "PostToolUse":
        // No-op: transcript tailing handles tool output display
        return { ok: true };
      case "PostToolUseFailure":
        // No-op: transcript tailer's formatters already show errors
        return { ok: true };
      case "PreCompact":
        return this.handlePreCompact(payload);
      case "PostCompact":
        return this.handlePostCompact(payload as PostCompactHook);
      case "SubagentStart":
        // No-op: transcript tailer's Agent tool formatter already shows the header
        return { ok: true };
      case "SubagentStop":
        // No-op: transcript tailer's Agent result formatter already shows completion
        return { ok: true };
      case "Notification":
        return this.handleNotification(payload as NotificationHook);
      case "UserPromptSubmit":
        // Allow all prompts — security validation deferred to Phase 12d
        return { ok: true };
      case "TaskCompleted":
        return this.handleTaskCompleted(payload as TaskCompletedHook);
      case "TeammateIdle":
        return this.handleTeammateIdle(payload);
      case "ConfigChange":
        return this.handleConfigChange(payload as ConfigChangeHook);
      case "WorktreeCreate":
        return this.handleWorktreeCreate(payload as WorktreeCreateHook);
      case "WorktreeRemove":
        return this.handleWorktreeRemove(payload as WorktreeRemoveHook);
      default:
        return { ok: true };
    }
  }

  /**
   * Resolve a pending permission request. Called by the Discord button
   * interaction handler when the user clicks Approve or Deny.
   */
  resolvePermission(sessionId: string, approved: boolean, allowForSession = false): void {
    const pending = this.pendingPermissions.get(sessionId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve({ approved, allowForSession });
      this.pendingPermissions.delete(sessionId);
    }
  }

  /** Check if a session has a pending permission request */
  hasPendingPermission(sessionId: string): boolean {
    return this.pendingPermissions.has(sessionId);
  }

  /** Get the pending permission data (for the interaction handler) */
  getPendingPermission(sessionId: string): PendingPermission | undefined {
    return this.pendingPermissions.get(sessionId);
  }

  /**
   * Clean up a pending permission on timeout or session end.
   * Updates the Discord embed to show "timed out" and auto-denies.
   */
  async clearPendingPermission(sessionId: string): Promise<void> {
    const pending = this.pendingPermissions.get(sessionId);
    if (!pending) return;

    // Delete from map first (before any async work) to prevent race
    // conditions where a button click arrives during the await below.
    this.pendingPermissions.delete(sessionId);
    clearTimeout(pending.timeout);
    pending.resolve({ approved: false });

    // Update the Discord embed to show timeout
    try {
      const channel = await this.client.channels.fetch(pending.forumPostId);
      if (channel?.isThread()) {
        const message = await (channel as ThreadChannel).messages.fetch(pending.messageId);
        if (message?.embeds[0]) {
          const timeoutEmbed = buildTimeoutEmbed(message.embeds[0]);
          await message.edit({ embeds: [timeoutEmbed], components: [] });
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to update timed-out permission embed:`, err);
    }
  }

  // ── Handler implementations ──────────────────────────────────────────

  private async handleSessionStart(
    payload: { session_id?: string },
  ): Promise<{ ok: true }> {
    // Session scanner already creates the forum post.
    // This hook confirms the session is live via structured data.
    const sessionId = payload.session_id;
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.lastActivity = Date.now();
      }
    }
    return { ok: true };
  }

  private async handleSessionEnd(
    payload: SessionEndHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const reason = payload.reason ?? "unknown";
    const startedMs = Number(session.startedAt) || new Date(session.startedAt).getTime();
    const durationMs = startedMs > 0 ? Date.now() - startedMs : 0;
    const durationStr = formatDuration(durationMs);

    const embed = new EmbedBuilder()
      .setTitle("Session Ended")
      .setColor(COLORS.GRAY)
      .addFields(
        { name: "Reason", value: reason, inline: true },
        { name: "Duration", value: durationStr, inline: true },
        {
          name: "Cost",
          value: `$${session.cost.toFixed(2)}`,
          inline: true,
        },
      )
      .setTimestamp();

    await this.sender.sendEmbed("claude", session.forumPostId, embed);

    trackForAwaySummary("SessionEnd", session, payload as Record<string, any>, this.awayTracker, this.guildOwnerId);

    return { ok: true };
  }

  private async handlePermissionRequest(
    payload: PermissionRequestHook,
  ): Promise<{ approved: boolean; allowForSession?: boolean }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { approved: false };

    // Build a display string for what Claude wants to do, with shortened paths
    let description =
      payload.description ??
      formatPermissionDescription(payload.tool_name, payload.tool_input);
    // Shorten absolute paths using the session's cwd
    if (session.cwd) {
      const cwd = session.cwd.replace(/\\/g, "/") + "/";
      const cwdLower = cwd.toLowerCase();
      let idx = description.toLowerCase().indexOf(cwdLower);
      while (idx !== -1) {
        description = description.slice(0, idx) + description.slice(idx + cwd.length);
        idx = description.toLowerCase().indexOf(cwdLower);
      }
      // Also backslash variant
      const cwdBs = session.cwd.replace(/\//g, "\\") + "\\";
      description = description.split(cwdBs).join("");
    }

    // Build embed with Approve/Allow for Session/Deny/Context buttons
    const { embeds, components } = buildPermissionEmbed(payload, description);

    // Send via bot client (not webhook) so InteractionCreate routes to us
    const channel = await this.client.channels.fetch(session.forumPostId);
    if (!channel?.isThread()) return { approved: false };

    const message = await (channel as ThreadChannel).send({ embeds, components });

    // Send @mention to #alerts so the user gets a phone notification
    const guild = await this.client.guilds.fetch(this.discordConfig.guildId);
    await this.sendAlert(
      `🔐 <@${guild.ownerId}> Permission request in <#${session.forumPostId}>`,
    );

    trackForAwaySummary("PermissionRequest", session, payload as Record<string, any>, this.awayTracker, this.guildOwnerId);

    // Wait for the user to click Approve/Allow for Session/Deny, or timeout after 9 minutes
    const result = await new Promise<PermissionResult>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pendingPermissions.has(payload.session_id)) {
          console.log(`${LOG_PREFIX} Permission timed out for session ${payload.session_id.slice(0, 8)}`);
          this.clearPendingPermission(payload.session_id);
        }
      }, 9 * 60 * 1000);

      this.pendingPermissions.set(payload.session_id, {
        resolve,
        messageId: message.id,
        forumPostId: session.forumPostId,
        toolInput: payload.tool_input,
        toolName: payload.tool_name,
        timeout,
      });
    });

    return result;
  }

  private async handleStopFailure(
    payload: StopFailureHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);

    const failureType = payload.failure_type ?? "unknown";
    const embed = new EmbedBuilder()
      .setTitle(`🔴 ${formatFailureType(failureType)}`)
      .setColor(COLORS.RED)
      .setTimestamp();

    if (payload.error) {
      embed.setDescription(
        `\`\`\`\n${truncate(payload.error, 1800)}\n\`\`\``,
      );
    }

    if (session) {
      embed.addFields({
        name: "Session",
        value: payload.session_id.slice(0, 18),
        inline: true,
      });
      await this.sender.sendEmbed("claude", session.forumPostId, embed);
    }

    // Send to #alerts for high-severity failures
    if (ALERT_FAILURE_TYPES.has(failureType)) {
      await this.sendAlert(
        `🔴 Session "${session?.sessionId.slice(0, 8) ?? "unknown"}" — ${formatFailureType(failureType)}${payload.error ? `: ${truncate(payload.error, 200)}` : ""}`,
      );
    }

    if (session) {
      trackForAwaySummary("StopFailure", session, payload as Record<string, any>, this.awayTracker, this.guildOwnerId);
    }

    return { ok: true };
  }

  private async handlePostToolUseFailure(
    payload: PostToolUseFailureHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const toolName = payload.tool_name ?? "Unknown";
    const embed = new EmbedBuilder()
      .setTitle(`🔴 Tool Failed: ${toolName}`)
      .setColor(COLORS.RED)
      .setTimestamp();

    if (payload.error) {
      embed.setDescription(
        `\`\`\`\n${truncate(payload.error, 1800)}\n\`\`\``,
      );
    }

    await this.sender.sendEmbed("claude", session.forumPostId, embed);

    trackForAwaySummary("PostToolUseFailure", session, payload as Record<string, any>, this.awayTracker, this.guildOwnerId);

    return { ok: true };
  }

  private async handlePreCompact(
    payload: PreCompactHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    await this.sender.sendAsWebhook(
      "claude",
      session.forumPostId,
      "🗜️ Compacting context...",
    );
    return { ok: true };
  }

  private async handlePostCompact(
    payload: PostCompactHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const embed = new EmbedBuilder()
      .setTitle("🗜️ Context Compacted")
      .setColor(COLORS.GRAY)
      .setTimestamp();

    const parts: string[] = [];
    if (payload.tokens_before != null && payload.tokens_after != null) {
      const before = Math.round(payload.tokens_before / 1000);
      const after = Math.round(payload.tokens_after / 1000);
      parts.push(`${before}k → ${after}k tokens`);
    }
    if (payload.compact_summary) {
      parts.push(`\nSummary: "${truncate(payload.compact_summary, 300)}"`);
    }
    if (parts.length > 0) {
      embed.setDescription(parts.join("\n"));
    }

    await this.sender.sendEmbed("claude", session.forumPostId, embed);

    trackForAwaySummary("PostCompact", session, payload as Record<string, any>, this.awayTracker, this.guildOwnerId);

    return { ok: true };
  }

  private async handleSubagentStart(
    payload: SubagentStartHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const agentType = payload.agent_type ?? "agent";
    let text = `🤖 Agent spawned: **${agentType}**`;
    if (payload.prompt) {
      text += `\n> ${truncate(payload.prompt, 1500)}`;
    }

    await this.sender.sendAsWebhook("claude", session.forumPostId, text);
    return { ok: true };
  }

  private async handleSubagentStop(
    payload: SubagentStopHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    let text = "🤖 Agent finished";
    if (payload.result) {
      text += `\n> ${truncate(payload.result, 1500)}`;
    }

    await this.sender.sendAsWebhook("claude", session.forumPostId, text);
    return { ok: true };
  }

  private async handleNotification(
    payload: NotificationHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const notifType = payload.notification_type ?? "notification";
    const message = payload.message ?? "";

    // Suppress noise notifications — these are handled by other UI or not useful
    if (notifType === "idle_prompt") return { ok: true };
    if (notifType === "permission_prompt") return { ok: true };

    const text = `🔔 **${notifType}**: ${truncate(message, 1800)}`;

    await this.sender.sendAsWebhook("claude", session.forumPostId, text);

    // For PING-tier notifications (questions, idle prompts), also send to #alerts
    const tier = classifyNotification("Notification", payload as Record<string, any>);
    if (tier === NotificationTier.PING && this.guildOwnerId) {
      await this.sendAlert(
        `🔔 <@${this.guildOwnerId}> ${text} → <#${session.forumPostId}>`,
      );
    }

    trackForAwaySummary("Notification", session, payload as Record<string, any>, this.awayTracker, this.guildOwnerId);

    return { ok: true };
  }

  private async handleTaskCompleted(
    payload: TaskCompletedHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const taskName = payload.task_name ?? payload.task_id ?? "task";
    await this.sender.sendAsWebhook(
      "claude",
      session.forumPostId,
      `✅ Task completed: **${taskName}**`,
    );

    trackForAwaySummary("TaskCompleted", session, payload as Record<string, any>, this.awayTracker, this.guildOwnerId);

    return { ok: true };
  }

  private async handleTeammateIdle(
    payload: TeammateIdleHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const teammateId = payload.teammate_id ?? "teammate";
    await this.sender.sendAsWebhook(
      "claude",
      session.forumPostId,
      `🤖 Teammate idle: **${teammateId}**`,
    );
    return { ok: true };
  }

  private async handleConfigChange(
    payload: ConfigChangeHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const key = payload.key ?? "unknown";

    // Detect plan mode activation/deactivation
    if (key === "permissionMode" || key === "permission_mode" || key === "defaultMode") {
      const value = String(payload.value ?? "");
      if (value === "plan") {
        session.planMode = true;
        session.planSteps = [];
        session.planMessageId = null;
        session.planTitle = "";
        session.planCurrentStep = -1;
        session.planLastEditAt = 0;
        await this.sender.sendAsWebhook(
          "claude",
          session.forumPostId,
          "📋 Plan mode activated",
        );
      } else if (session.planMode) {
        // Exiting plan mode — keep planSteps/planMessageId for execution tracking
        session.planMode = false;
      }
      return { ok: true };
    }

    // Only show config changes with known keys — "unknown" is noise
    if (key !== "unknown") {
      await this.sender.sendAsWebhook(
        "claude",
        session.forumPostId,
        `⚙️ Config changed: **${key}**`,
      );
    }
    return { ok: true };
  }

  private async handleWorktreeCreate(
    payload: WorktreeCreateHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const embed = new EmbedBuilder()
      .setTitle("🌳 Worktree Created")
      .setColor(COLORS.BLUE)
      .setTimestamp();

    const fields: { name: string; value: string; inline: boolean }[] = [];
    if (payload.name)
      fields.push({ name: "Name", value: payload.name, inline: true });
    if (payload.branch)
      fields.push({ name: "Branch", value: payload.branch, inline: true });
    if (payload.path)
      fields.push({
        name: "Path",
        value: `\`${payload.path}\``,
        inline: false,
      });
    if (fields.length > 0) embed.addFields(fields);

    await this.sender.sendEmbed("claude", session.forumPostId, embed);
    return { ok: true };
  }

  private async handleWorktreeRemove(
    payload: WorktreeRemoveHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const name = payload.name ?? "unknown";
    await this.sender.sendAsWebhook(
      "claude",
      session.forumPostId,
      `🌳 Worktree removed: **${name}**`,
    );
    return { ok: true };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Send a message to the #alerts channel */
  private async sendAlert(content: string): Promise<void> {
    try {
      const channel = (await this.client.channels.fetch(
        this.discordConfig.alertsChannelId,
      )) as TextChannel;
      if (channel) {
        await channel.send(content);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to send alert:`, err);
    }
  }
}

// ── Utility functions ──────────────────────────────────────────────────

function formatFailureType(type: string): string {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatPermissionDescription(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  if (toolName === "Bash" && toolInput.command) {
    return String(toolInput.command);
  }
  if (toolName === "Write" && toolInput.file_path) {
    return `Write to ${toolInput.file_path}`;
  }
  if (toolName === "Edit" && toolInput.file_path) {
    return `Edit ${toolInput.file_path}`;
  }
  return `${toolName}: ${JSON.stringify(toolInput).slice(0, 300)}`;
}
