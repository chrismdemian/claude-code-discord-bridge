import { LOG_PREFIX } from "./constants";

/**
 * Send input to a terminal associated with a Claude Code session.
 * Uses WriteConsoleInput on Windows to inject keystrokes directly into
 * the console input buffer — no window focus needed.
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

  // Windows: use WriteConsoleInput via PowerShell P/Invoke
  // This writes directly to the console input buffer without needing window focus
  const escapedChars = JSON.stringify(input);

  const script = `
$cs = @"
using System;
using System.Runtime.InteropServices;

public class ConIn {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteConsoleInput(
        IntPtr hConsoleInput,
        INPUT_RECORD[] lpBuffer,
        uint nLength,
        out uint lpNumberOfEventsWritten);

    public const int STD_INPUT_HANDLE = -10;

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct KEY_EVENT_RECORD {
        [FieldOffset(0)]  public int bKeyDown;
        [FieldOffset(4)]  public ushort wRepeatCount;
        [FieldOffset(6)]  public ushort wVirtualKeyCode;
        [FieldOffset(8)]  public ushort wVirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar;
        [FieldOffset(12)] public uint dwControlKeyState;
    }

    public static bool Send(int pid, string text) {
        FreeConsole();
        if (!AttachConsole(pid)) {
            int err = Marshal.GetLastWin32Error();
            Console.Error.WriteLine("AttachConsole failed for PID " + pid + " error=" + err);
            return false;
        }

        IntPtr h = GetStdHandle(STD_INPUT_HANDLE);
        if (h == IntPtr.Zero || h == (IntPtr)(-1)) {
            Console.Error.WriteLine("GetStdHandle failed");
            FreeConsole();
            return false;
        }

        var records = new INPUT_RECORD[text.Length * 2];
        for (int i = 0; i < text.Length; i++) {
            char c = text[i];
            ushort vk = 0;
            if (c == '\\n') vk = 0x0D; // VK_RETURN

            // Key down
            records[i * 2].EventType = 1; // KEY_EVENT
            records[i * 2].KeyEvent.bKeyDown = 1;
            records[i * 2].KeyEvent.wRepeatCount = 1;
            records[i * 2].KeyEvent.UnicodeChar = c == '\\n' ? '\\r' : c;
            records[i * 2].KeyEvent.wVirtualKeyCode = vk;

            // Key up
            records[i * 2 + 1].EventType = 1;
            records[i * 2 + 1].KeyEvent.bKeyDown = 0;
            records[i * 2 + 1].KeyEvent.wRepeatCount = 1;
            records[i * 2 + 1].KeyEvent.UnicodeChar = c == '\\n' ? '\\r' : c;
            records[i * 2 + 1].KeyEvent.wVirtualKeyCode = vk;
        }

        uint written;
        bool ok = WriteConsoleInput(h, records, (uint)records.Length, out written);
        FreeConsole();
        return ok;
    }
}
"@

Add-Type -TypeDefinition $cs

$text = ${escapedChars}
if ([ConIn]::Send(${pid}, $text)) {
    Write-Output "OK"
} else {
    exit 1
}
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
      console.log(`${LOG_PREFIX} Terminal input sent to PID ${pid}`);
      return true;
    }

    console.error(`${LOG_PREFIX} Terminal input failed (exit=${exitCode}): ${stderr.trim()}`);
    return false;
  } catch (err) {
    console.error(`${LOG_PREFIX} Terminal input error:`, err);
    return false;
  }
}
