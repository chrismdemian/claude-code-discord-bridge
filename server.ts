import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PREFIX = "[discord-bridge]";
console.error(`${PREFIX} MCP server starting... (pid=${process.pid}, ppid=${process.ppid})`);

const BRIDGE_URL = `http://localhost:${process.env.BRIDGE_PORT || 7676}`;
const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");

const mcp = new Server(
  { name: "discord-bridge", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
    },
    instructions: [
      "Messages from Discord arrive as <channel source=\"discord-bridge\" ...>.",
      "These are real messages from a human on their phone via Discord.",
      "Treat them as user input and respond normally.",
      "Use the send_to_discord tool to send files or images to the Discord session.",
      "Use the react_in_discord tool to react with emoji.",
      "",
      "",
      "PLAN MODE: Do NOT use EnterPlanMode/ExitPlanMode when responding to Discord messages.",
      "The plan approval prompt cannot be controlled remotely yet.",
      "Instead, output your plan as structured text with numbered steps,",
      "files to modify, and a verification step. End with 'Reply to approve or tell me what to change.'",
      "Wait for the user's reply before implementing.",
    ].join("\n"),
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

  for (let i = 0; i < 10; i++) {
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
 * Resolve the project CWD for matching against session files.
 * process.cwd() is unreliable because .mcp.json uses --cwd to set it to
 * the plugin installation directory. Try env vars that reflect the real project dir.
 */
function getProjectCwd(): string | null {
  // CLAUDE_PROJECT_DIR — may be set by future Claude Code versions
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir) return path.resolve(projectDir);

  // PWD — set by Claude Code to the actual project directory, survives --cwd
  const pwd = process.env.PWD;
  if (pwd) return path.resolve(pwd);

  return null;
}

/**
 * Scan ~/.claude/sessions/*.json to find our parent Claude Code process.
 * The session file contains { pid, sessionId, cwd, startedAt }.
 *
 * Match strategies (in order):
 * 1. Ancestor PID match — walk the process tree
 * 2. CWD match — compare project dir from env vars against session cwd
 * 3. Most recent session — fallback to latest startedAt
 *
 * Retries because the session file may not exist yet when the MCP server starts.
 */
async function discoverSessionId(): Promise<string> {
  const maxAttempts = 10;
  const delayMs = 2000;
  const ancestorPids = getAncestorPids();
  const projectCwd = getProjectCwd();
  console.error(`${PREFIX} Ancestor PIDs: ${ancestorPids.join(", ")}`);
  console.error(`${PREFIX} Project CWD: ${projectCwd ?? "(not available)"} (process.cwd=${process.cwd()})`);

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

      // Parse all session files once
      const sessions: Array<{ sessionId: string; pid: number; cwd: string; startedAt: number }> = [];
      for (const file of files) {
        try {
          const raw = JSON.parse(
            fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8"),
          );
          if (raw.sessionId) sessions.push(raw);
        } catch {
          // Skip unreadable files
        }
      }

      // Strategy 1: match by ancestor PID (handles intermediate processes)
      for (const session of sessions) {
        if (session.pid && ancestorPids.includes(session.pid)) {
          console.error(
            `${PREFIX} Discovered session via ancestor PID match: ${session.sessionId} (pid=${session.pid})`,
          );
          return session.sessionId;
        }
      }

      // Strategy 2: match by CWD using resolved project directory
      if (projectCwd) {
        const normalizedCwd = projectCwd.toLowerCase();
        for (const session of sessions) {
          if (
            session.cwd &&
            path.resolve(session.cwd).toLowerCase() === normalizedCwd
          ) {
            console.error(
              `${PREFIX} Discovered session via CWD match: ${session.sessionId} (cwd=${session.cwd})`,
            );
            return session.sessionId;
          }
        }
      }

      // Strategy 3: pick the most recently created session (last resort)
      // Only use this after a few attempts to give PID/CWD matching a fair chance
      if (attempt >= 3 && sessions.length > 0) {
        const newest = sessions.reduce((a, b) =>
          (b.startedAt || 0) > (a.startedAt || 0) ? b : a,
        );
        if (newest.sessionId) {
          console.error(
            `${PREFIX} Discovered session via most-recent fallback: ${newest.sessionId} (startedAt=${newest.startedAt}, pid=${newest.pid})`,
          );
          return newest.sessionId;
        }
      }

      console.error(
        `${PREFIX} No matching session found, attempt ${attempt}/${maxAttempts} (ancestors=${ancestorPids.join(",")}, projectCwd=${projectCwd})`,
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
          type?: string;
          message?: string;
          senderId?: string;
          request_id?: string;
          behavior?: string;
        };

        // Permission verdict from Discord button click
        if (msg.type === "permission_verdict" && msg.request_id && msg.behavior) {
          sendPermissionVerdict(msg.request_id, msg.behavior as "allow" | "deny");
          continue;
        }

        // Normal chat message from Discord
        if (msg.message) {
          console.error(`${PREFIX} Received message from Discord: "${msg.message.slice(0, 50)}"`);
          mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: msg.message,
              meta: {
                sender_id: msg.senderId ?? "unknown",
                source: "discord",
              },
            },
          }).catch((err) => {
            console.error(`${PREFIX} Channel notification FAILED:`, err);
          });
        }
        continue;
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

// ── Channel Permission Relay ─────────────────────────────────────────
// Matches the official Discord/Telegram plugin pattern exactly.
// When Claude needs tool approval, it sends permission_request in parallel
// with the terminal dialog. We forward to the bridge (Discord thread).
// User replies "yes abcde" or "no abcde". First response wins.

// Handle permission requests via fallback handler (setNotificationHandler causes
// TypeScript deep type instantiation errors with the MCP SDK's Zod generics).
// The logic matches the official Discord/Telegram plugins exactly.
const origFallback = mcp.fallbackNotificationHandler;
mcp.fallbackNotificationHandler = async (notification) => {
  const method = (notification as { method?: string }).method;
  if (method !== "notifications/claude/channel/permission_request") {
    if (origFallback) return origFallback(notification);
    return;
  }

  if (!currentSessionId) return;

  const params = (notification as { params?: Record<string, unknown> }).params ?? {};
  const requestId = String(params.request_id ?? "");
  const toolName = String(params.tool_name ?? "unknown");
  const description = String(params.description ?? "");
  const inputPreview = String(params.input_preview ?? "");

  console.error(`${PREFIX} 🔐 Permission request [${requestId}]: ${toolName} — ${description}`);

  try {
    await fetch(`${BRIDGE_URL}/api/channel-permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: currentSessionId,
        request_id: requestId,
        tool_name: toolName,
        description,
        input_preview: inputPreview,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`${PREFIX} Failed to relay permission request to bridge:`, err);
  }
};

/** Send a permission verdict back to Claude Code. Called by the poll loop
 *  when the bridge signals a button click via /api/permission-verdict. */
function sendPermissionVerdict(requestId: string, behavior: "allow" | "deny"): void {
  console.error(`${PREFIX} 🔐 Permission verdict: ${behavior} [${requestId}]`);

  mcp.notification({
    method: "notifications/claude/channel/permission",
    params: {
      request_id: requestId,
      behavior,
    },
  }).catch((err) => {
    console.error(`${PREFIX} Permission verdict notification FAILED:`, err);
  });
}

// ── MCP Tools ────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_to_discord",
      description: "Send files or images to the current Discord session. Use this to forward screenshots, generated images, or other files the user should see.",
      inputSchema: {
        type: "object" as const,
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach (max 10 files, 25 MB each)",
          },
          caption: {
            type: "string",
            description: "Optional short caption",
          },
        },
        required: ["files"],
      },
    },
    {
      name: "react_in_discord",
      description: "React to the latest message in the current Discord session with an emoji.",
      inputSchema: {
        type: "object" as const,
        properties: {
          emoji: {
            type: "string",
            description: "Unicode emoji (e.g. '\u2705', '\ud83d\udc4d', '\ud83c\udf89')",
          },
        },
        required: ["emoji"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "send_to_discord") {
    if (!currentSessionId) {
      return { content: [{ type: "text", text: "Not connected to bridge" }], isError: true };
    }
    const files = (args?.files as string[]) ?? [];
    const caption = args?.caption as string | undefined;

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

      const result = (await res.json()) as { messageIds?: string[]; filesSent?: number };
      const count = result.filesSent ?? result.messageIds?.length ?? 0;
      return { content: [{ type: "text", text: `Sent ${count} of ${files.length} file(s) to Discord` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err}` }], isError: true };
    }
  }

  if (name === "react_in_discord") {
    if (!currentSessionId) {
      return { content: [{ type: "text", text: "Not connected to bridge" }], isError: true };
    }
    const emoji = (args?.emoji as string) ?? "";

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
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

// ── Main ──────────────────────────────────────────────────────────────

let currentSessionId: string | null = null;

async function main() {
  // 1. Connect MCP transport
  console.error(`${PREFIX} Creating StdioServerTransport...`);
  const transport = new StdioServerTransport();
  console.error(`${PREFIX} Transport created, calling mcp.connect()...`);
  await mcp.connect(transport);
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
