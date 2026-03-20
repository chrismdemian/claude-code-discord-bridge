import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer(
  {
    name: "discord-bridge",
    version: "0.1.0",
  },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
    },
  }
);

const BRIDGE_URL = `http://localhost:${process.env.BRIDGE_PORT || 7676}`;

// Phase 5: Register this session with the bridge service
// Phase 5: Long-poll for incoming Discord messages

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[discord-bridge] MCP channel server running");
}

main().catch((err) => {
  console.error("[discord-bridge] Fatal error:", err);
  process.exit(1);
});
