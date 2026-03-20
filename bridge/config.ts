import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { config as dotenvConfig } from "dotenv";
import type { DiscordConfig } from "./types";
import { BRIDGE_PORT, LOG_PREFIX } from "./constants";

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
  // Check common plugin data path before generic fallback
  const pluginDataPath = path.join(
    os.homedir(),
    ".claude",
    "plugins",
    "data",
    "discord-bridge-marketplace",
  );
  if (fs.existsSync(pluginDataPath)) return pluginDataPath;
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
