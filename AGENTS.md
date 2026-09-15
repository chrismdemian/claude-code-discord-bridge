# claude-code-discord-bridge

A Claude Code plugin that mirrors Claude Code sessions to Discord. Every running instance
appears as a forum post, you see what Claude does live, and you can send prompts back from
a phone. Two halves with different lifetimes: the plugin (`server.ts`) is an MCP channel
server running inside Claude Code and dies with it, handling Discord to Claude Code; the
bridge service (`bridge/`) is a persistent pm2-managed process that stays alive and handles
Claude Code to Discord.

## Stack

Bun, TypeScript, discord.js v14, `@modelcontextprotocol/sdk`, pm2.

## Rules

- Discord's limits are hard edges, not guidance: 2,000 characters per message (chunk long
  output), 4,096 per embed description, 5 requests per 2 seconds per webhook.
- Hook timeouts differ by type — 30s for `http`, 600s for `command`. PermissionRequest must
  be a `command` hook because it needs the 600s window; everything else uses `http`.
- Hooks are defined in `hooks/hooks.json` and auto-merged with the user's own. Never write
  to their `settings.json`.
- `createWebhook`'s avatar must be a Buffer or a data URI. A file path fails.
- On Windows, stop a session with `taskkill /PID`, not `process.kill(pid, 'SIGINT')`.
- Components V2 requires the `MessageFlags.IsComponentsV2` flag.
- All Discord output goes through the formatter pipeline, one responsibility per file under
  `bridge/formatters/`. Catch and log errors rather than letting the bridge crash.
- Prefer Bun APIs where they exist (`Bun.file`, `Bun.serve`, `Bun.spawn`).
- Commit messages describe what was built. No phase numbers, no build-plan references, no
  attribution or Co-Authored-By trailers.
- After a build phase, run that phase's test criteria from `PRODUCT.md` §25 and fix what a
  review turns up before committing. Do not move on with failing tests.

## Interfaces that are not obvious from the code

- Claude Code writes session transcripts as JSONL at
  `~/.claude/projects/{encoded-path}/{session-id}.jsonl`. The bridge tails these for live
  output.
- Running sessions write PID files to `~/.claude/sessions/{pid}.json`, watched with chokidar.
- Injecting Discord messages into a session uses the `notifications/claude/channel` MCP
  capability.
- One session equals one forum post, tagged by status (Active/Completed/Error) and model.
  A single "Claude" webhook carries all output; the formatters differentiate with emoji
  prefixes and embed colours.

## Where things live

- `PRODUCT.md` §25 — the phase-by-phase build plan, each phase scoped to one session.
- `docs/BUILD-LOG.md` — what shipped, what was deliberately skipped and why, the manual
  steps Chris still owes, and the pre-setup-wizard manual config for phases 2 to 6.
- `bridge/interactions/` — permission embeds, stop button, file drops, modals, slash
  commands, reactions.
