---
name: access
description: Manage who can interact with Claude Code sessions from Discord
---

# Discord Bridge Access Management

Manage the allowlist of Discord users who can send prompts and approve permissions.

## Steps

1. Read the current access config:
   ```bash
   cat ${CLAUDE_PLUGIN_DATA}/access.json 2>/dev/null || echo '{"allowedUsers": []}'
   ```

2. Show the user the current allowlist.

3. Ask what they want to do:
   - **Add a user**: Ask for their Discord user ID (right-click user > Copy User ID in Discord with Developer Mode enabled)
   - **Remove a user**: Show the list and let them pick
   - **List users**: Just display the current list

4. Update `${CLAUDE_PLUGIN_DATA}/access.json` with the changes.

5. The bridge service will pick up the changes on the next request (no restart needed).

## Notes

- The server owner is always allowed (added automatically during setup)
- Discord user IDs are numeric strings like "123456789012345678"
- Users need Developer Mode enabled in Discord to copy user IDs (Settings > Advanced > Developer Mode)
