---
name: setup
description: Set up the Discord bridge — connect your bot, create server structure, start the bridge service
---

# Discord Bridge Setup

Walk the user through setting up the Discord bridge.

## Steps

1. Ask the user to create a Discord bot at https://discord.com/developers/applications
   - Create a New Application
   - Go to Bot tab, click Reset Token, copy the token
   - Enable these Privileged Gateway Intents: **MESSAGE CONTENT**
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

8. Show the user the Discord server invite link and suggest they join on their phone.

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
