---
name: status
description: Check the Discord bridge connection status and health
---

# Discord Bridge Status

Check the health and status of the Discord bridge.

## Steps

1. Check if the bridge service is running:
   ```bash
   curl -s http://localhost:${BRIDGE_PORT:-7676}/health
   ```

2. Check if pm2 is managing the bridge:
   ```bash
   npx pm2 status discord-bridge
   ```

3. Report the results to the user:
   - Bridge status (running / not running)
   - Discord connection (connected / disconnected)
   - Number of active sessions
   - Uptime
   - If not running, suggest: `npx pm2 start ${CLAUDE_PLUGIN_ROOT}/bridge/index.ts --name discord-bridge --interpreter bun`

4. If the bridge is not running and the user hasn't set up yet, suggest running `/discord-bridge:setup`.
