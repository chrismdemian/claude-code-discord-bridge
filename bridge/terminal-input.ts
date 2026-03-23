import { LOG_PREFIX } from "./constants";

/**
 * Send input to a terminal associated with a Claude Code session.
 *
 * On Windows: Uses UI Automation to find the specific Windows Terminal
 * window by matching its title against the session's cwd/project name,
 * then activates that window and sends keystrokes via SendKeys.
 *
 * On Unix: Writes directly to /proc/<pid>/fd/0.
 */
export async function sendTerminalInput(
  pid: number,
  input: string,
  cwd?: string,
): Promise<boolean> {
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

  // Windows: Use UI Automation to find the right terminal window,
  // then SetForegroundWindow + SendKeys
  const escaped = input
    .replace(/[+^%~(){}[\]]/g, "{$&}")
    .replace(/\n/g, "{ENTER}");

  // Build search terms from the cwd to match the window title
  const projectName = cwd ? cwd.split(/[\\/]/).pop() ?? "" : "";

  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$root = [System.Windows.Automation.AutomationElement]::RootElement

# Find all Windows Terminal windows
$wtCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$wtWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $wtCondition)

$targetHwnd = $null
$projectName = "${projectName}"

foreach ($wt in $wtWindows) {
    $title = $wt.Current.Name
    $hwnd = $wt.Current.NativeWindowHandle

    # Match by project name in the window title
    if ($projectName -and $title -like "*$projectName*") {
        $targetHwnd = [IntPtr]$hwnd
        break
    }
}

# Fallback: if no project name match, try to find any "Claude Code" window
if (-not $targetHwnd) {
    foreach ($wt in $wtWindows) {
        $title = $wt.Current.Name
        if ($title -like "*Claude Code*" -or $title -like "*claude*") {
            $targetHwnd = [IntPtr]$wt.Current.NativeWindowHandle
            break
        }
    }
}

if (-not $targetHwnd) {
    Write-Error "No matching terminal window found for project '$projectName'"
    exit 1
}

# Activate the window and send keystrokes
[WinAPI]::SetForegroundWindow($targetHwnd) | Out-Null
Start-Sleep -Milliseconds 300
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
      console.log(`${LOG_PREFIX} Terminal input sent to window for "${projectName}"`);
      return true;
    }

    console.error(`${LOG_PREFIX} Terminal input failed: ${stderr.trim() || stdout.trim()}`);
    return false;
  } catch (err) {
    console.error(`${LOG_PREFIX} Terminal input error:`, err);
    return false;
  }
}
