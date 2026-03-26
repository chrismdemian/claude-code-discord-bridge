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
   1. Click "New Application" → name it anything (e.g. "CC Bridge")
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

4. **Add bot to a Discord server.** Tell the user:
   - Create a new Discord server (click the + in Discord's sidebar), or use an existing one
   - Then open this link to add the bot (replace CLIENT_ID with the bot's Application ID from the Developer Portal General Information page):
     `https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=326954772544&scope=bot%20applications.commands`
   - Alternatively, run this to get the exact URL:
     ```bash
     cd ${CLAUDE_PLUGIN_ROOT} && bun -e "
     import { config } from 'dotenv';
     config({ path: '${CLAUDE_PLUGIN_DATA}/.env' });
     const { createClient, login } from './bridge/discord-bot';
     const c = createClient(); await login(c, process.env.DISCORD_TOKEN!);
     console.log('Add bot to your server: https://discord.com/api/oauth2/authorize?client_id=' + c.user!.id + '&permissions=326954772544&scope=bot%20applications.commands');
     c.destroy();
     "
     ```
   - Wait for the user to confirm the bot has been added to their server.

5. If the user has their Server ID, add `DISCORD_GUILD_ID=<id>` to the .env file. If not, that's fine — the setup script will auto-detect it if the bot is in exactly one server.

6. Install dependencies and run the setup script:
   ```bash
   cd ${CLAUDE_PLUGIN_ROOT} && bun install && PLUGIN_DATA=${CLAUDE_PLUGIN_DATA} bun run bridge/setup.ts --yes
   ```
   This will:
   - Check that pm2 is installed
   - Login the bot and auto-brand it
   - Auto-detect the Discord server (or ask for DISCORD_GUILD_ID if in multiple)
   - Set up the CLAUDE CODE category with #sessions, #dashboard, and #alerts channels
   - Create webhooks and save config
   - Post a welcome message and generate an invite link
   - Add a shell alias (`claude-dc`)
   - Start the bridge service via pm2 and verify health

7. Show the user the Discord server invite link (printed by the setup script output) and suggest they join on their phone.

8. Remind the user:
   - **JOIN ON PHONE**: Open the invite link on your phone
   - **START SESSIONS**: Use `claude-dc` to start Claude Code with Discord bridging
   - **BOT AVATAR**: If the auto-set avatar failed, set it manually in the Developer Portal

## Troubleshooting

- If the bot can't connect: verify the token is correct and MESSAGE CONTENT intent is enabled
- If channels already exist: setup will reuse them (idempotent)
- If pm2 is not installed: `npm install -g pm2` then re-run setup
- If bot is not in any server: create a server in Discord, then open the OAuth2 invite URL to add the bot
- Check bridge logs: `npx pm2 logs discord-bridge`
- If `setUsername` fails: Discord limits bot username changes to 2 per hour. Wait and retry, or change it manually in the Developer Portal.
- If the bridge fails to start: check `npx pm2 logs discord-bridge` for errors
