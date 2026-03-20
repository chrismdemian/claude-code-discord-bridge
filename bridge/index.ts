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
import type { BridgeSession, DiscordConfig, ContentBlock } from "./types";
import { LOG_PREFIX } from "./constants";

const sessions = new Map<string, BridgeSession>();
const tailers = new Map<string, TranscriptTailer>();

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

  // 6. Start session scanner
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

      sessions.set(sessionInfo.sessionId, bridgeSession);
      setBotPresence(client, sessions.size);

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

  // Phase 5: Start MCP relay HTTP server
  // Phase 6: Start hook receiver

  console.log(`${LOG_PREFIX} Bridge service ready`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log(`${LOG_PREFIX} Shutting down...`);
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
