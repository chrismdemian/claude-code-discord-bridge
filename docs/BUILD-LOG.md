# Build log, skipped work, and manual steps

> Moved from CLAUDE.md and AGENTS.md on 2026-09-14 when the always-loaded config was cut.
> Where the two files disagreed, CLAUDE.md was the later state and won.

## Index

- Build progress
- Manual action reminders
- Testing before the setup wizard (phases 2-6)
- Directory structure

## Build progress

- [x] **Phase 1**: Project scaffold — plugin manifest, types, hooks, MCP server stub, skills
- [x] **Phase 2**: Bridge service core — Discord bot, session scanner
- [x] **Phase 3**: Transcript tailer, basic output to Discord
- [x] **Phase 4**: Output formatting, webhook identities
- [x] **Phase 5**: Channel MCP server (Discord-to-Claude input)
- [x] **Phase 6**: Hook system
- [x] **Phase 7**: Setup skill & configuration wizard
- [x] **Phase 8**: Permission flow (approval buttons)
- [x] **Phase 9**: Interactive features (stop, file drops, modals, slash commands)
- [x] **Phase 10**: Plan mode display
- [x] **Phase 11**: Dashboard, notifications, smart alerts
- [x] **Phase 12c** (partial): Bot presence — shows active session count, idle/online status
- [x] **Phase 12d** (partial): Secret filtering on all outbound messages, guild owner access control
- [ ] ~~**Phase 12a**: Thread-per-turn manager~~ — skipped (worse mobile UX)
- [ ] ~~**Phase 12b**: Git, batch & image formatters~~ — skipped (handled by existing formatters)
- [ ] ~~**Phase 12c**: PR tracker~~ — skipped (niche, complex)
- [ ] ~~**Phase 12d**: Auto-moderation~~ — skipped (redundant with secret filtering)
- [ ] ~~**Phase 12e**: Components V2 upgrade~~ — skipped (high risk rewrite for v0.1.0)

## Manual action reminders

These are things the user must do manually — remind them at the appropriate time:

- **Phase 2**: User needs to create a Discord bot and test server manually (see Testing section below)
- **Phase 7**: After the setup skill is built, user should run it and verify the "Terminal" Discord server is created correctly
- **Assets needed**: The user needs to provide or source the Claude Code crab mascot image for `assets/claude-code-avatar.png`. Remind them when Phase 2 or 7 needs it.
- **Post-build**: User needs to take screenshots of the Discord experience and replace the placeholder images in README.md
- **Post-build**: User needs to set the Discord server icon manually in Server Settings

## Testing before the setup wizard (phase 7)

For Phases 2-6, manually create config:

1. Create Discord bot at discord.com/developers, copy token
2. Create test Discord server manually
3. Create `~/.claude/plugins/data/discord-bridge-marketplace/.env`:
   ```
   DISCORD_TOKEN=your_token
   DISCORD_GUILD_ID=your_server_id
   BRIDGE_PORT=7676
   ```
4. Create a forum channel called "sessions" in your test server

## Directory structure

```
├── server.ts                    # MCP channel server (runs inside Claude Code)
├── bridge/
│   ├── index.ts                 # Bridge service entry point
│   ├── discord-bot.ts           # Discord.js bot, webhooks, forum management
│   ├── transcript-tailer.ts     # JSONL transcript file watcher/parser
│   ├── session-scanner.ts       # Watches ~/.claude/sessions/ for instances
│   ├── hook-receiver.ts         # HTTP server receiving hook POSTs
│   ├── formatter.ts             # Central formatting dispatcher
│   ├── formatters/              # Tool-specific formatters
│   │   ├── bash.ts
│   │   ├── edit.ts
│   │   ├── read.ts
│   │   └── ...
│   └── interactions/            # Discord interaction handlers
│       ├── permission-handler.ts # Permission approval embeds/buttons
│       ├── stop-handler.ts      # Stop/interrupt button + working message
│       ├── file-handler.ts      # File drop processing from phone
│       ├── modal-handler.ts     # Long prompt modal popup
│       ├── commands.ts          # Discord slash command registration/handling
│       └── reactions.ts         # Reaction-based quick actions
├── hooks/
│   └── hooks.json               # Hook definitions (auto-merge with user hooks)
│   └── permission-request.ts    # Command hook for permissions (needs 600s timeout)
├── skills/
│   ├── setup/SKILL.md           # /discord-bridge:setup wizard
│   ├── access/SKILL.md          # /discord-bridge:access management
│   └── status/SKILL.md          # /discord-bridge:status check
├── assets/                      # Bot avatar, webhook icons
├── .claude-plugin/plugin.json   # Plugin manifest
├── .mcp.json                    # MCP server config
└── package.json                 # Dependencies
```
