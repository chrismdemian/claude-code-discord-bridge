import * as path from "node:path";
import * as os from "node:os";

// Network
export const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "7676", 10);

// Claude Code paths
export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
export const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

// Discord embed colors
export const COLORS = {
  BLUE: 0x5865f2,
  GREEN: 0x57f287,
  RED: 0xed4245,
  YELLOW: 0xfee75c,
  GRAY: 0x95a5a6,
} as const;

// Forum tag definitions
export const FORUM_TAGS = {
  ACTIVE: { name: "🟢 Active", moderated: false },
  WORKING: { name: "🟡 Working", moderated: false },
  COMPLETED: { name: "✅ Completed", moderated: false },
  ERROR: { name: "🔴 Error", moderated: false },
  OPUS: { name: "🧠 Opus", moderated: false },
  SONNET: { name: "⚡ Sonnet", moderated: false },
  HAIKU: { name: "💨 Haiku", moderated: false },
} as const;

// Webhook identity names
export const WEBHOOK_NAMES = [
  "Claude",
  "Terminal",
  "Editor",
  "Playwright",
  "Git",
  "System",
] as const;

// Discord channel names
export const CATEGORY_NAME = "CLAUDE CODE";
export const FORUM_CHANNEL_NAME = "sessions";
export const DASHBOARD_CHANNEL_NAME = "dashboard";
export const ALERTS_CHANNEL_NAME = "alerts";

// Message length limits
export const MAX_CONTENT_LENGTH = 1900;
export const MAX_EMBED_DESCRIPTION = 4000;

// Logging
export const LOG_PREFIX = "[discord-bridge]";
