---
name: setup
description: Set up the Discord bridge — connect your bot, create server structure, start the bridge service
---

# Discord Bridge Setup

Walk the user through setting up the Discord bridge.

## Steps

1. **Open the Discord Developer Portal** in the user's browser automatically. Detect the platform and run the appropriate command:
   - macOS: `open https://discord.com/developers/applications`
   - Windows: `start https://discord.com/developers/applications`
   - Linux: `xdg-open https://discord.com/developers/applications`

   Then print this concise guide:
   ```
   1. Click "New Application" → name it "Claude Code"
   2. Go to Bot → Reset Token → copy it
   3. Under Bot → Privileged Gateway Intents → enable Message Content Intent
   4. Paste your token below:
   ```

2. Ask the user to paste the bot token.

3. Save the token to `${CLAUDE_PLUGIN_DATA}/.env`:
   ```
   DISCORD_TOKEN=<the token>
   BRIDGE_PORT=7676
   ```

4. If the user also has a guild ID (server ID), add it:
   ```
   DISCORD_GUILD_ID=<the guild id>
   ```
   To find the Server ID: enable **Developer Mode** in Discord settings (User Settings > Advanced > Developer Mode), then right-click the server name and click **Copy Server ID**. If no guild ID is provided, the setup script will auto-create a server or generate an OAuth2 invite URL.

5. Run the setup script:
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT} && bun run bridge/setup.ts
   ```
   This will:
   - Check that pm2 is installed
   - Login the bot and auto-brand it
   - Find or create the Discord server (or print an OAuth2 invite URL if auto-creation fails)
   - Set up the CLAUDE CODE category with #sessions, #dashboard, and #alerts channels
   - Create webhooks and save config
   - Post a welcome message and generate an invite link
   - Prompt to add a shell alias (`claude-dc`)
   - Prompt to start the bridge service via pm2 and verify health

6. Show the user the Discord server invite link (printed by the setup script output) and suggest they join on their phone.

7. Remind the user of manual actions:
   - **BOT AVATAR**: If the auto-set avatar failed, go to Discord Developer Portal > Your App > Bot > Upload the Claude Code crab icon
   - **JOIN ON PHONE**: Open the invite link on your phone
   - **SERVER ICON**: Optionally set the "Terminal" server icon in Discord > Server Settings

## Troubleshooting

- If the bot can't connect: verify the token is correct and MESSAGE CONTENT intent is enabled
- If channels already exist: setup will reuse them (idempotent)
- If pm2 is not installed: `npm install -g pm2` then re-run setup
- If guild creation fails: the setup script prints an OAuth2 invite URL — open it to add the bot to your server, then re-run setup
- Check bridge logs: `npx pm2 logs discord-bridge`
- If `setUsername` fails: Discord limits bot username changes to 2 per hour. Wait and retry, or change it manually in the Developer Portal.
- If the bridge fails to start: check `npx pm2 logs discord-bridge` for errors
