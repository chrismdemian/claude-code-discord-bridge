import {
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { BridgeSession, DiscordConfig } from "../types";
import type { HookReceiver } from "../hook-receiver";
import type { McpRelay } from "../mcp-relay";
import { archiveForumPost } from "../discord-bot";
import { handleStopInteraction } from "./stop-handler";
import { COLORS, LOG_PREFIX } from "../constants";
import { formatModelName } from "../formatters/cost";
import { formatDuration } from "../formatters/utils";

// ── Command Definitions ──────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("sessions")
    .setDescription("List all active Claude Code sessions"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Quick status of current session"),
  new SlashCommandBuilder()
    .setName("cost")
    .setDescription("Show token usage and cost for session"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Interrupt current session"),
  new SlashCommandBuilder()
    .setName("screenshot")
    .setDescription("Request a Playwright screenshot capture"),
  new SlashCommandBuilder()
    .setName("compact")
    .setDescription("Toggle compact/verbose mode"),
  new SlashCommandBuilder()
    .setName("archive")
    .setDescription("Archive current session post"),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume an archived session")
    .addStringOption((opt) =>
      opt
        .setName("session")
        .setDescription("Session ID to resume")
        .setRequired(true),
    ),
];

// ── Registration ─────────────────────────────────────────────────────

/** Register guild-scoped slash commands (instant deployment) */
export async function registerCommands(
  token: string,
  clientId: string,
  guildId: string,
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands.map((c) => c.toJSON()),
  });
  console.log(`${LOG_PREFIX} Registered ${commands.length} slash commands`);
}

// ── Command Handler ──────────────────────────────────────────────────

/** Dispatch a slash command interaction */
export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  sessions: Map<string, BridgeSession>,
  findSessionByForumPostId: (id: string) => BridgeSession | undefined,
  hookReceiver: HookReceiver,
  relay: McpRelay,
  client: Client,
  discordConfig: DiscordConfig,
  guildOwnerId: string,
): Promise<void> {
  // Access control
  if (interaction.user.id !== guildOwnerId) {
    await interaction.reply({
      content: "Only the server owner can use Claude Code commands.",
      ephemeral: true,
    }).catch(() => {});
    return;
  }

  const name = interaction.commandName;

  try {
    switch (name) {
      case "sessions":
        await handleSessions(interaction, sessions);
        break;
      case "status":
        await handleStatus(interaction, findSessionByForumPostId);
        break;
      case "cost":
        await handleCost(interaction, findSessionByForumPostId);
        break;
      case "stop":
        await handleStop(interaction, findSessionByForumPostId, relay);
        break;
      case "screenshot":
        await handlePassthrough(interaction, findSessionByForumPostId, relay, "/screenshot");
        break;
      case "compact":
        await handlePassthrough(interaction, findSessionByForumPostId, relay, "/compact");
        break;
      case "archive":
        await handleArchive(interaction, findSessionByForumPostId, client, discordConfig);
        break;
      case "resume":
        await handleResume(interaction);
        break;
      default:
        await interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Command error (/${name}):`, err);
    const reply = { content: "An error occurred.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
}

// ── Individual Command Handlers ──────────────────────────────────────

/** /sessions — list all active sessions */
async function handleSessions(
  interaction: ChatInputCommandInteraction,
  sessions: Map<string, BridgeSession>,
): Promise<void> {
  const entries = Array.from(sessions.values());

  if (entries.length === 0) {
    await interaction.reply({ content: "No active sessions.", ephemeral: true });
    return;
  }

  const lines = entries.map((s) => {
    const icon = s.hasChannelPlugin ? "📡" : "📖";
    const status = s.status === "working" ? "working" : "idle";
    const startMs = Number(s.startedAt) || new Date(s.startedAt).getTime();
    const duration = formatDuration(Date.now() - startMs);
    const model = formatModelName(s.model);
    return `${icon} **${getSessionName(s)}**\n   ${model} · ${status} · ${duration} · $${s.cost.toFixed(2)}`;
  });

  const totalCost = entries.reduce((sum, s) => sum + s.cost, 0);

  const embed = new EmbedBuilder()
    .setColor(COLORS.BLUE)
    .setTitle("📋 Active Sessions")
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: `Active: ${entries.length}  |  Today: $${totalCost.toFixed(2)}` });

  await interaction.reply({ embeds: [embed] });
}

/** /status — show session status (must be in forum thread) */
async function handleStatus(
  interaction: ChatInputCommandInteraction,
  findSession: (id: string) => BridgeSession | undefined,
): Promise<void> {
  const session = findSession(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: "Run this command inside a session thread.",
      ephemeral: true,
    });
    return;
  }

  const duration = formatDuration(Date.now() - new Date(session.startedAt).getTime());
  const model = formatModelName(session.model);
  const icon = session.hasChannelPlugin ? "📡 Connected" : "📖 Read-Only";

  const embed = new EmbedBuilder()
    .setColor(COLORS.BLUE)
    .setTitle(`${icon} — ${getSessionName(session)}`)
    .addFields(
      { name: "Status", value: session.status, inline: true },
      { name: "Model", value: model, inline: true },
      { name: "Duration", value: duration, inline: true },
      { name: "Turns", value: String(session.turnCount), inline: true },
      { name: "Cost", value: `$${session.cost.toFixed(2)}`, inline: true },
      { name: "PID", value: String(session.pid), inline: true },
    );

  await interaction.reply({ embeds: [embed] });
}

/** /cost — show token usage and cost (must be in forum thread) */
async function handleCost(
  interaction: ChatInputCommandInteraction,
  findSession: (id: string) => BridgeSession | undefined,
): Promise<void> {
  const session = findSession(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: "Run this command inside a session thread.",
      ephemeral: true,
    });
    return;
  }

  const model = formatModelName(session.model);
  const avgCost = session.turnCount > 0
    ? (session.cost / session.turnCount).toFixed(2)
    : "0.00";
  const duration = formatDuration(Date.now() - new Date(session.startedAt).getTime());

  const embed = new EmbedBuilder()
    .setColor(COLORS.BLUE)
    .setTitle(`💰 Cost — ${getSessionName(session)}`)
    .addFields(
      { name: "Input tokens", value: session.inputTokens.toLocaleString(), inline: true },
      { name: "Output tokens", value: session.outputTokens.toLocaleString(), inline: true },
      { name: "Total cost", value: `$${session.cost.toFixed(2)}`, inline: true },
      { name: "Model", value: model, inline: true },
      { name: "Turns", value: String(session.turnCount), inline: true },
      { name: "Avg cost/turn", value: `$${avgCost}`, inline: true },
      { name: "Duration", value: duration, inline: true },
    );

  await interaction.reply({ embeds: [embed] });
}

/** /stop — interrupt current session (must be in forum thread) */
async function handleStop(
  interaction: ChatInputCommandInteraction,
  findSession: (id: string) => BridgeSession | undefined,
  relay: McpRelay,
): Promise<void> {
  const session = findSession(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: "Run this command inside a session thread.",
      ephemeral: true,
    });
    return;
  }

  await handleStopInteraction(session, relay);
  await interaction.reply({ content: "🛑 Stopping session...", ephemeral: true });
}

/** Forward a Claude Code command via the channel plugin */
async function handlePassthrough(
  interaction: ChatInputCommandInteraction,
  findSession: (id: string) => BridgeSession | undefined,
  relay: McpRelay,
  command: string,
): Promise<void> {
  const session = findSession(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: "Run this command inside a session thread.",
      ephemeral: true,
    });
    return;
  }

  if (!session.hasChannelPlugin) {
    await interaction.reply({
      content: "❌ Session is read-only (no channel plugin connected).",
      ephemeral: true,
    });
    return;
  }

  relay.enqueueMessage(session.sessionId, command, interaction.user.id);
  await interaction.reply({
    content: `✅ Sent \`${command}\` to Claude.`,
    ephemeral: true,
  });
}

/** /archive — archive the current session post */
async function handleArchive(
  interaction: ChatInputCommandInteraction,
  findSession: (id: string) => BridgeSession | undefined,
  client: Client,
  discordConfig: DiscordConfig,
): Promise<void> {
  const session = findSession(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: "Run this command inside a session thread.",
      ephemeral: true,
    });
    return;
  }

  await archiveForumPost(client, discordConfig, session.threadId);
  await interaction.reply({ content: "✅ Session archived.", ephemeral: true });
}

/** Validate a session ID looks like a UUID (prevent flag injection) */
const SESSION_ID_PATTERN = /^[a-f0-9-]+$/i;

/** /resume — resume an archived session by spawning claude -r */
async function handleResume(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sessionId = interaction.options.getString("session", true);

  if (!SESSION_ID_PATTERN.test(sessionId)) {
    await interaction.reply({
      content: "❌ Invalid session ID format.",
      ephemeral: true,
    });
    return;
  }

  try {
    Bun.spawn(["claude", "-r", sessionId], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    await interaction.reply({
      content: `🔄 Resuming session \`${sessionId.slice(0, 18)}...\``,
      ephemeral: true,
    });
  } catch {
    await interaction.reply({
      content: "❌ Failed to resume session. Is `claude` in your PATH?",
      ephemeral: true,
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Get a display name for a session (project directory basename) */
function getSessionName(session: BridgeSession): string {
  const parts = session.cwd.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || session.sessionId.slice(0, 8);
}
