/**
 * bridge/setup.ts — One-time Discord server provisioning script.
 *
 * Run via: bun run bridge/setup.ts
 *
 * Logs in the bot, auto-brands it, creates the server structure
 * (category + channels + webhooks), saves config, posts a welcome
 * message, prints an invite link, and optionally starts the bridge
 * service via pm2.
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

/** Required bot permissions bitmask (Send Messages, Manage Webhooks, threads, embeds, etc.) */
const REQUIRED_PERMISSIONS = "326954772544";

/** Build an OAuth2 bot invite URL with the correct permissions and scopes */
function buildOAuth2Url(clientId: string): string {
  return (
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${clientId}` +
    `&permissions=${REQUIRED_PERMISSIONS}` +
    `&scope=bot%20applications.commands`
  );
}

/** Prompt the user with a Y/n question and return whether they said yes */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = await import("node:readline");
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    iface.question(question, resolve);
  });
  iface.close();
  return !answer.trim() || answer.trim().toLowerCase().startsWith("y");
}

async function main() {
  // ── Step 0: Prerequisites ──────────────────────────────────────────
  const pm2Check = Bun.spawnSync(["npx", "pm2", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (pm2Check.exitCode !== 0) {
    console.error(
      `${PREFIX} pm2 is required but was not found.\n` +
        `  Install it with: npm install -g pm2\n` +
        `  Then re-run setup.`,
    );
    process.exit(1);
  }
  console.log(`${PREFIX} Found pm2 ${pm2Check.stdout.toString().trim()}`);

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
        // guilds.size === 0 — try to create a new server
        console.log(`${PREFIX} No guilds found — creating "Terminal" server...`);
        try {
          const newGuild = await client.guilds.create({ name: "Terminal" });
          guildId = newGuild.id;
          console.log(
            `${PREFIX} Created guild: "Terminal" (${guildId})`,
          );
        } catch (err) {
          const oauth2Url = buildOAuth2Url(client.user!.id);
          console.error(
            `${PREFIX} Could not create guild automatically.\n\n` +
              `  Open this link to add the bot to your server:\n` +
              `  ${oauth2Url}\n\n` +
              `  Then re-run setup.\n` +
              `  If you need a server, create one in Discord first, then use the link above.`,
          );
          client.destroy();
          process.exit(1);
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

    const shouldAddAlias = await promptYesNo("  Add a 'claude-dc' shell alias? (Y/n) ");

    if (shouldAddAlias) {
      try {
        if (isWindows) {
          // Detect the actual PowerShell profile path (handles OneDrive redirects, PS5 vs PS7)
          const profileResult = Bun.spawnSync(
            ["powershell.exe", "-NoProfile", "-Command", "$PROFILE"],
            { stdout: "pipe", stderr: "pipe" },
          );
          const detectedProfile = profileResult.stdout.toString().trim();
          const profilePath = detectedProfile || path.join(
            process.env.USERPROFILE || os.homedir(),
            "Documents",
            "WindowsPowerShell",
            "Microsoft.PowerShell_profile.ps1",
          );
          const profileDir = path.dirname(profilePath);
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

    // ── Step 10: Start bridge service ────────────────────────────────
    const bridgeIndexPath = path.resolve(import.meta.dir, "index.ts");
    const bridgePort = process.env.BRIDGE_PORT || "7676";
    let bridgeStarted = false;

    console.log("");
    const shouldStartBridge = await promptYesNo("  Start the bridge service now? (Y/n) ");

    if (shouldStartBridge) {
      // Stop any existing instance first (idempotent)
      Bun.spawnSync(["npx", "pm2", "delete", "discord-bridge"], {
        stdout: "ignore",
        stderr: "ignore",
      });

      console.log(`${PREFIX} Starting bridge service via pm2...`);
      const startResult = Bun.spawnSync(
        ["npx", "pm2", "start", bridgeIndexPath, "--name", "discord-bridge", "--interpreter", "bun"],
        { stdout: "inherit", stderr: "inherit" },
      );

      if (startResult.exitCode !== 0) {
        console.error(`${PREFIX} pm2 start failed. You can start it manually:`);
        console.error(`  npx pm2 start ${bridgeIndexPath} --name discord-bridge --interpreter bun`);
      } else {
        // Save the pm2 process list
        Bun.spawnSync(["npx", "pm2", "save"], {
          stdout: "inherit",
          stderr: "inherit",
        });

        // Attempt pm2 startup (auto-start on boot)
        if (!isWindows) {
          console.log(`${PREFIX} Configuring auto-start on boot...`);
          const startupResult = Bun.spawnSync(["npx", "pm2", "startup"], {
            stdout: "inherit",
            stderr: "inherit",
          });
          if (startupResult.exitCode !== 0) {
            console.warn(
              `${PREFIX} pm2 startup may need sudo. Run the command it suggests above.`,
            );
          }
        } else {
          console.log(
            `${PREFIX} On Windows, use 'pm2-windows-startup' for auto-start on boot.`,
          );
        }

        // Health check with retries
        console.log(`${PREFIX} Verifying bridge service health...`);
        for (let attempt = 0; attempt < 5; attempt++) {
          await Bun.sleep(2000);
          try {
            const resp = await fetch(`http://localhost:${bridgePort}/health`, {
              signal: AbortSignal.timeout(3000),
            });
            if (resp.ok) {
              const data = await resp.json() as { status: string };
              if (data.status === "ok") {
                bridgeStarted = true;
                console.log(`${PREFIX} ✅ Bridge service is running and healthy`);
                break;
              }
            }
          } catch {
            // Not ready yet, retry
          }
        }

        if (!bridgeStarted) {
          console.warn(
            `${PREFIX} Bridge service did not respond to health check.\n` +
              `  Check logs: npx pm2 logs discord-bridge`,
          );
        }
      }
    } else {
      console.log(`\n  To start the bridge service later:`);
      console.log(`    npx pm2 start ${bridgeIndexPath} --name discord-bridge --interpreter bun`);
      console.log(`    npx pm2 save && npx pm2 startup`);
    }

    // ── Step 11: Summary ────────────────────────────────────────────
    const oauth2Url = buildOAuth2Url(client.user!.id);

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
    console.log(`  Bot Invite: ${oauth2Url}`);
    console.log(`              (use to add bot to additional servers)`);
    console.log("");
    console.log("  Next steps:");
    console.log("  1. Open the invite link on your phone to join the server");
    if (bridgeStarted) {
      console.log("  2. Start Claude Code with:  claude-dc");
    } else {
      console.log("  2. Start the bridge service:");
      console.log(`     npx pm2 start ${bridgeIndexPath} --name discord-bridge --interpreter bun`);
      console.log("     npx pm2 save && npx pm2 startup");
      console.log("  3. Verify: curl http://localhost:7676/health");
      console.log("  4. Start Claude Code with:  claude-dc");
    }
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
