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
  Events,
  EmbedBuilder,
  type ThreadChannel,
} from "discord.js";
import type { BridgeSession, DiscordConfig, ContentBlock } from "./types";
import { LOG_PREFIX, BRIDGE_PORT, COLORS } from "./constants";

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
      hookReceiver.resolvePermission(sessionInfo.sessionId, false);
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
    const startedAtSec = Math.floor(parseInt(session.startedAt, 10) / 1000);

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

const TOOL_WEBHOOK_MAP: Record<string, keyof DiscordConfig["webhooks"]> = {
  Bash: "terminal",
  Read: "editor",
  Edit: "editor",
  Write: "editor",
  MultiEdit: "editor",
  Glob: "editor",
  Grep: "editor",
  NotebookEdit: "editor",
  WebSearch: "claude",
  WebFetch: "claude",
  Agent: "claude",
  TodoRead: "claude",
  TodoWrite: "claude",
};

function getToolWebhook(toolName: string): keyof DiscordConfig["webhooks"] {
  if (TOOL_WEBHOOK_MAP[toolName]) return TOOL_WEBHOOK_MAP[toolName];
  if (toolName.startsWith("mcp__plugin_playwright")) return "playwright";
  if (toolName.startsWith("mcp__")) return "system";
  return "claude";
}

function formatToolCall(block: { name: string; input: Record<string, unknown> }): string {
  switch (block.name) {
    case "Bash":
      return `🖥️ \`$ ${block.input.command ?? "..."}\``;
    case "Read":
      return `📖 \`Read: ${block.input.file_path ?? "?"}\``;
    case "Edit":
    case "MultiEdit":
      return `✏️ \`Edit: ${block.input.file_path ?? "?"}\``;
    case "Write":
      return `📝 \`Write: ${block.input.file_path ?? "?"}\``;
    case "Glob":
      return `🔍 \`Glob: ${block.input.pattern ?? "?"}\``;
    case "Grep":
      return `🔍 \`Grep: "${block.input.pattern ?? "?"}"\``;
    case "Agent":
      return `🤖 \`Agent: ${String(block.input.prompt ?? "").slice(0, 80)}\``;
    case "WebSearch":
      return `🔎 \`Search: "${block.input.query ?? "?"}"\``;
    case "WebFetch":
      return `🌐 \`Fetch: ${block.input.url ?? "?"}\``;
    default: {
      const inputStr = JSON.stringify(block.input).slice(0, 100);
      return `🔧 \`${block.name}(${inputStr})\``;
    }
  }
}

function extractToolResultText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null && "type" in item) {
      const block = item as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

function formatToolResult(block: {
  content: string | unknown[];
  is_error?: boolean;
}): string | null {
  const text = extractToolResultText(block.content);
  if (!text.trim()) return null;

  const prefix = block.is_error ? "Error: " : "";
  const truncated =
    text.length > 1800 ? text.slice(0, 1800) + "\n... (truncated)" : text;

  return `${prefix}\`\`\`\n${truncated}\n\`\`\``;
}

function wireTranscriptEvents(
  tailer: TranscriptTailer,
  session: BridgeSession,
  sender: MessageSender,
): void {
  const threadId = session.forumPostId;
  // Map tool_use_id → tool name so we can route tool_result to the right webhook
  const toolUseIdToName = new Map<string, string>();

  tailer.on("entry:assistant", async (entry) => {
    try {
      const msg = entry.message;
      if (!msg?.content) return;

      // String content (rare for assistant)
      if (typeof msg.content === "string") {
        if (msg.content.trim()) {
          await sender.sendAsWebhook("claude", threadId, msg.content);
        }
        session.lastActivity = Date.now();
        return;
      }

      // Array of content blocks
      for (const block of msg.content as ContentBlock[]) {
        if (block.type === "text" && "text" in block) {
          if (block.text.trim()) {
            await sender.sendAsWebhook("claude", threadId, block.text);
          }
        } else if (block.type === "tool_use" && "name" in block) {
          // Track tool_use_id → name for routing tool results
          if ("id" in block) {
            toolUseIdToName.set(
              (block as { id: string }).id,
              block.name,
            );
          }
          const webhookName = getToolWebhook(block.name);
          const summary = formatToolCall(block as { name: string; input: Record<string, unknown> });
          await sender.sendAsWebhook(webhookName, threadId, summary);
        }
        // thinking blocks: skip in Phase 3
      }

      // Update model from first assistant entry
      if (msg.model && session.model === "unknown") {
        session.model = msg.model;
      }

      // Accumulate token usage
      if (msg.usage) {
        session.inputTokens += msg.usage.input_tokens ?? 0;
        session.outputTokens += msg.usage.output_tokens ?? 0;
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
        // Skip empty prompts
        if (!text.trim()) return;

        await sender.sendAsWebhook("claude", threadId, `**You:** ${text}`);
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
            const resultBlock = block as {
              content: string | unknown[];
              is_error?: boolean;
              tool_use_id?: string;
            };
            const formatted = formatToolResult(resultBlock);
            if (formatted) {
              // Route to the correct webhook based on the originating tool
              const toolName = resultBlock.tool_use_id
                ? (toolUseIdToName.get(resultBlock.tool_use_id) ?? "unknown")
                : "unknown";
              const webhookName = getToolWebhook(toolName);
              await sender.sendAsWebhook(webhookName, threadId, formatted);
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
      if (entry.subtype === "turn_duration" && entry.durationMs) {
        const seconds = (entry.durationMs / 1000).toFixed(1);
        await sender.sendAsWebhook(
          "system",
          threadId,
          `⏱️ Turn completed in ${seconds}s`,
        );
      }
      // Other system subtypes: skip in Phase 3
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
