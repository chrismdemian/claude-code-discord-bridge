import type { BridgeSession } from "./types";

async function main() {
  console.log("[discord-bridge] Bridge service starting...");

  // Phase 2: Load config, create Discord client, login
  // Phase 2: Set up session scanner
  // Phase 3: Wire transcript tailer to session scanner
  // Phase 5: Start MCP relay HTTP server
  // Phase 6: Start hook receiver

  console.log("[discord-bridge] Bridge service ready");
}

main().catch((err) => {
  console.error("[discord-bridge] Fatal error:", err);
  process.exit(1);
});
