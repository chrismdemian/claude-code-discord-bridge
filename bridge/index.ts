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
import type { BridgeSession } from "./types";
import type { DiscordConfig } from "./types";
import { LOG_PREFIX } from "./constants";

const sessions = new Map<string, BridgeSession>();

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

  // 5. Start session scanner
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

  // Phase 3: Wire transcript tailer to session scanner
  // Phase 5: Start MCP relay HTTP server
  // Phase 6: Start hook receiver

  console.log(`${LOG_PREFIX} Bridge service ready`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log(`${LOG_PREFIX} Shutting down...`);
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
