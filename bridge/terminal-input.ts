import { LOG_PREFIX } from "./constants";

/**
 * Send input to a terminal associated with a Claude Code session.
 *
 * On Windows: Uses AppActivate + SendKeys to bring Windows Terminal to
 * foreground and type the input. This is the only reliable method that
 * works with Windows Terminal's ConPTY architecture.
 *
 * On Unix: Writes directly to /proc/<pid>/fd/0.
 */
export async function sendTerminalInput(pid: number, input: string): Promise<boolean> {
  if (process.platform !== "win32") {
    try {
      const proc = Bun.spawn(["bash", "-c", `printf '%s' '${input.replace(/'/g, "'\\''")}' > /proc/${pid}/fd/0`]);
      await proc.exited;
      return proc.exitCode === 0;
    } catch (err) {
      console.error(`${LOG_PREFIX} Unix terminal input failed:`, err);
      return false;
    }
  }

  // Windows: AppActivate + SendKeys
  // Escape special characters for SendKeys
  const escaped = input
    .replace(/[+^%~(){}[\]]/g, "{$&}")
    .replace(/\n/g, "{ENTER}");

  const script = `
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms

# Find Windows Terminal hosting this session
$wt = Get-Process -Name 'WindowsTerminal' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $wt) {
    # Fallback: try cmd.exe or powershell.exe consoles
    $wt = Get-Process -Name 'cmd','powershell','pwsh' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}
if (-not $wt) {
    Write-Error "No terminal window found"
    exit 1
}

[Microsoft.VisualBasic.Interaction]::AppActivate($wt.Id)
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("${escaped}")
Write-Output "OK"
`;

  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode === 0 && stdout.includes("OK")) {
      console.log(`${LOG_PREFIX} Terminal input sent (AppActivate+SendKeys)`);
      return true;
    }

    console.error(`${LOG_PREFIX} Terminal input failed: ${stderr.trim() || stdout.trim()}`);
    return false;
  } catch (err) {
    console.error(`${LOG_PREFIX} Terminal input error:`, err);
    return false;
  }
}
