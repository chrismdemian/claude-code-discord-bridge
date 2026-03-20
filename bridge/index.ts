import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, saveDiscordConfig } from "./config";
import {
  createClient,
  login,
  setupServer,
  createForumPost,
  archiveForumPost,
  setBotPresence,
} from "./discord-bot";
import { SessionScanner } from "./session-scanner";
import { TranscriptTailer } from "./transcript-tailer";
import { MessageSender } from "./message-sender";
import { McpRelay } from "./mcp-relay";
import { HookReceiver } from "./hook-receiver";
import {
  buildResolvedEmbed,
} from "./interactions/permission-handler";
import {
  handleStopInteraction,
  buildInterruptedMessage,
} from "./interactions/stop-handler";
import { handleFileAttachment } from "./interactions/file-handler";
import { showPromptModal, handleModalSubmit } from "./interactions/modal-handler";
import { registerCommands, handleCommand } from "./interactions/commands";
import { handleReactionAdd } from "./interactions/reactions";
import {
  handlePlanClearExec,
  handlePlanExecute,
  handlePlanApprove,
  handlePlanModify,
  handlePlanModifySubmit,
} from "./interactions/plan-handler";
import {
  extractPlanTitle,
  parsePlanSteps,
  buildPlanEmbed,
  buildPlanProgressEmbed,
  buildPlanCompletedEmbed,
} from "./formatters/plan-formatter";
import {
  Events,
  EmbedBuilder,
  type Client,
  type ThreadChannel,
} from "discord.js";
import type {
  BridgeSession,
  DiscordConfig,
  ContentBlock,
  FormattedMessage,
  ToolUseBlock,
  ToolResultBlock,
} from "./types";
import { Dashboard } from "./dashboard";
import { AwayTracker } from "./away-tracker";
import { LOG_PREFIX, COLORS, PLAN_EDIT_THROTTLE_MS } from "./constants";
import { formatToolCall, formatToolResult } from "./formatter";
import {
  formatAssistantText,
  formatUserPrompt,
  formatSystemEvent,
} from "./formatters/response-formatter";
import { calculateCost } from "./formatters/cost";

const sessions = new Map<string, BridgeSession>();
const tailers = new Map<string, TranscriptTailer>();
const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
const typingGeneration = new Map<string, number>();
const relay = new McpRelay();

async function main() {
  console.log(`${LOG_PREFIX} Bridge service starting...`);

  // 1. Load config
  const config = await loadConfig();
  console.log(`${LOG_PREFIX} Guild: ${config.guildId}`);

  // 2. Create and login Discord client
  const client = createClient();
  await login(client, config.token);

  // 3. Setup server structure (idempotent — finds existing before creating)
  let discordConfig: DiscordConfig;
  if (config.discord) {
    console.log(`${LOG_PREFIX} Using saved Discord config`);
    discordConfig = config.discord;
  } else {
    discordConfig = await setupServer(client, config.guildId);
    await saveDiscordConfig(discordConfig);
  }

  // 4. Set initial presence
  setBotPresence(client, 0);

  // 5. Create message sender with webhook clients
  const messageSender = new MessageSender(discordConfig.webhooks);

  // 5b. Resolve guild owner for access control + notifications
  const guild = await client.guilds.fetch(discordConfig.guildId);
  const guildOwnerId = guild.ownerId;

  // 5c. Create away tracker
  const awayTracker = new AwayTracker(client, guildOwnerId);
  awayTracker.start();

  // 5d. Create dashboard
  const dashboard = new Dashboard(sessions, client, discordConfig.dashboardChannelId);
  await dashboard.initialize();

  // 6. Create hook receiver
  const hookReceiver = new HookReceiver(sessions, messageSender, client, discordConfig, awayTracker, guildOwnerId);

  // 7. Register slash commands
  await registerCommands(config.token, client.user!.id, config.guildId);

  // 8. Start session scanner
  const scanner = new SessionScanner();

  scanner.on("session:discovered", async (sessionInfo) => {
    try {
      const post = await createForumPost(client, discordConfig, {
        sessionId: sessionInfo.sessionId,
        pid: sessionInfo.pid,
        cwd: sessionInfo.cwd,
        startedAt: sessionInfo.startedAt,
      });

      const bridgeSession: BridgeSession = {
        sessionId: sessionInfo.sessionId,
        pid: sessionInfo.pid,
        cwd: sessionInfo.cwd,
        startedAt: sessionInfo.startedAt,
        forumPostId: post.id,
        threadId: post.id,
        model: "unknown",
        status: "active",
        hasChannelPlugin: false,
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        turnCount: 0,
        lastActivity: Date.now(),
        transcriptPath: sessionInfo.transcriptPath,
        transcriptOffset: 0,
        planMode: false,
        planSteps: [],
        planMessageId: null,
        planTitle: "",
        planCurrentStep: -1,
        planLastEditAt: 0,
      };

      // Plugin may have registered before scanner found the session
      if (relay.hasPlugin(sessionInfo.sessionId)) {
        bridgeSession.hasChannelPlugin = true;
      }

      sessions.set(sessionInfo.sessionId, bridgeSession);
      setBotPresence(client, sessions.size);
      dashboard.refresh();

      // Update embed if plugin already connected
      if (bridgeSession.hasChannelPlugin) {
        await updateSessionEmbed(client, discordConfig, bridgeSession);
      }

      // Start tailing the transcript
      const tailer = new TranscriptTailer(
        bridgeSession.transcriptPath,
        bridgeSession.transcriptOffset,
      );
      tailers.set(sessionInfo.sessionId, tailer);
      wireTranscriptEvents(tailer, bridgeSession, messageSender, client);
      tailer.start();
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to handle session discovery ${sessionInfo.sessionId}:`,
        err,
      );
    }
  });

  scanner.on("session:ended", async (sessionInfo) => {
    const bridgeSession = sessions.get(sessionInfo.sessionId);
    if (!bridgeSession) return;

    try {
      // Stop typing indicator
      stopTypingIndicator(sessionInfo.sessionId);

      // Stop the tailer
      const tailer = tailers.get(sessionInfo.sessionId);
      if (tailer) {
        bridgeSession.transcriptOffset = tailer.getOffset();
        tailer.stop();
        tailers.delete(sessionInfo.sessionId);
      }

      // Deny any pending permission request so the hook script unblocks
      if (hookReceiver.hasPendingPermission(sessionInfo.sessionId)) {
        await hookReceiver.clearPendingPermission(sessionInfo.sessionId);
      }
      relay.unregister(sessionInfo.sessionId);
      await archiveForumPost(client, discordConfig, bridgeSession.threadId);
      sessions.delete(sessionInfo.sessionId);
      setBotPresence(client, sessions.size);
      dashboard.refresh();
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to handle session end ${sessionInfo.sessionId}:`,
        err,
      );
    }
  });

  scanner.start();

  // 9. Start MCP relay HTTP server
  const httpServer = Bun.serve({
    port: config.bridgePort,
    async fetch(req) {
      const url = new URL(req.url);

      // Plugin registration
      if (url.pathname === "/register" && req.method === "POST") {
        try {
          const body = await req.json();
          if (!body.sessionId || !body.pid) {
            return Response.json({ error: "Missing sessionId or pid" }, { status: 400 });
          }
          relay.handleRegister(body);
          const session = sessions.get(body.sessionId);
          if (session && !session.hasChannelPlugin) {
            session.hasChannelPlugin = true;
            await updateSessionEmbed(client, discordConfig, session);
          }
          return Response.json({ ok: true });
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
      }

      // Plugin long-poll for messages
      if (url.pathname.startsWith("/poll/") && req.method === "GET") {
        const sessionId = url.pathname.slice(6);
        if (!relay.hasPlugin(sessionId)) {
          return new Response("Not registered", { status: 404 });
        }
        const msg = await relay.handlePoll(sessionId);
        if (msg === null) {
          return new Response(null, { status: 204 });
        }
        return Response.json(msg);
      }

      // Plugin deregistration
      if (url.pathname === "/unregister" && req.method === "POST") {
        try {
          const body = await req.json();
          if (body.sessionId) {
            relay.unregister(body.sessionId);
            const session = sessions.get(body.sessionId);
            if (session && session.hasChannelPlugin) {
              session.hasChannelPlugin = false;
              await updateSessionEmbed(client, discordConfig, session);
            }
          }
          return Response.json({ ok: true });
        } catch {
          return Response.json({ ok: true });
        }
      }

      // Hook routes: POST /hooks/{slug}
      if (url.pathname.startsWith("/hooks/") && req.method === "POST") {
        try {
          const slug = url.pathname.slice("/hooks/".length);
          const body = await req.json();
          const result = await hookReceiver.handleHook(slug, body);
          return Response.json(result ?? { ok: true });
        } catch (err) {
          console.error(`${LOG_PREFIX} Hook error:`, err);
          return Response.json({ ok: true }); // Don't block Claude Code on bridge errors
        }
      }

      // ── MCP tool endpoints ──

      // Send files/images to Discord from the MCP plugin
      if (url.pathname === "/api/send-file" && req.method === "POST") {
        try {
          const body = await req.json();
          const { sessionId, files, caption } = body as {
            sessionId: string;
            files: string[];
            caption?: string;
          };
          if (!sessionId || !Array.isArray(files) || files.length === 0) {
            return new Response("Missing sessionId or files", { status: 400 });
          }
          const session = sessions.get(sessionId);
          if (!session) {
            return new Response("Session not found", { status: 404 });
          }

          const { AttachmentBuilder } = await import("discord.js");
          const attachments = [];
          for (const filePath of files.slice(0, 10)) {
            try {
              const file = Bun.file(filePath);
              if (!(await file.exists())) continue;
              const stat = fs.statSync(filePath);
              if (stat.size > 25 * 1024 * 1024) continue; // 25 MB limit
              const buffer = Buffer.from(await file.arrayBuffer());
              attachments.push(
                new AttachmentBuilder(buffer, { name: path.basename(filePath) }),
              );
            } catch {
              // Skip unreadable files
            }
          }

          if (attachments.length === 0) {
            return new Response("No valid files to send", { status: 400 });
          }

          const webhookClient = messageSender.getClient("claude");
          if (!webhookClient) {
            return new Response("Webhook client not available", { status: 503 });
          }

          const sent = await webhookClient.send({
            content: caption || undefined,
            files: attachments,
            threadId: session.forumPostId,
          });

          return Response.json({ ok: true, messageIds: [sent.id], filesSent: attachments.length });
        } catch (err) {
          console.error(`${LOG_PREFIX} send-file error:`, err);
          return new Response("Internal error", { status: 500 });
        }
      }

      // React to the latest message in a session's forum post
      if (url.pathname === "/api/react" && req.method === "POST") {
        try {
          const body = await req.json();
          const { sessionId, emoji } = body as { sessionId: string; emoji: string };
          if (!sessionId || !emoji) {
            return new Response("Missing sessionId or emoji", { status: 400 });
          }
          const session = sessions.get(sessionId);
          if (!session) {
            return new Response("Session not found", { status: 404 });
          }

          const channel = await client.channels.fetch(session.forumPostId);
          if (channel?.isThread()) {
            const messages = await (channel as ThreadChannel).messages.fetch({ limit: 1 });
            const lastMsg = messages.first();
            if (lastMsg) {
              await lastMsg.react(emoji);
            }
          }

          return Response.json({ ok: true });
        } catch (err) {
          console.error(`${LOG_PREFIX} react error:`, err);
          return new Response("Internal error", { status: 500 });
        }
      }

      // Health check
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          uptime: Math.floor(process.uptime()),
          sessions: sessions.size,
          plugins: relay.getRegisteredSessionIds().length,
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`${LOG_PREFIX} HTTP server listening on port ${config.bridgePort}`);

  // 10. Listen for Discord messages in forum posts → route to Claude Code
  //     (guildOwnerId resolved earlier in step 5b)
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;

    // Track user activity for away detection
    awayTracker.markActive(message.author.id);

    // Access control: only guild owner can send messages/files
    if (message.author.id !== guildOwnerId) return;

    const session = findSessionByForumPostId(message.channel.id);
    if (!session) return;

    // Handle file attachments
    if (message.attachments.size > 0) {
      await handleFileAttachment(message, session).catch((err) => {
        console.error(`${LOG_PREFIX} File handler error:`, err);
      });
    }

    // Relay text content to Claude
    if (message.content.trim()) {
      if (relay.hasPlugin(session.sessionId)) {
        relay.enqueueMessage(session.sessionId, message.content, message.author.id);
        await message.react("✅").catch(() => {});
        startTypingIndicator(client, session);
      } else if (message.attachments.size === 0) {
        // Only show read-only notice if there were no attachments (file handler already responds)
        await message
          .reply("📖 This session is read-only (no channel plugin connected).")
          .catch(() => {});
      }
    }
  });

  // 12. Listen for all Discord interactions (buttons, modals, slash commands)
  client.on(Events.InteractionCreate, async (interaction) => {
    // Track user activity for away detection
    awayTracker.markActive(interaction.user.id);

    try {
      // ── Slash Commands ──
      if (interaction.isChatInputCommand()) {
        await handleCommand(
          interaction,
          sessions,
          findSessionByForumPostId,
          hookReceiver,
          relay,
          client,
          discordConfig,
          guildOwnerId,
        );
        return;
      }

      // ── Modal Submits ──
      if (interaction.isModalSubmit()) {
        const customId = interaction.customId;

        // Access control for all modals
        if (interaction.user.id !== guildOwnerId) {
          await interaction.reply({
            content: "Only the server owner can interact with Claude Code sessions.",
            ephemeral: true,
          }).catch(() => {});
          return;
        }

        if (customId.startsWith("prompt_modal_")) {
          const sessionId = customId.slice("prompt_modal_".length);
          await handleModalSubmit(interaction, sessionId, relay, interaction.user.id);
          return;
        }

        if (customId.startsWith("plan_modify_modal_")) {
          const sessionId = customId.slice("plan_modify_modal_".length);
          const session = sessions.get(sessionId);
          if (session) {
            await handlePlanModifySubmit(interaction, session, relay);
          } else {
            await interaction.reply({ content: "Session not found.", ephemeral: true });
          }
          return;
        }

        return;
      }

      // ── Buttons ──
      if (interaction.isButton()) {
        const customId = interaction.customId;

        // Access control for all buttons
        if (interaction.user.id !== guildOwnerId) {
          await interaction.reply({
            content: "Only the server owner can interact with Claude Code sessions.",
            ephemeral: true,
          }).catch(() => {});
          return;
        }

        // Permission: Approve
        if (customId.startsWith("perm_approve_")) {
          const sessionId = customId.slice("perm_approve_".length);
          const pending = hookReceiver.getPendingPermission(sessionId);
          if (!pending) {
            await interaction.reply({
              content: "This permission request has already been resolved or expired.",
              ephemeral: true,
            });
            return;
          }
          hookReceiver.resolvePermission(sessionId, true);
          const originalEmbed = interaction.message.embeds[0];
          if (originalEmbed) {
            await interaction.update({
              embeds: [buildResolvedEmbed(originalEmbed, true)],
              components: [],
            });
          } else {
            await interaction.update({ components: [] });
          }
          return;
        }

        // Permission: Allow for Session
        if (customId.startsWith("perm_session_")) {
          const sessionId = customId.slice("perm_session_".length);
          const pending = hookReceiver.getPendingPermission(sessionId);
          if (!pending) {
            await interaction.reply({
              content: "This permission request has already been resolved or expired.",
              ephemeral: true,
            });
            return;
          }
          hookReceiver.resolvePermission(sessionId, true, true);
          const originalEmbed = interaction.message.embeds[0];
          if (originalEmbed) {
            await interaction.update({
              embeds: [buildResolvedEmbed(originalEmbed, true, true)],
              components: [],
            });
          } else {
            await interaction.update({ components: [] });
          }
          return;
        }

        // Permission: Deny
        if (customId.startsWith("perm_deny_")) {
          const sessionId = customId.slice("perm_deny_".length);
          const pending = hookReceiver.getPendingPermission(sessionId);
          if (!pending) {
            await interaction.reply({
              content: "This permission request has already been resolved or expired.",
              ephemeral: true,
            });
            return;
          }
          hookReceiver.resolvePermission(sessionId, false);
          const originalEmbed = interaction.message.embeds[0];
          if (originalEmbed) {
            await interaction.update({
              embeds: [buildResolvedEmbed(originalEmbed, false)],
              components: [],
            });
          } else {
            await interaction.update({ components: [] });
          }
          return;
        }

        // Permission: Show Context
        if (customId.startsWith("perm_context_")) {
          const sessionId = customId.slice("perm_context_".length);
          const pending = hookReceiver.getPendingPermission(sessionId);
          const toolInput = pending?.toolInput ?? {};
          const toolName = pending?.toolName ?? "unknown";
          const inputJson = JSON.stringify(toolInput, null, 2);
          const truncated = inputJson.length > 1800
            ? inputJson.slice(0, 1800) + "\n..."
            : inputJson;
          await interaction.reply({
            content: `**Tool:** ${toolName}\n\`\`\`json\n${truncated}\n\`\`\``,
            ephemeral: true,
          });
          return;
        }

        // Stop button
        if (customId.startsWith("stop_")) {
          const sessionId = customId.slice("stop_".length);
          const session = sessions.get(sessionId);
          if (!session) {
            await interaction.reply({ content: "Session not found.", ephemeral: true });
            return;
          }
          await handleStopInteraction(session, relay);
          await interaction.update(buildInterruptedMessage());
          return;
        }

        // New Prompt button → show modal
        if (customId.startsWith("prompt_new_")) {
          const sessionId = customId.slice("prompt_new_".length);
          await showPromptModal(interaction, sessionId);
          return;
        }

        // "Ask Claude About This File" button
        if (customId.startsWith("file_ask_")) {
          const rest = customId.slice("file_ask_".length);
          const separatorIdx = rest.indexOf("_");
          if (separatorIdx === -1) {
            await interaction.reply({ content: "Invalid file reference.", ephemeral: true });
            return;
          }
          const sessionId = rest.slice(0, separatorIdx);
          const filename = rest.slice(separatorIdx + 1);
          const session = sessions.get(sessionId);
          if (!session) {
            await interaction.reply({ content: "Session not found.", ephemeral: true });
            return;
          }
          const filePath = path.join(session.cwd, filename);
          const prompt = `I just dropped a file at ${filePath}. Please examine it and let me know what you see.`;
          const sent = relay.enqueueMessage(session.sessionId, prompt, interaction.user.id);
          if (sent) {
            await interaction.reply({
              content: `Asking Claude about \`${filename}\`...`,
              ephemeral: true,
            });
          } else {
            await interaction.reply({
              content: "❌ Session is read-only (no channel plugin connected).",
              ephemeral: true,
            });
          }
          return;
        }

        // Plan mode buttons (check plan_clearexec_ before plan_clear_ to avoid prefix collision)
        if (customId.startsWith("plan_clearexec_")) {
          const sessionId = customId.slice("plan_clearexec_".length);
          const session = sessions.get(sessionId);
          if (!session) {
            await interaction.reply({ content: "Session not found.", ephemeral: true });
            return;
          }
          await handlePlanClearExec(interaction, session, relay);
          return;
        }

        if (customId.startsWith("plan_execute_")) {
          const sessionId = customId.slice("plan_execute_".length);
          const session = sessions.get(sessionId);
          if (!session) {
            await interaction.reply({ content: "Session not found.", ephemeral: true });
            return;
          }
          await handlePlanExecute(interaction, session, relay);
          return;
        }

        if (customId.startsWith("plan_approve_")) {
          const sessionId = customId.slice("plan_approve_".length);
          const session = sessions.get(sessionId);
          if (!session) {
            await interaction.reply({ content: "Session not found.", ephemeral: true });
            return;
          }
          await handlePlanApprove(interaction, session, relay);
          return;
        }

        if (customId.startsWith("plan_modify_")) {
          const sessionId = customId.slice("plan_modify_".length);
          const session = sessions.get(sessionId);
          if (!session) {
            await interaction.reply({ content: "Session not found.", ephemeral: true });
            return;
          }
          await handlePlanModify(interaction, session);
          return;
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Interaction error:`, err);
    }
  });

  // 13. Listen for reactions (quick actions)
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    await handleReactionAdd(
      reaction,
      user,
      findSessionByForumPostId,
      hookReceiver,
      guildOwnerId,
      relay,
    ).catch((err) => {
      console.error(`${LOG_PREFIX} Reaction error:`, err);
    });
  });

  console.log(`${LOG_PREFIX} Bridge service ready`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log(`${LOG_PREFIX} Shutting down...`);
    httpServer.stop();
    dashboard.destroy();
    awayTracker.destroy();
    for (const interval of typingIntervals.values()) {
      clearInterval(interval);
    }
    typingIntervals.clear();
    for (const tailer of tailers.values()) {
      tailer.stop();
    }
    tailers.clear();
    messageSender.destroy();
    await scanner.stop();
    client.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} Fatal error:`, err);
  process.exit(1);
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Find a session by its Discord forum post ID */
function findSessionByForumPostId(id: string): BridgeSession | undefined {
  for (const s of sessions.values()) {
    if (s.forumPostId === id) return s;
  }
  return undefined;
}

/** Update the forum post starter embed when hasChannelPlugin changes */
async function updateSessionEmbed(
  client: Client,
  config: DiscordConfig,
  session: BridgeSession,
): Promise<void> {
  try {
    const thread = await client.channels.fetch(session.forumPostId);
    if (!thread?.isThread()) return;

    const starterMessage = await (thread as ThreadChannel).fetchStarterMessage();
    if (!starterMessage) return;

    const projectName = path.basename(session.cwd);
    const icon = session.hasChannelPlugin ? "📡 Connected" : "📖 Read-Only";
    const startedMs = Number(session.startedAt) || new Date(session.startedAt).getTime();
    const startedAtSec = Math.floor(startedMs / 1000);

    const embed = new EmbedBuilder()
      .setTitle(`${icon} — ${projectName}`)
      .setColor(COLORS.BLUE)
      .addFields(
        { name: "Directory", value: `\`${session.cwd}\``, inline: false },
        { name: "PID", value: String(session.pid), inline: true },
        { name: "Session", value: session.sessionId.slice(0, 18), inline: true },
        { name: "Started", value: `<t:${startedAtSec}:R>`, inline: true },
        { name: "Cost", value: `$${session.cost.toFixed(2)}`, inline: true },
        { name: "Context", value: "0% used", inline: true },
      )
      .setTimestamp();

    await starterMessage.edit({ embeds: [embed] });
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to update session embed:`, err);
  }
}

// ── Typing indicator ──────────────────────────────────────────────────

/** Start sending typing indicators on a 9-second interval */
async function startTypingIndicator(
  client: Client,
  session: BridgeSession,
): Promise<void> {
  stopTypingIndicator(session.sessionId);
  // Track generation to prevent stale intervals from being created
  // if stopTypingIndicator is called while we're awaiting channels.fetch
  const gen = (typingGeneration.get(session.sessionId) ?? 0) + 1;
  typingGeneration.set(session.sessionId, gen);
  try {
    const channel = await client.channels.fetch(session.forumPostId);
    if (typingGeneration.get(session.sessionId) !== gen) return;
    if (!channel?.isThread()) return;
    const thread = channel as ThreadChannel;
    await thread.sendTyping().catch(() => {});
    if (typingGeneration.get(session.sessionId) !== gen) return;
    const interval = setInterval(async () => {
      await thread.sendTyping().catch(() => {});
    }, 9000);
    typingIntervals.set(session.sessionId, interval);
  } catch {
    // Best-effort
  }
}

/** Stop the typing indicator interval for a session */
function stopTypingIndicator(sessionId: string): void {
  // Bump generation so any in-flight startTypingIndicator will bail out
  typingGeneration.set(sessionId, (typingGeneration.get(sessionId) ?? 0) + 1);
  const interval = typingIntervals.get(sessionId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(sessionId);
  }
}

// ── Transcript → Discord routing ──────────────────────────────────────

/** Send a FormattedMessage through the appropriate MessageSender method */
async function sendFormatted(
  sender: MessageSender,
  threadId: string,
  msg: FormattedMessage,
): Promise<void> {
  const hasContent = !!msg.content;
  const hasEmbeds = !!msg.embeds?.length;
  const hasFiles = !!msg.files?.length;

  // Combine content + embeds + files into a single webhook call when possible
  if (hasContent || hasEmbeds) {
    const options: Record<string, unknown> = {};
    if (hasEmbeds) options.embeds = msg.embeds;
    if (hasFiles) options.files = msg.files;

    if (hasContent) {
      await sender.sendAsWebhook(msg.webhook, threadId, msg.content!, options);
    } else {
      // Embeds only (no content text)
      for (const embed of msg.embeds!) {
        await sender.sendEmbed(msg.webhook, threadId, embed);
      }
    }
  } else if (hasFiles) {
    // Files only, no content or embeds
    for (const file of msg.files!) {
      await sender.sendFile(msg.webhook, threadId, file);
    }
  }
}

/** MCP tools defined in server.ts — skip their transcript entries to avoid duplicates */
const BRIDGE_MCP_TOOLS = new Set(["send_to_discord", "react_in_discord"]);

function wireTranscriptEvents(
  tailer: TranscriptTailer,
  session: BridgeSession,
  sender: MessageSender,
  client: Client,
): void {
  const threadId = session.forumPostId;
  // Store full tool_use blocks for result correlation
  const toolUseBlocks = new Map<string, ToolUseBlock>();

  tailer.on("entry:assistant", async (entry) => {
    try {
      // Stop typing indicator when assistant responds
      stopTypingIndicator(session.sessionId);

      // Track plan mode from permissionMode field on transcript entries
      const pm = (entry as Record<string, unknown>).permissionMode;
      if (pm === "plan" && !session.planMode) {
        session.planMode = true;
      } else if (pm && pm !== "plan" && session.planMode) {
        session.planMode = false;
      }

      const msg = entry.message;
      if (!msg?.content) return;

      // Update model
      if (msg.model) {
        session.model = msg.model;
      }

      // Accumulate token usage & cost
      if (msg.usage) {
        session.inputTokens += msg.usage.input_tokens ?? 0;
        session.outputTokens += msg.usage.output_tokens ?? 0;
        if (msg.model) {
          session.cost += calculateCost(msg.usage, msg.model);
        }
      }

      // String content (rare for assistant)
      if (typeof msg.content === "string") {
        if (msg.content.trim()) {
          const formatted = formatAssistantText(msg.content, session, {
            model: msg.model,
            usage: msg.usage,
          });
          await sendFormatted(sender, threadId, formatted);
        }
        session.lastActivity = Date.now();
        return;
      }

      // Separate text and tool_use blocks
      const textBlocks: string[] = [];
      const toolBlocks: ToolUseBlock[] = [];

      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "text" && "text" in block && block.text.trim()) {
          textBlocks.push(block.text);
        } else if (block.type === "tool_use" && "id" in block && "name" in block) {
          toolBlocks.push(block as ToolUseBlock);
        }
        // thinking blocks: not forwarded (security — model signatures)
      }

      // Send text blocks; last one gets metadata footer if no tool calls follow
      for (let i = 0; i < textBlocks.length; i++) {
        const isLast = i === textBlocks.length - 1 && toolBlocks.length === 0;
        const formatted = formatAssistantText(
          textBlocks[i],
          session,
          isLast ? { model: msg.model, usage: msg.usage } : undefined,
        );
        await sendFormatted(sender, threadId, formatted);
      }

      // Plan mode detection: two paths
      // 1. ExitPlanMode tool_use — agent-initiated plan, plan text in input.plan
      // 2. planMode flag + text-only response — user-initiated plan via /plan
      let planText: string | null = null;

      // Path 1: ExitPlanMode tool call contains the plan
      for (const block of toolBlocks) {
        if (block.name === "ExitPlanMode" && block.input?.plan) {
          planText = String(block.input.plan);
          session.planMode = true; // Mark as in plan mode for button display
          break;
        }
      }

      // Path 2: User-initiated plan mode — text-only response while planMode is set
      if (!planText && session.planMode && textBlocks.length > 0 && toolBlocks.length === 0) {
        planText = textBlocks.join("\n\n");
      }

      // Show plan embed if we found plan content
      if (planText) {
        const steps = parsePlanSteps(planText);
        if (steps.length > 0) {
          const title = extractPlanTitle(planText);
          session.planSteps = steps;
          session.planTitle = title;

          // Remove buttons from old plan embed if there was one
          if (session.planMessageId) {
            try {
              const ch = await client.channels.fetch(threadId);
              if (ch?.isThread()) {
                const oldMsg = await (ch as ThreadChannel).messages.fetch(session.planMessageId).catch(() => null);
                if (oldMsg) {
                  await oldMsg.edit({ components: [] }).catch(() => {});
                }
              }
            } catch { /* best-effort */ }
          }

          // Send plan embed via bot client (not webhook) for button interaction support
          try {
            const { embeds, components } = buildPlanEmbed(planText, steps, title, session);
            const channel = await client.channels.fetch(threadId);
            if (channel?.isThread()) {
              const sentMsg = await (channel as ThreadChannel).send({
                embeds,
                components,
                allowedMentions: { parse: [] },
              });
              session.planMessageId = sentMsg.id;
            }
          } catch (err) {
            console.error(`${LOG_PREFIX} Failed to send plan embed:`, err);
          }
        }
      }

      // Send tool call headers + track for result correlation
      for (const block of toolBlocks) {
        toolUseBlocks.set(block.id, block);
        // Skip bridge MCP tools — they already sent to Discord directly
        if (BRIDGE_MCP_TOOLS.has(block.name)) continue;
        const formatted = formatToolCall(block);
        await sendFormatted(sender, threadId, formatted);
      }

      session.lastActivity = Date.now();
    } catch (err) {
      console.error(`${LOG_PREFIX} Error processing assistant entry:`, err);
    }
  });

  tailer.on("entry:user", async (entry) => {
    try {
      // Track plan mode from permissionMode field on transcript entries
      const pm = (entry as Record<string, unknown>).permissionMode;
      if (pm === "plan" && !session.planMode) {
        session.planMode = true;
      } else if (pm && pm !== "plan" && session.planMode) {
        session.planMode = false;
      }

      const msg = entry.message;
      if (!msg) return;

      // Skip meta/internal entries
      if (entry.isMeta) return;

      // String content = user prompt
      if (typeof msg.content === "string") {
        const text = msg.content;
        // Skip internal command tags
        if (
          text.startsWith("<command-name>") ||
          text.startsWith("<local-command")
        ) {
          return;
        }
        if (!text.trim()) return;

        const formatted = formatUserPrompt(text);
        await sendFormatted(sender, threadId, formatted);
        session.turnCount++;
        session.lastActivity = Date.now();

        // Start typing indicator while Claude is working
        startTypingIndicator(client, session);

        return;
      }

      // Array content = tool results
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            (block as { type: string }).type === "tool_result"
          ) {
            const resultBlock = block as ToolResultBlock;
            const toolUse = resultBlock.tool_use_id
              ? toolUseBlocks.get(resultBlock.tool_use_id)
              : undefined;
            const toolName = toolUse?.name ?? "unknown";

            // Skip bridge MCP tools — they already sent to Discord directly
            if (BRIDGE_MCP_TOOLS.has(toolName)) {
              if (resultBlock.tool_use_id) toolUseBlocks.delete(resultBlock.tool_use_id);
              continue;
            }

            const formatted = formatToolResult(toolName, toolUse, resultBlock, session);
            if (formatted) {
              const messages = Array.isArray(formatted) ? formatted : [formatted];
              for (const fmtMsg of messages) {
                await sendFormatted(sender, threadId, fmtMsg);
              }
            }

            // Clean up after result is processed to prevent memory leak
            if (resultBlock.tool_use_id) {
              toolUseBlocks.delete(resultBlock.tool_use_id);
            }
          }
        }
      }

      session.lastActivity = Date.now();
    } catch (err) {
      console.error(`${LOG_PREFIX} Error processing user entry:`, err);
    }
  });

  tailer.on("entry:system", async (entry) => {
    try {
      // Advance plan execution progress on turn boundaries
      if (entry.subtype === "turn_duration" && session.planCurrentStep >= 0 && session.planSteps.length > 0) {
        await advancePlanStep(session, client);
      }

      const formatted = formatSystemEvent(entry, session);
      if (formatted) {
        await sendFormatted(sender, threadId, formatted);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Error processing system entry:`, err);
    }
  });

  tailer.on("entry:custom-title", async (entry) => {
    try {
      const customTitle = entry.customTitle;
      if (!customTitle) return;
      const projectName = path.basename(session.cwd);
      const newName = `${projectName} — ${customTitle}`.slice(0, 100);
      const thread = await client.channels.fetch(threadId);
      if (thread?.isThread()) {
        await (thread as ThreadChannel).setName(newName);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to rename forum post:`, err);
    }
  });

  tailer.on("error", (err) => {
    console.error(
      `${LOG_PREFIX} Tailer error for session ${session.sessionId}:`,
      err,
    );
  });
}

/** Advance plan execution progress and edit the progress embed in-place */
async function advancePlanStep(
  session: BridgeSession,
  client: Client,
): Promise<void> {
  if (session.planCurrentStep < 0 || session.planSteps.length === 0 || !session.planMessageId) return;

  // Always mutate state — mark current step done and advance
  if (session.planCurrentStep < session.planSteps.length) {
    session.planSteps[session.planCurrentStep].status = "done";
  }

  const nextStep = session.planCurrentStep + 1;
  if (nextStep < session.planSteps.length) {
    session.planSteps[nextStep].status = "working";
    session.planCurrentStep = nextStep;
  } else {
    // All steps done
    session.planCurrentStep = -1;
  }

  // Throttle Discord edits only (state mutation already happened)
  const now = Date.now();
  if (now - session.planLastEditAt < PLAN_EDIT_THROTTLE_MS) return;
  session.planLastEditAt = now;

  // Edit the progress embed in-place
  try {
    const channel = await client.channels.fetch(session.forumPostId);
    if (!channel?.isThread()) return;
    const msg = await (channel as ThreadChannel).messages.fetch(session.planMessageId).catch(() => null);
    if (!msg) return;

    const embed = session.planCurrentStep === -1
      ? buildPlanCompletedEmbed(session.planTitle, session.planSteps)
      : buildPlanProgressEmbed(session.planTitle, session.planSteps);

    await msg.edit({ embeds: [embed] });
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to update plan progress:`, err);
  }
}
