/**
 * Shared HTTP client for command-type hook scripts to communicate
 * with the bridge service. Used by permission-request.ts (and any
 * future command hooks that need to POST to the bridge).
 */

const BRIDGE_URL = `http://localhost:${process.env.BRIDGE_PORT || 7676}`;

export async function postToBridge(
  path: string,
  payload: unknown,
  timeoutMs = 25_000,
): Promise<unknown> {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Bridge returned ${res.status}`);
  return res.json();
}
