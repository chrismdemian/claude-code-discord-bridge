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
   1. Create New Application → name it "Claude"
   2. Go to Bot → Reset Token → copy it
   3. Under Bot → Privileged Gateway Intents → enable Message Content Intent
   4. Paste your token below:
   ```

   Additional setup the user will need (guide them through after the token):
   - Go to OAuth2 > URL Generator > Select scopes: **bot**, **applications.commands**
   - Select bot permissions: Send Messages, Manage Webhooks, Create Public Threads,
     Send Messages in Threads, Manage Threads, Embed Links, Attach Files,
     Read Message History, Add Reactions, Use External Emojis, Manage Messages
   - Copy the generated URL and have the user open it to add bot to their server
     (or create a new server first named "Terminal")

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
   To find the Server ID: enable **Developer Mode** in Discord settings (User Settings > Advanced > Developer Mode), then right-click the server name and click **Copy Server ID**. If no guild ID is provided, the setup script will auto-discover the first guild the bot is in.

5. Run the bridge service to set up Discord server structure:
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT} && bun run bridge/setup.ts
   ```
   This will:
   - Login the bot
   - Auto-brand: set bot username to "Claude Code" and avatar
   - Find or create the CLAUDE CODE category
   - Find or create #sessions (forum), #dashboard, #alerts channels
   - Create webhooks (Claude, Terminal, Editor, Playwright, Git, System)
   - Save all Discord IDs to `${CLAUDE_PLUGIN_DATA}/discord.json`
   - Post a welcome message with setup confirmation

6. Install the bridge as a persistent service:
   ```bash
   npx pm2 start ${CLAUDE_PLUGIN_ROOT}/bridge/index.ts --name discord-bridge --interpreter bun
   npx pm2 save
   npx pm2 startup
   ```

7. Verify everything works:
   ```bash
   curl http://localhost:7676/health
   ```

8. Show the user the Discord server invite link (printed by the setup script output) and suggest they join on their phone.

9. Remind the user of manual actions:
   - **BOT AVATAR**: If the auto-set avatar failed, go to Discord Developer Portal > Your App > Bot > Upload the Claude Code crab icon
   - **JOIN ON PHONE**: Open the invite link on your phone
   - **SERVER ICON**: Optionally set the "Terminal" server icon in Discord > Server Settings
   - **SCREENSHOTS**: After your first session, take screenshots for the README

## Troubleshooting

- If the bot can't connect: verify the token is correct and MESSAGE CONTENT intent is enabled
- If channels already exist: setup will reuse them (idempotent)
- If pm2 is not installed: `npm install -g pm2`
- Check bridge logs: `npx pm2 logs discord-bridge`
- If `setUsername` fails: Discord limits bot username changes to 2 per hour. Wait and retry, or change it manually in the Developer Portal.
- If guild creation fails: create a server manually in Discord, invite the bot, and add `DISCORD_GUILD_ID` to `.env` before re-running setup.
