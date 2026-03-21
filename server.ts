import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const PREFIX = "[discord-bridge]";
const BRIDGE_URL = `http://localhost:${process.env.BRIDGE_PORT || 7676}`;
const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");

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
  },
);

// ── Session ID Discovery ──────────────────────────────────────────────

/**
 * Walk up the process tree to collect ancestor PIDs.
 * Needed because `bun run start` creates an intermediate bun process,
 * so process.ppid may not be the Claude Code PID directly.
 */
function getAncestorPids(): number[] {
  const pids: number[] = [process.pid, process.ppid];
  let current = process.ppid;

  for (let i = 0; i < 5; i++) {
    try {
      let parentPid: number | null = null;

      if (process.platform === "win32") {
        const result = Bun.spawnSync([
          "powershell.exe",
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${current}').ParentProcessId`,
        ]);
        const output = new TextDecoder().decode(result.stdout).trim();
        if (output) parentPid = parseInt(output, 10);
      } else {
        // Unix: read /proc/<pid>/stat or use ps
        const result = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(current)]);
        const output = new TextDecoder().decode(result.stdout).trim();
        if (output) parentPid = parseInt(output, 10);
      }

      if (!parentPid || parentPid <= 1 || pids.includes(parentPid)) break;
      pids.push(parentPid);
      current = parentPid;
    } catch {
      break;
    }
  }

  return pids;
}

/**
 * Scan ~/.claude/sessions/*.json to find our parent Claude Code process.
 * The session file contains { pid, sessionId, cwd, startedAt }.
 * We match on any ancestor PID, falling back to cwd match.
 * Retries because the session file may not exist yet when the MCP server starts.
 */
async function discoverSessionId(): Promise<string> {
  const maxAttempts = 10;
  const delayMs = 2000;
  const ancestorPids = getAncestorPids();
  console.error(`${PREFIX} Ancestor PIDs: ${ancestorPids.join(", ")}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        console.error(
          `${PREFIX} Sessions dir not found, attempt ${attempt}/${maxAttempts}`,
        );
        if (attempt < maxAttempts) await Bun.sleep(delayMs);
        continue;
      }

      const files = fs
        .readdirSync(SESSIONS_DIR)
        .filter((f) => f.endsWith(".json"));

      // First pass: match by ancestor PID (handles intermediate processes)
      for (const file of files) {
        try {
          const raw = JSON.parse(
            fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8"),
          );
          if (raw.pid && ancestorPids.includes(raw.pid) && raw.sessionId) {
            console.error(
              `${PREFIX} Discovered session via ancestor PID match: ${raw.sessionId} (pid=${raw.pid})`,
            );
            return raw.sessionId;
          }
        } catch {
          // Skip unreadable files
        }
      }

      // Second pass: match by cwd (normalize for Windows case-insensitivity)
      const cwd = path.resolve(process.cwd()).toLowerCase();
      for (const file of files) {
        try {
          const raw = JSON.parse(
            fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8"),
          );
          if (
            raw.cwd &&
            path.resolve(raw.cwd).toLowerCase() === cwd &&
            raw.sessionId
          ) {
            console.error(
              `${PREFIX} Discovered session via CWD match: ${raw.sessionId}`,
            );
            return raw.sessionId;
          }
        } catch {
          // Skip unreadable files
        }
      }

      console.error(
        `${PREFIX} No matching session found, attempt ${attempt}/${maxAttempts} (ancestors=${ancestorPids.join(",")}, cwd=${path.resolve(process.cwd())})`,
      );
    } catch (err) {
      console.error(
        `${PREFIX} Error scanning sessions, attempt ${attempt}/${maxAttempts}:`,
        err,
      );
    }

    if (attempt < maxAttempts) await Bun.sleep(delayMs);
  }

  throw new Error("Could not discover session ID after 10 attempts");
}

// ── Bridge Registration ───────────────────────────────────────────────

async function register(sessionId: string): Promise<boolean> {
  const body = {
    sessionId,
    pid: process.pid,
    cwd: process.cwd(),
  };

  try {
    const res = await fetch(`${BRIDGE_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      console.error(`${PREFIX} Registered with bridge: session=${sessionId}`);
      return true;
    }
    console.error(`${PREFIX} Registration returned ${res.status}`);
  } catch (err) {
    console.error(`${PREFIX} Registration failed:`, err);
  }
  return false;
}

/**
 * Persistently maintain the bridge connection. Re-registers periodically
 * to survive bridge restarts, and restarts polling if it dies.
 */
async function maintainConnection(sessionId: string): Promise<void> {
  const HEARTBEAT_INTERVAL = 30_000; // Re-register every 30s
  let polling = false;
  let wasConnected = false;

  while (true) {
    const ok = await register(sessionId);
    if (ok && !polling) {
      if (!wasConnected) {
        console.error(`${PREFIX} Bridge connection established`);
        wasConnected = true;
      }
      polling = true;
      // Start polling in background; restart on failure
      pollForMessages(sessionId).then(() => {
        console.error(`${PREFIX} Poll loop exited — will restart on next heartbeat`);
        polling = false;
      });
    } else if (!ok && wasConnected) {
      console.error(`${PREFIX} Bridge connection lost — will keep retrying`);
      wasConnected = false;
    }
    await Bun.sleep(HEARTBEAT_INTERVAL);
  }
}

async function unregister(sessionId: string): Promise<void> {
  try {
    await fetch(`${BRIDGE_URL}/unregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Best-effort — bridge will clean up on session end anyway
  }
}

// ── Message Polling ───────────────────────────────────────────────────

/**
 * Long-poll the bridge for incoming Discord messages and inject them
 * into the Claude Code session via the channel notification protocol.
 */
async function pollForMessages(sessionId: string): Promise<void> {
  const MAX_CONSECUTIVE_ERRORS = 20;
  let consecutiveErrors = 0;

  while (true) {
    try {
      const res = await fetch(`${BRIDGE_URL}/poll/${sessionId}`, {
        signal: AbortSignal.timeout(35_000), // slightly longer than bridge's 30s poll
      });

      if (res.status === 200) {
        consecutiveErrors = 0;
        const msg = (await res.json()) as {
          message: string;
          senderId: string;
        };
        // Inject into Claude Code via MCP channel notification
        await server.server.notification({
          method: "notifications/claude/channel",
          params: {
            channel: "discord-bridge",
            message: msg.message,
            metadata: { senderId: msg.senderId, source: "discord" },
          },
        });
        continue; // immediately poll again
      }

      if (res.status === 204) {
        // Normal long-poll timeout, retry immediately
        consecutiveErrors = 0;
        continue;
      }

      if (res.status === 404) {
        // Not registered — exit poll loop so maintainConnection re-registers
        console.error(`${PREFIX} Poll returned 404 — not registered, exiting poll`);
        return;
      }

      // Unexpected status
      console.error(`${PREFIX} Poll returned unexpected status ${res.status}`);
      consecutiveErrors++;
      await Bun.sleep(1000);
    } catch (err) {
      // Network error or timeout — retry after delay
      const isTimeout =
        err instanceof DOMException && err.name === "TimeoutError";
      if (isTimeout) {
        // Normal timeout from AbortSignal, just retry
        consecutiveErrors = 0;
        continue;
      }
      consecutiveErrors++;
      console.error(`${PREFIX} Poll error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err);
      await Bun.sleep(5000);
    }

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(
        `${PREFIX} Too many consecutive poll errors — stopping message relay`,
      );
      return;
    }
  }
}

// ── MCP Tools ────────────────────────────────────────────────────────

// @ts-expect-error - zod + MCP SDK type depth issue (runtime works fine)
server.tool(
  "send_to_discord",
  "Send files or images to the current Discord session. Use this to forward screenshots, generated images, or other files the user should see.",
  {
    files: z.array(z.string()).describe("Absolute file paths to attach (max 10 files, 25 MB each)"),
    caption: z.string().optional().describe("Optional short caption"),
  },
  async ({ files, caption }) => {
    if (!currentSessionId) {
      return { content: [{ type: "text", text: "Not connected to bridge" }], isError: true };
    }

    try {
      const res = await fetch(`${BRIDGE_URL}/api/send-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId, files, caption }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `Failed: ${err}` }], isError: true };
      }

      const result = await res.json() as { messageIds?: string[]; filesSent?: number };
      const count = result.filesSent ?? result.messageIds?.length ?? 0;
      return { content: [{ type: "text", text: `Sent ${count} of ${files.length} file(s) to Discord` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
    }
  },
);

server.tool(
  "react_in_discord",
  "React to the latest message in the current Discord session with an emoji.",
  {
    emoji: z.string().describe("Unicode emoji (e.g. '✅', '👍', '🎉')"),
  },
  async ({ emoji }) => {
    if (!currentSessionId) {
      return { content: [{ type: "text", text: "Not connected to bridge" }], isError: true };
    }

    try {
      const res = await fetch(`${BRIDGE_URL}/api/react`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId, emoji }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `Failed: ${err}` }], isError: true };
      }

      return { content: [{ type: "text", text: `Reacted with ${emoji}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
    }
  },
);

// ── Main ──────────────────────────────────────────────────────────────

let currentSessionId: string | null = null;

async function main() {
  // 1. Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${PREFIX} MCP channel server connected`);

  // 2. Discover our session ID
  try {
    currentSessionId = await discoverSessionId();
  } catch (err) {
    console.error(`${PREFIX} Session discovery failed:`, err);
    console.error(`${PREFIX} Running without bridge connection (no input relay)`);
    return;
  }

  console.error(`${PREFIX} MCP channel server ready (session=${currentSessionId})`);

  // 3. Maintain bridge connection (register + poll, survives bridge restarts)
  maintainConnection(currentSessionId);
}

// Graceful shutdown
const shutdown = async () => {
  if (currentSessionId) {
    await unregister(currentSessionId);
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error(`${PREFIX} Fatal error:`, err);
  process.exit(1);
});
