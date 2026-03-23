import { LOG_PREFIX } from "./constants";

/**
 * Send keystrokes to a terminal window associated with a Claude Code session.
 * Uses PowerShell on Windows to find the terminal window by PID and inject input.
 * This is the only reliable way to interact with blocking terminal prompts
 * (like plan mode approval) from a remote source like Discord.
 */
export async function sendTerminalInput(pid: number, input: string): Promise<boolean> {
  if (process.platform !== "win32") {
    // On Unix, try writing to /proc/<pid>/fd/0 (terminal stdin)
    try {
      const proc = Bun.spawn(["bash", "-c", `echo '${input.replace(/'/g, "'\\''")}' > /proc/${pid}/fd/0`]);
      await proc.exited;
      return proc.exitCode === 0;
    } catch (err) {
      console.error(`${LOG_PREFIX} Unix terminal input failed:`, err);
      return false;
    }
  }

  // Windows: use PowerShell to send keystrokes via AppActivate + SendKeys
  // We need to find the console window associated with the PID
  const escapedInput = input.replace(/[+^%~(){}[\]]/g, "{$&}").replace(/\n/g, "{ENTER}");

  const script = `
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms

# Find the terminal window — walk up from the Claude Code PID to find the console host
$targetPid = ${pid}
$current = $targetPid

# Walk up process tree to find the terminal/console window
for ($i = 0; $i -lt 10; $i++) {
    try {
        $proc = Get-Process -Id $current -ErrorAction Stop
        if ($proc.MainWindowHandle -ne 0) {
            [Microsoft.VisualBasic.Interaction]::AppActivate($current)
            Start-Sleep -Milliseconds 100
            [System.Windows.Forms.SendKeys]::SendWait("${escapedInput}")
            Write-Output "OK"
            exit 0
        }
        # Go up to parent
        $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$current").ParentProcessId
        if (-not $parent -or $parent -le 1) { break }
        $current = $parent
    } catch {
        break
    }
}
Write-Error "Could not find terminal window for PID $targetPid"
exit 1
`.trim();

  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (exitCode === 0 && stdout.includes("OK")) {
      console.log(`${LOG_PREFIX} Terminal input sent successfully to PID ${pid}`);
      return true;
    }

    console.error(`${LOG_PREFIX} Terminal input failed: ${stderr.trim()}`);
    return false;
  } catch (err) {
    console.error(`${LOG_PREFIX} Terminal input error:`, err);
    return false;
  }
}
