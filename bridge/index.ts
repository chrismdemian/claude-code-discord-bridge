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
  Events,
  EmbedBuilder,
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
import { LOG_PREFIX, BRIDGE_PORT, COLORS } from "./constants";
import { formatToolCall, formatToolResult } from "./formatter";
import {
  formatAssistantText,
  formatUserPrompt,
  formatSystemEvent,
} from "./formatters/response-formatter";
import { calculateCost } from "./formatters/cost";

const sessions = new Map<string, BridgeSession>();
const tailers = new Map<string, TranscriptTailer>();
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

  // 6. Create hook receiver
  const hookReceiver = new HookReceiver(sessions, messageSender, client, discordConfig);

  // 7. Start session scanner
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
      };

      // Plugin may have registered before scanner found the session
      if (relay.hasPlugin(sessionInfo.sessionId)) {
        bridgeSession.hasChannelPlugin = true;
      }

      sessions.set(sessionInfo.sessionId, bridgeSession);
      setBotPresence(client, sessions.size);

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
      wireTranscriptEvents(tailer, bridgeSession, messageSender);
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
    } catch (err) {
      console.error(
        `${LOG_PREFIX} Failed to handle session end ${sessionInfo.sessionId}:`,
        err,
      );
    }
  });

  scanner.start();

  // 8. Start MCP relay HTTP server
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

  // 9. Listen for Discord messages in forum posts → route to Claude Code
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.channel.isThread()) return;

    const session = findSessionByForumPostId(message.channel.id);
    if (!session) return;

    if (relay.hasPlugin(session.sessionId)) {
      relay.enqueueMessage(session.sessionId, message.content, message.author.id);
      await message.react("✅").catch(() => {});
    } else {
      await message
        .reply("📖 This session is read-only (no channel plugin connected).")
        .catch(() => {});
    }
  });

  // 10. Listen for Discord button interactions (permission approve/deny)
  const guild = await client.guilds.fetch(discordConfig.guildId);
  const guildOwnerId = guild.ownerId;

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;

    // Only permission buttons for now (all start with "perm_")
    if (!customId.startsWith("perm_")) return;

    // Access control: only the guild owner can approve/deny permissions
    if (interaction.user.id !== guildOwnerId) {
      await interaction.reply({
        content: "Only the server owner can approve or deny permission requests.",
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    try {
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
    } catch (err) {
      console.error(`${LOG_PREFIX} Interaction error:`, err);
    }
  });

  console.log(`${LOG_PREFIX} Bridge service ready`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log(`${LOG_PREFIX} Shutting down...`);
    httpServer.stop();
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

// ── MCP relay helpers ─────────────────────────────────────────────────

/** Find a session by its Discord forum post ID */
function findSessionByForumPostId(id: string): BridgeSession | undefined {
  for (const s of sessions.values()) {
    if (s.forumPostId === id) return s;
  }
  return undefined;
}

/** Update the forum post starter embed when hasChannelPlugin changes */
async function updateSessionEmbed(
  client: import("discord.js").Client,
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

function wireTranscriptEvents(
  tailer: TranscriptTailer,
  session: BridgeSession,
  sender: MessageSender,
): void {
  const threadId = session.forumPostId;
  // Store full tool_use blocks for result correlation
  const toolUseBlocks = new Map<string, ToolUseBlock>();

  tailer.on("entry:assistant", async (entry) => {
    try {
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

      // Send tool call headers + track for result correlation
      for (const block of toolBlocks) {
        toolUseBlocks.set(block.id, block);
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
      const formatted = formatSystemEvent(entry, session);
      if (formatted) {
        await sendFormatted(sender, threadId, formatted);
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Error processing system entry:`, err);
    }
  });

  tailer.on("error", (err) => {
    console.error(
      `${LOG_PREFIX} Tailer error for session ${session.sessionId}:`,
      err,
    );
  });
}
