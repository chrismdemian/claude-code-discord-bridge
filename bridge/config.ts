import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { config as dotenvConfig } from "dotenv";
import type { AccessConfig, DiscordConfig } from "./types";
import { BRIDGE_PORT, LOG_PREFIX } from "./constants";

const SNOWFLAKE_RE = /^\d{17,20}$/;

export interface BridgeConfig {
  token: string;
  guildId: string;
  bridgePort: number;
  discord: DiscordConfig | null;
}

/** Resolve the plugin data directory */
export function getPluginDataPath(): string {
  if (process.env.PLUGIN_DATA) return process.env.PLUGIN_DATA;
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  // Check common plugin data paths (name varies by install method)
  const pluginDataDir = path.join(os.homedir(), ".claude", "plugins", "data");
  if (fs.existsSync(pluginDataDir)) {
    const candidates = ["discord-bridge-claude-code-discord-bridge", "discord-bridge-marketplace"];
    for (const name of candidates) {
      const candidate = path.join(pluginDataDir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return path.join(os.homedir(), ".discord-bridge");
}

/** Load bridge configuration from .env and discord.json */
export async function loadConfig(): Promise<BridgeConfig> {
  const dataPath = getPluginDataPath();

  // Ensure directory exists
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true });
  }

  // Load .env
  const envPath = path.join(dataPath, ".env");
  dotenvConfig({ path: envPath });

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error(
      `DISCORD_TOKEN not found. Create ${envPath} with your bot token.\n` +
        `See /discord-bridge:setup for instructions.`,
    );
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    throw new Error(
      `DISCORD_GUILD_ID not found. Add it to ${envPath}.\n` +
        `See /discord-bridge:setup for instructions.`,
    );
  }

  const discord = await loadDiscordConfig();

  console.log(`${LOG_PREFIX} Config loaded from ${dataPath}`);

  return { token, guildId, bridgePort: BRIDGE_PORT, discord };
}

/** Save Discord resource IDs after setup */
export async function saveDiscordConfig(config: DiscordConfig): Promise<void> {
  const dataPath = getPluginDataPath();
  const filePath = path.join(dataPath, "discord.json");
  await Bun.write(filePath, JSON.stringify(config, null, 2));
  console.log(`${LOG_PREFIX} Discord config saved to ${filePath}`);
}

/** Load previously saved Discord config, or null if not yet set up */
export async function loadDiscordConfig(): Promise<DiscordConfig | null> {
  const dataPath = getPluginDataPath();
  const filePath = path.join(dataPath, "discord.json");
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    return (await file.json()) as DiscordConfig;
  } catch {
    return null;
  }
}

/** Check whether the bridge has been configured (both .env and discord.json exist) */
export function isConfigured(): boolean {
  const dataPath = getPluginDataPath();
  return (
    fs.existsSync(path.join(dataPath, ".env")) &&
    fs.existsSync(path.join(dataPath, "discord.json"))
  );
}

/** Validate saved config without hitting the Discord API */
export function validateConfig(
  discord: DiscordConfig | null,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!process.env.DISCORD_TOKEN) {
    errors.push("DISCORD_TOKEN is missing");
  }

  if (!discord) {
    errors.push("discord.json not found — run setup first");
    return { valid: false, errors };
  }

  if (!SNOWFLAKE_RE.test(discord.guildId)) errors.push("Invalid guildId");
  if (!SNOWFLAKE_RE.test(discord.forumChannelId))
    errors.push("Invalid forumChannelId");
  if (!SNOWFLAKE_RE.test(discord.dashboardChannelId))
    errors.push("Invalid dashboardChannelId");
  if (!SNOWFLAKE_RE.test(discord.alertsChannelId))
    errors.push("Invalid alertsChannelId");
  if (!SNOWFLAKE_RE.test(discord.categoryId)) errors.push("Invalid categoryId");

  const wh = discord.webhooks.claude;
  if (!wh?.id || !wh?.token) {
    errors.push(`Webhook "claude" missing id or token`);
  }

  return { valid: errors.length === 0, errors };
}

/** Save access control config */
export async function saveAccessConfig(config: AccessConfig): Promise<void> {
  const dataPath = getPluginDataPath();
  const filePath = path.join(dataPath, "access.json");
  await Bun.write(filePath, JSON.stringify(config, null, 2));
  console.log(`${LOG_PREFIX} Access config saved to ${filePath}`);
}

/** Load access control config, or null if not yet set up */
export async function loadAccessConfig(): Promise<AccessConfig | null> {
  const dataPath = getPluginDataPath();
  const filePath = path.join(dataPath, "access.json");
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    return (await file.json()) as AccessConfig;
  } catch {
    return null;
  }
}
