/**
 * bridge/setup.ts — One-time Discord server provisioning script.
 *
 * Run via: bun run bridge/setup.ts
 *
 * Logs in the bot, auto-brands it, creates the server structure
 * (category + channels + webhooks), saves config, posts a welcome
 * message, and prints an invite link. Does NOT start the bridge service.
 */

import * as path from "node:path";
import * as os from "node:os";
import { config as dotenvConfig } from "dotenv";
import { EmbedBuilder, type TextChannel } from "discord.js";

import { createClient, login, setupServer } from "./discord-bot";
import {
  getPluginDataPath,
  saveDiscordConfig,
  saveAccessConfig,
} from "./config";
import { COLORS, LOG_PREFIX } from "./constants";

const PREFIX = `${LOG_PREFIX} [setup]`;

// Read version from package.json to avoid hardcoding
const pkgPath = path.resolve(import.meta.dir, "..", "package.json");
const pkg = await Bun.file(pkgPath).json().catch(() => ({ version: "0.1.0" }));
const VERSION: string = pkg.version;

async function main() {
  // ── Step 1: Load environment ────────────────────────────────────────
  const dataPath = getPluginDataPath();
  const envPath = path.join(dataPath, ".env");
  dotenvConfig({ path: envPath });

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error(
      `${PREFIX} DISCORD_TOKEN not found.\n` +
        `Create ${envPath} with:\n` +
        `  DISCORD_TOKEN=your_bot_token\n` +
        `  BRIDGE_PORT=7676`,
    );
    process.exit(1);
  }

  let guildId = process.env.DISCORD_GUILD_ID;

  console.log(`${PREFIX} Starting Discord bridge setup...`);
  console.log(`${PREFIX} Data path: ${dataPath}`);

  // ── Step 2: Login ───────────────────────────────────────────────────
  const client = createClient();
  try {
    await login(client, token);
  } catch (err) {
    console.error(
      `${PREFIX} Failed to login. Check that your bot token is correct and MESSAGE CONTENT intent is enabled.`,
    );
    console.error(err);
    process.exit(1);
  }

  try {
    // ── Step 3: Auto-brand bot ──────────────────────────────────────
    if (client.user) {
      // Username (rate-limited to 2 changes/hour — skip if already correct)
      if (client.user.username !== "Claude Code") {
        try {
          await client.user.setUsername("Claude Code");
          console.log(`${PREFIX} Bot username set to "Claude Code"`);
        } catch (err) {
          console.warn(
            `${PREFIX} Could not set bot username (rate-limited or already set). ` +
              `You can set it manually in the Discord Developer Portal.`,
          );
        }
      } else {
        console.log(`${PREFIX} Bot username already "Claude Code"`);
      }

      // Avatar
      const avatarPath = path.resolve(
        import.meta.dir,
        "..",
        "assets",
        "claude-code-avatar.png",
      );
      const avatarFile = Bun.file(avatarPath);
      if (await avatarFile.exists()) {
        try {
          const buf = Buffer.from(await avatarFile.arrayBuffer());
          await client.user.setAvatar(buf);
          console.log(`${PREFIX} Bot avatar updated`);
        } catch (err) {
          console.warn(
            `${PREFIX} Could not set bot avatar. Set it manually in the Discord Developer Portal.`,
          );
        }
      } else {
        console.warn(
          `${PREFIX} Avatar not found at ${avatarPath} — skipping. ` +
            `Place your avatar there and re-run setup, or set it manually in the Developer Portal.`,
        );
      }
    }

    // ── Step 4: Determine guild ─────────────────────────────────────
    if (guildId) {
      if (!/^\d{17,20}$/.test(guildId)) {
        console.error(
          `${PREFIX} DISCORD_GUILD_ID "${guildId}" is not a valid Discord snowflake.`,
        );
        process.exit(1);
      }
      console.log(`${PREFIX} Using configured guild: ${guildId}`);
    } else {
      console.log(`${PREFIX} No DISCORD_GUILD_ID set — discovering guild...`);
      const guilds = await client.guilds.fetch();

      if (guilds.size === 1) {
        const first = guilds.first()!;
        guildId = first.id;
        console.log(
          `${PREFIX} Found guild: ${first.name ?? first.id} (${guildId})`,
        );
      } else if (guilds.size > 1) {
        console.error(
          `${PREFIX} Bot is in ${guilds.size} guilds — cannot auto-detect which one to use.\n` +
            `Add DISCORD_GUILD_ID to your .env file.`,
        );
        process.exit(1);
      } else {
        // guilds.size === 0 — create a new server
        console.log(`${PREFIX} No guilds found — creating "Terminal" server...`);
        try {
          const newGuild = await client.guilds.create({ name: "Terminal" });
          guildId = newGuild.id;
          console.log(
            `${PREFIX} Created guild: "Terminal" (${guildId})`,
          );
        } catch (err) {
          console.error(
            `${PREFIX} Failed to create guild. Create a Discord server manually, invite the bot, ` +
              `and add DISCORD_GUILD_ID to your .env file.`,
          );
          throw err;
        }
      }

      // Write guild ID back to .env so the bridge service can use it
      const currentEnv = await Bun.file(envPath).text().catch(() => "");
      if (!currentEnv.includes("DISCORD_GUILD_ID=")) {
        await Bun.write(
          envPath,
          currentEnv.trimEnd() + `\nDISCORD_GUILD_ID=${guildId}\n`,
        );
        console.log(`${PREFIX} Saved DISCORD_GUILD_ID to ${envPath}`);
      }
    }

    // ── Step 5: Server setup ────────────────────────────────────────
    console.log(`${PREFIX} Setting up Discord server structure...`);
    const discordConfig = await setupServer(client, guildId, client.user!.username);
    await saveDiscordConfig(discordConfig);

    // ── Step 6: Access control ──────────────────────────────────────
    const guild = await client.guilds.fetch(guildId);
    const ownerId = guild.ownerId;

    if (ownerId === client.user?.id) {
      // Bot created the guild — owner is the bot itself, not a human
      console.warn(
        `${PREFIX} The bot owns this server (it was auto-created). ` +
          `Run /discord-bridge:access to add your Discord user ID.`,
      );
      await saveAccessConfig({ allowedUsers: [] });
    } else {
      await saveAccessConfig({ allowedUsers: [ownerId] });
      console.log(`${PREFIX} Access granted to guild owner: ${ownerId}`);
    }

    // ── Step 7: Welcome embed ───────────────────────────────────────
    const dashboard = (await client.channels.fetch(
      discordConfig.dashboardChannelId,
    )) as TextChannel | null;

    if (!dashboard) {
      console.warn(
        `${PREFIX} Could not fetch dashboard channel — skipping welcome message and invite link.`,
      );
    }

    const welcomeEmbed = new EmbedBuilder()
      .setColor(COLORS.GREEN)
      .setTitle("✅ Discord Bridge Connected")
      .setDescription(
        "Claude Code sessions will appear in **#sessions** as forum posts.\n" +
          "Send messages in any session thread to interact with Claude.",
      )
      .addFields(
        { name: "Status", value: "Online", inline: true },
        { name: "Version", value: VERSION, inline: true },
        {
          name: "Sessions",
          value: `<#${discordConfig.forumChannelId}>`,
          inline: true,
        },
        {
          name: "Alerts",
          value: `<#${discordConfig.alertsChannelId}>`,
          inline: true,
        },
      )
      .setTimestamp();

    // ── Step 8: Invite link ─────────────────────────────────────────
    let inviteUrl = "(could not generate invite)";

    if (dashboard) {
      await dashboard.send({ embeds: [welcomeEmbed] });
      console.log(`${PREFIX} Welcome message posted to #dashboard`);

      try {
        const invite = await dashboard.createInvite({
          maxAge: 0,
          maxUses: 0,
        });
        inviteUrl = `https://discord.gg/${invite.code}`;
      } catch {
        console.warn(
          `${PREFIX} Could not create invite link. Create one manually in Discord.`,
        );
      }
    }

    // ── Step 9: Shell alias ─────────────────────────────────────────
    const channelsFlag = "--dangerously-load-development-channels plugin:discord-bridge@claude-code-discord-bridge";
    const isWindows = process.platform === "win32";

    console.log("");
    console.log(
      `  To send messages from Discord into Claude Code, sessions must\n` +
        `  be started with the --channels flag (required during the\n` +
        `  channels research preview). A shell alias makes this easy.`,
    );
    console.log("");

    const rl = await import("node:readline");
    const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      iface.question("  Add a 'claude-dc' shell alias? (Y/n) ", resolve);
    });
    iface.close();

    const shouldAdd = !answer.trim() || answer.trim().toLowerCase().startsWith("y");

    if (shouldAdd) {
      try {
        if (isWindows) {
          // PowerShell profile
          const profileDir = path.join(
            process.env.USERPROFILE || os.homedir(),
            "Documents",
            "PowerShell",
          );
          const profilePath = path.join(profileDir, "Microsoft.PowerShell_profile.ps1");
          const aliasLine = `\nfunction claude-dc { claude ${channelsFlag} @args }\n`;

          const fs = await import("node:fs");
          fs.mkdirSync(profileDir, { recursive: true });
          const existing = await Bun.file(profilePath).text().catch(() => "");
          if (existing.includes("claude-dc")) {
            console.log(`  Alias already exists in ${profilePath}`);
          } else {
            await Bun.write(profilePath, existing.trimEnd() + "\n" + aliasLine);
            console.log(`  ✅ Alias added to ${profilePath}`);
            console.log(`     Run: . $PROFILE   (or restart your terminal)`);
          }
        } else {
          // Bash/Zsh
          const shell = process.env.SHELL || "/bin/bash";
          const rcFile = shell.includes("zsh") ? ".zshrc" : ".bashrc";
          const rcPath = path.join(os.homedir(), rcFile);
          const aliasLine = `\nalias claude-dc='claude ${channelsFlag}'\n`;

          const existing = await Bun.file(rcPath).text().catch(() => "");
          if (existing.includes("claude-dc")) {
            console.log(`  Alias already exists in ${rcPath}`);
          } else {
            await Bun.write(rcPath, existing.trimEnd() + "\n" + aliasLine);
            console.log(`  ✅ Alias added to ${rcPath}`);
            console.log(`     Run: source ~/${rcFile}   (or restart your terminal)`);
          }
        }
      } catch (err) {
        console.warn(`  Could not add alias automatically. Add it manually:`);
        if (isWindows) {
          console.warn(`    function claude-dc { claude ${channelsFlag} @args }`);
        } else {
          console.warn(`    alias claude-dc='claude ${channelsFlag}'`);
        }
      }
    } else {
      console.log(`  Skipped. To enable bidirectional messaging, start Claude with:`);
      console.log(`    claude ${channelsFlag}`);
    }

    // ── Step 10: Summary ────────────────────────────────────────────
    console.log("");
    console.log("═══════════════════════════════════════════════════════");
    console.log("  Discord Bridge Setup Complete!");
    console.log("═══════════════════════════════════════════════════════");
    console.log("");
    console.log(`  Guild:      ${guild.name} (${guildId})`);
    console.log(`  Category:   CLAUDE CODE`);
    console.log(`  Forum:      #sessions`);
    console.log(`  Dashboard:  #dashboard`);
    console.log(`  Alerts:     #alerts`);
    console.log(`  Webhook:    ${client.user!.username}`);
    console.log("");
    console.log(`  Config:     ${path.join(dataPath, "discord.json")}`);
    console.log(`  Env:        ${envPath}`);
    console.log("");
    console.log(`  Invite:     ${inviteUrl}`);
    console.log("");
    console.log("  Next steps:");
    console.log("  1. Open the invite link on your phone to join the server");
    console.log("  2. Start the bridge service:");
    console.log("     npx pm2 start bridge/index.ts --name discord-bridge --interpreter bun");
    console.log("     npx pm2 save && npx pm2 startup");
    console.log("  3. Verify: curl http://localhost:7676/health");
    console.log("  4. Start Claude Code with:  claude-dc");
    console.log("");
    console.log("═══════════════════════════════════════════════════════");

    client.destroy();
    process.exit(0);
  } catch (err) {
    console.error(`${PREFIX} Setup failed:`, err);
    client.destroy();
    process.exit(1);
  }
}

main();
