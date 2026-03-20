import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import type { MessageSender } from "./message-sender";
import type {
  BridgeSession,
  DiscordConfig,
  PermissionRequestHook,
  SessionEndHook,
  StopHook,
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

/**
 * Receives and processes hook events POSTed by Claude Code (HTTP hooks)
 * and by hook scripts (command hooks like permission-request.ts).
 *
 * Posts formatted embeds/messages to the session's Discord forum post.
 * Manages the permission approval queue for Phase 8 button integration.
 */
export class HookReceiver {
  private permissionResolvers = new Map<
    string,
    (approved: boolean) => void
  >();

  constructor(
    private sessions: Map<string, BridgeSession>,
    private sender: MessageSender,
    private client: Client,
    private discordConfig: DiscordConfig,
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
        return this.handleStop(payload as StopHook);
      case "StopFailure":
        return this.handleStopFailure(payload as StopFailureHook);
      case "PostToolUse":
        // No-op: transcript tailing handles tool output display
        return { ok: true };
      case "PostToolUseFailure":
        return this.handlePostToolUseFailure(
          payload as PostToolUseFailureHook,
        );
      case "PreCompact":
        return this.handlePreCompact(payload);
      case "PostCompact":
        return this.handlePostCompact(payload as PostCompactHook);
      case "SubagentStart":
        return this.handleSubagentStart(payload as SubagentStartHook);
      case "SubagentStop":
        return this.handleSubagentStop(payload as SubagentStopHook);
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
   * Resolve a pending permission request. Called by Phase 8's Discord
   * button interaction handler when user clicks Approve/Deny.
   */
  resolvePermission(sessionId: string, approved: boolean): void {
    const resolver = this.permissionResolvers.get(sessionId);
    if (resolver) {
      resolver(approved);
      this.permissionResolvers.delete(sessionId);
    }
  }

  /** Check if a session has a pending permission request */
  hasPendingPermission(sessionId: string): boolean {
    return this.permissionResolvers.has(sessionId);
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

    await this.sender.sendEmbed("system", session.forumPostId, embed);
    return { ok: true };
  }

  private async handlePermissionRequest(
    payload: PermissionRequestHook,
  ): Promise<{ approved: boolean }> {
    const session = this.sessions.get(payload.session_id);

    // Build a display string for what Claude wants to do
    const description =
      payload.description ??
      formatPermissionDescription(payload.tool_name, payload.tool_input);

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
      .setFooter({
        text: "Auto-approved (interactive buttons coming in Phase 8)",
      })
      .setTimestamp();

    if (session) {
      await this.sender.sendEmbed("system", session.forumPostId, embed);
    }

    // Phase 6: auto-approve immediately.
    // Phase 8 will replace this with a promise that waits for button clicks.
    return { approved: true };
  }

  private async handleStop(payload: StopHook): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    let text = "⏹️ Claude stopped";
    if (payload.last_assistant_message) {
      const snippet = truncate(payload.last_assistant_message, 200);
      text += `\n> ${snippet}`;
    }

    await this.sender.sendAsWebhook("system", session.forumPostId, text);
    return { ok: true };
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
      await this.sender.sendEmbed("system", session.forumPostId, embed);
    }

    // Send to #alerts for high-severity failures
    if (ALERT_FAILURE_TYPES.has(failureType)) {
      await this.sendAlert(
        `🔴 Session "${session?.sessionId.slice(0, 8) ?? "unknown"}" — ${formatFailureType(failureType)}${payload.error ? `: ${truncate(payload.error, 200)}` : ""}`,
      );
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

    await this.sender.sendEmbed("system", session.forumPostId, embed);
    return { ok: true };
  }

  private async handlePreCompact(
    payload: PreCompactHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    await this.sender.sendAsWebhook(
      "system",
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

    await this.sender.sendEmbed("system", session.forumPostId, embed);
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
      text += `\n> ${truncate(payload.prompt, 150)}`;
    }

    await this.sender.sendAsWebhook("system", session.forumPostId, text);
    return { ok: true };
  }

  private async handleSubagentStop(
    payload: SubagentStopHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    let text = "🤖 Agent finished";
    if (payload.result) {
      text += `\n> ${truncate(payload.result, 200)}`;
    }

    await this.sender.sendAsWebhook("system", session.forumPostId, text);
    return { ok: true };
  }

  private async handleNotification(
    payload: NotificationHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const notifType = payload.notification_type ?? "notification";
    const message = payload.message ?? "";
    const text = `🔔 **${notifType}**: ${truncate(message, 500)}`;

    await this.sender.sendAsWebhook("system", session.forumPostId, text);
    return { ok: true };
  }

  private async handleTaskCompleted(
    payload: TaskCompletedHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const taskName = payload.task_name ?? payload.task_id ?? "task";
    await this.sender.sendAsWebhook(
      "system",
      session.forumPostId,
      `✅ Task completed: **${taskName}**`,
    );
    return { ok: true };
  }

  private async handleTeammateIdle(
    payload: TeammateIdleHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const teammateId = payload.teammate_id ?? "teammate";
    await this.sender.sendAsWebhook(
      "system",
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
    await this.sender.sendAsWebhook(
      "system",
      session.forumPostId,
      `⚙️ Config changed: **${key}**`,
    );
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

    await this.sender.sendEmbed("system", session.forumPostId, embed);
    return { ok: true };
  }

  private async handleWorktreeRemove(
    payload: WorktreeRemoveHook,
  ): Promise<{ ok: true }> {
    const session = this.sessions.get(payload.session_id);
    if (!session) return { ok: true };

    const name = payload.name ?? "unknown";
    await this.sender.sendAsWebhook(
      "system",
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

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

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
