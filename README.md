<div align="center">

# Claude Code Discord Bridge

### Control Claude Code from your phone.

Every running Claude Code instance on your PC automatically appears in Discord.
See everything Claude does. Send prompts. Approve permissions. All from your phone.

<!-- TODO: Replace with actual screenshot/GIF -->
![Demo](https://via.placeholder.com/800x450.png?text=REPLACE+WITH+DEMO+GIF)

[![GitHub Stars](https://img.shields.io/github/stars/chrismdemian/claude-code-discord-bridge?style=flat&logo=github&cacheSeconds=300)](https://github.com/chrismdemian/claude-code-discord-bridge)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet)](https://code.claude.com)

</div>

---

## Install

```bash
# From GitHub (available now)
git clone https://github.com/chrismdemian/claude-code-discord-bridge.git
cd claude-code-discord-bridge
bun install

# Or when available on the marketplace:
# claude plugin install discord-bridge@marketplace
```

Then run the setup wizard:

```
/discord-bridge:setup
```

Paste your Discord bot token. Everything else is automatic: server created, channels configured, bot branded, hooks wired up. Join from your phone and you're done.

---

## What You Get

**Full output mirroring**, not just a chat bridge. Every tool call, diff, terminal output, and screenshot appears in Discord, formatted for mobile.

<!-- TODO: Replace with actual screenshot -->
![Session View](https://via.placeholder.com/800x500.png?text=REPLACE+WITH+SESSION+SCREENSHOT)

| Feature | Description |
|---------|-------------|
| **Auto-discovery** | Bridge finds all running Claude Code instances automatically |
| **Forum post per session** | Each session gets its own post, auto-named, auto-tagged |
| **Rich diffs** | File edits shown with syntax-highlighted diff formatting |
| **Terminal output** | Bash commands and output with ANSI color support |
| **Screenshots** | Playwright captures forwarded as image attachments |
| **Permission buttons** | Approve or deny from your phone with one tap |
| **Stop button** | Interrupt Claude mid-task |
| **Slash commands** | All 48+ Claude Code commands work from Discord |
| **Plan mode** | See plans with Execute/Modify/Clear buttons |
| **Cost tracking** | Token usage and cost on every response |
| **Smart notifications** | Only pings you when Claude actually needs input |
| **Multi-instance** | 1-8+ simultaneous sessions, each in its own post |

---

## How It Works

```
Your PC                                        Your Phone
┌────────────────────────────┐                ┌──────────────┐
│ Claude Code Instance 1     │─transcript─┐   │              │
│ Claude Code Instance 2     │─transcript─┤   │   Discord    │
│ Claude Code Instance 3     │─transcript─┤   │              │
│                            │            │   │  #sessions   │
│ Bridge Service ◄────────────────────────┘   │  ├── fix-bug │
│ (persistent process)       │                │  ├── api-v2  │
│  └── Discord bot           │◄── WiFi ──────►│  └── tests   │
│  └── Transcript tailer     │                │              │
│  └── Hook receiver         │                │              │
└────────────────────────────┘                └──────────────┘
```

Two components:

1. **Plugin**: lightweight MCP server inside Claude Code. Handles input (Discord to Claude Code) via the Channels system.
2. **Bridge Service**: persistent process on your PC. Monitors sessions, tails transcripts, formats output for Discord. Stays alive even when Claude Code exits.

---

## Setup (3 steps)

### 1. Create a Discord Bot

Go to [discord.com/developers](https://discord.com/developers/applications), create a New Application, go to Bot, and copy the token.

Enable these intents under Bot settings:
- [x] Server Members Intent
- [x] Message Content Intent

### 2. Install and Configure

```bash
# Clone and install
git clone https://github.com/chrismdemian/claude-code-discord-bridge.git
cd claude-code-discord-bridge
bun install

# Run the setup wizard
/discord-bridge:setup
```

Paste your bot token when prompted. The wizard:
- Creates a Discord server with the right structure
- Sets the bot's name and avatar
- Configures forum channel, dashboard, alerts
- Installs the bridge service
- Gives you a join link

### 3. Join on Your Phone

Open the invite link on your phone. Done.

Every Claude Code session you start will automatically appear as a forum post.

---

## Discord Experience

### Session Forum Posts

Each Claude Code session becomes a forum post with status tags:

<!-- TODO: Replace with actual screenshot -->
![Forum Posts](https://via.placeholder.com/800x400.png?text=REPLACE+WITH+FORUM+SCREENSHOT)

### Tool Calls in Threads

Main post stays clean, just your prompts and Claude's responses. Tool call details live in expandable threads:

<!-- TODO: Replace with actual screenshot -->
![Thread View](https://via.placeholder.com/800x500.png?text=REPLACE+WITH+THREAD+SCREENSHOT)

### Permission Approval

Approve or deny commands right from your phone:

<!-- TODO: Replace with actual screenshot -->
![Permission Buttons](https://via.placeholder.com/400x200.png?text=REPLACE+WITH+PERMISSION+SCREENSHOT)

### Dashboard

See all sessions at a glance:

<!-- TODO: Replace with actual screenshot -->
![Dashboard](https://via.placeholder.com/800x300.png?text=REPLACE+WITH+DASHBOARD+SCREENSHOT)

---

## Commands

All Claude Code slash commands work from Discord, just type them:

```
/plan          Enter plan mode
/commit        Commit changes
/cost          Show token usage
/compact       Compact context
/clear         Clear session (archives post, creates new)
```

Discord-specific commands:

```
/sessions      List all active sessions
/status        Quick status check
/stop          Interrupt current task
```

---

## Requirements

- [Bun](https://bun.sh) runtime
- [Claude Code](https://code.claude.com) v2.1.70+
- Discord account
- Discord bot token ([create one](https://discord.com/developers/applications))

---

## Architecture

Built on Anthropic's **Channels** system, the MCP capability that allows external services to push messages into Claude Code sessions.

**Output mirroring** uses transcript tailing (not hooks alone), giving ~99% coverage of everything Claude does. The transcript JSONL file is written synchronously by Claude Code, making it a reliable real-time data source.

**Input routing** uses the Channel plugin's `notifications/claude/channel` capability to inject Discord messages into the Claude Code session.

---

## Contributing

Contributions welcome! Please read the [contributing guidelines](CONTRIBUTING.md) first.

```bash
# Clone the repo
git clone https://github.com/chrismdemian/claude-code-discord-bridge.git

# Install dependencies
bun install

# Run in development mode
claude --plugin-dir ./
```

---

## License

Apache 2.0. See [LICENSE](LICENSE).

---

<div align="center">

**Built with Claude Code, for Claude Code users.**

[Report a Bug](https://github.com/chrismdemian/claude-code-discord-bridge/issues) · [Request a Feature](https://github.com/chrismdemian/claude-code-discord-bridge/issues)

</div>
