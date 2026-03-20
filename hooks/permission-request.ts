/**
 * PermissionRequest command hook.
 *
 * Reads the hook payload from stdin, POSTs it to the bridge service,
 * and waits for the user to approve/deny via Discord.
 *
 * Exit code 0 = allow, non-zero = deny.
 */

import { postToBridge } from "./lib/bridge-client";

async function main() {
  const payload = JSON.parse(await Bun.stdin.text());

  try {
    const result = (await postToBridge(
      "/hooks/permission-request",
      {
        hook_type: "PermissionRequest",
        session_id: payload.session_id,
        pid: payload.pid,
        cwd: payload.cwd,
        tool_name: payload.tool_name,
        tool_input: payload.tool_input,
        description: payload.description,
      },
      9 * 60 * 1000, // 9 min (hook has 10 min total)
    )) as { approved: boolean; allowForSession?: boolean };

    if (result.approved && result.allowForSession) {
      // Signal session-level approval to Claude Code via stdout JSON
      process.stdout.write(JSON.stringify({ decision: "allowForSession" }) + "\n");
    }

    // Use exitCode instead of process.exit() to allow stdout to flush
    process.exitCode = result.approved ? 0 : 1;
  } catch (err) {
    console.error("[discord-bridge] Permission request failed:", err);
    process.exit(1);
  }
}

main();
