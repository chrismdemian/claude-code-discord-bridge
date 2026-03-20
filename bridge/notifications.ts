import * as path from "node:path";
import type { BridgeSession } from "./types";
import type { AwayTracker, AwayEvent } from "./away-tracker";
import { truncate, formatDuration } from "./formatters/utils";

/** Notification tiers determine where and how loudly an event is surfaced */
export enum NotificationTier {
  PING = "ping",
  VISIBLE = "visible",
  SILENT = "silent",
}

/** High-severity failure types that warrant PING tier */
const ALERT_FAILURE_TYPES = new Set([
  "rate_limit",
  "authentication_failed",
  "billing_error",
  "server_error",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPayload = Record<string, any>;

/**
 * Classify a hook event into a notification tier.
 * PING = @mention in #alerts + forum post
 * VISIBLE = message in forum post, no mention
 * SILENT = no-op until Phase 12a adds thread-per-turn
 */
export function classifyNotification(
  event: string,
  payload?: AnyPayload,
): NotificationTier {
  // PING tier — needs immediate attention
  if (event === "PermissionRequest") return NotificationTier.PING;
  if (event === "StopFailure") {
    const failureType = (payload?.failure_type as string) ?? "";
    if (ALERT_FAILURE_TYPES.has(failureType)) return NotificationTier.PING;
    return NotificationTier.VISIBLE;
  }
  if (event === "Notification") {
    const message = (payload?.message as string) ?? "";
    const notifType = (payload?.notification_type as string) ?? "";
    if (
      notifType === "question" ||
      notifType === "permission_prompt" ||
      notifType === "idle_prompt"
    ) {
      return NotificationTier.PING;
    }
    if (message.endsWith("?") || /\b(please respond|waiting for|need your)\b/i.test(message)) {
      return NotificationTier.PING;
    }
    return NotificationTier.VISIBLE;
  }

  // VISIBLE tier — good to know, no urgency
  if (event === "SessionEnd") return NotificationTier.VISIBLE;
  if (event === "TaskCompleted") return NotificationTier.VISIBLE;
  if (event === "PostCompact") return NotificationTier.VISIBLE;
  if (event === "SubagentStop") return NotificationTier.VISIBLE;
  if (event === "WorktreeCreate") return NotificationTier.VISIBLE;
  if (event === "WorktreeRemove") return NotificationTier.VISIBLE;

  // SILENT tier — routine activity
  return NotificationTier.SILENT;
}

/** Map a hook event to an AwayEvent type */
export function toAwayEventType(
  event: string,
  payload?: AnyPayload,
): AwayEvent["type"] {
  switch (event) {
    case "SessionEnd":
      return "completed";
    case "TaskCompleted":
      return "completed";
    case "PermissionRequest":
      return "needs_input";
    case "StopFailure":
      return "error";
    case "PostToolUseFailure":
      return "error";
    case "PostCompact":
      return "info";
    case "SubagentStop":
      return "info";
    case "Notification": {
      const notifType = (payload?.notification_type as string) ?? "";
      if (notifType === "question" || notifType === "idle_prompt") return "needs_input";
      return "info";
    }
    default:
      return "info";
  }
}

/**
 * Build a human-readable summary for an away event.
 */
export function buildAwaySummary(
  event: string,
  session: BridgeSession,
  payload?: AnyPayload,
): string {
  switch (event) {
    case "SessionEnd": {
      const reason = (payload?.reason as string) ?? "";
      const startedMs = Number(session.startedAt) || new Date(session.startedAt).getTime();
      const durationMs = startedMs > 0 ? Date.now() - startedMs : 0;
      const dur = formatDuration(durationMs);
      return `Session ended (${dur}, $${session.cost.toFixed(2)})${reason ? ` — ${reason}` : ""}`;
    }
    case "PermissionRequest": {
      const toolName = (payload?.tool_name as string) ?? "unknown tool";
      return `Permission request: ${toolName}`;
    }
    case "StopFailure": {
      const failureType = (payload?.failure_type as string) ?? "error";
      const error = (payload?.error as string) ?? "";
      return `${failureType}${error ? `: ${truncate(error, 100)}` : ""}`;
    }
    case "TaskCompleted": {
      const taskName = (payload?.task_name as string) ?? (payload?.task_id as string) ?? "task";
      return `Task completed: ${taskName}`;
    }
    case "PostCompact": {
      const before = payload?.tokens_before as number | undefined;
      const after = payload?.tokens_after as number | undefined;
      if (before != null && after != null) {
        return `Context compacted (${Math.round(before / 1000)}k -> ${Math.round(after / 1000)}k tokens)`;
      }
      return "Context compacted";
    }
    case "Notification": {
      const message = (payload?.message as string) ?? "";
      return truncate(message, 150) || "Notification";
    }
    default:
      return event;
  }
}

/**
 * Track an event for the away summary if the user is away.
 * Call this after the hook handler has done its main work.
 */
export function trackForAwaySummary(
  event: string,
  session: BridgeSession,
  payload: AnyPayload | undefined,
  awayTracker: AwayTracker | undefined,
  guildOwnerId: string | undefined,
): void {
  if (!awayTracker || !guildOwnerId) return;

  const tier = classifyNotification(event, payload);
  // Only track PING and VISIBLE events — SILENT events are routine noise
  if (tier === NotificationTier.SILENT) return;

  if (!awayTracker.isAway(guildOwnerId)) return;

  awayTracker.addEvent(guildOwnerId, {
    type: toAwayEventType(event, payload),
    sessionName: path.basename(session.cwd),
    sessionForumPostId: session.forumPostId,
    summary: buildAwaySummary(event, session, payload),
    timestamp: Date.now(),
  });
}
