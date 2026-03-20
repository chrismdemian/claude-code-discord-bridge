import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { BridgeSession } from "../types";
import type { McpRelay } from "../mcp-relay";
import { LOG_PREFIX } from "../constants";

/** Build a stop button for a session */
export function buildStopButton(
  sessionId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop_${sessionId}`)
      .setLabel("Stop")
      .setEmoji("🛑")
      .setStyle(ButtonStyle.Danger),
  );
}

/** Build a "working" indicator message with a stop button */
export function buildWorkingMessage(sessionId: string): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  return {
    content: "⏳ Claude is working...",
    components: [buildStopButton(sessionId)],
  };
}

/** Build a cleared working message (natural completion — just remove button) */
export function buildCompletedWorkingMessage(): {
  content: string;
  components: never[];
} {
  return { content: "-# ✅ Turn completed", components: [] };
}

/** Build an interrupted message (user clicked stop) */
export function buildInterruptedMessage(): {
  content: string;
  components: never[];
} {
  return { content: "⚠️ Interrupted by user", components: [] };
}

/** Send an interrupt signal to the Claude Code process */
export async function handleStopInteraction(
  session: BridgeSession,
  relay?: McpRelay,
): Promise<void> {
  try {
    if (process.platform === "win32") {
      Bun.spawn(["taskkill", "/PID", String(session.pid)]);
    } else {
      process.kill(session.pid, "SIGINT");
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to send interrupt to PID ${session.pid}:`, err);
  }

  // Also send /stop via channel plugin as backup
  if (session.hasChannelPlugin && relay) {
    try {
      relay.enqueueMessage(session.sessionId, "/stop", "bridge");
    } catch {
      // Best-effort
    }
  }
}
