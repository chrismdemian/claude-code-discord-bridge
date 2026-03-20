# Contributing to Claude Code Discord Bridge

Thanks for your interest in contributing!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/chrismdemian/claude-code-discord-bridge.git`
3. Install dependencies: `bun install`
4. Create a branch: `git checkout -b feature/your-feature`

## Development

Run the plugin in development mode:

```bash
claude --plugin-dir ./
```

Run the bridge service in development mode:

```bash
bun run bridge/index.ts
```

## Pull Requests

- Keep PRs focused on a single change
- Include a description of what and why
- Test your changes with a real Discord bot and Claude Code session

## Reporting Issues

- Use GitHub Issues
- Include your Claude Code version (`claude --version`)
- Include your OS and Node/Bun version
- Include steps to reproduce

## Code Style

- TypeScript throughout
- Use Bun APIs where available
- Keep it simple — minimal abstractions
- Follow existing patterns in the codebase

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
