/**
 * PermissionRequest command hook.
 *
 * Reads the hook payload from stdin, POSTs it to the bridge service,
 * and waits for the user to approve/deny via Discord.
 *
 * Exit code 0 = allow, non-zero = deny.
 */

const BRIDGE_URL = `http://localhost:${process.env.BRIDGE_PORT || 7676}`;

async function main() {
  const payload = JSON.parse(await Bun.stdin.text());

  try {
    const res = await fetch(`${BRIDGE_URL}/hooks/permission-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_type: "PermissionRequest",
        session_id: payload.session_id,
        pid: payload.pid,
        cwd: payload.cwd,
        tool_name: payload.tool_name,
        tool_input: payload.tool_input,
        description: payload.description,
      }),
      signal: AbortSignal.timeout(9 * 60 * 1000), // 9 min (hook has 10 min)
    });

    if (!res.ok) {
      console.error(`[discord-bridge] Bridge returned ${res.status}`);
      process.exit(1);
    }

    const result = (await res.json()) as { approved: boolean };
    process.exit(result.approved ? 0 : 1);
  } catch (err) {
    console.error("[discord-bridge] Permission request failed:", err);
    process.exit(1);
  }
}

main();
