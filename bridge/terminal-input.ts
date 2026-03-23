import { LOG_PREFIX } from "./constants";

/**
 * Send input to a terminal associated with a Claude Code session.
 * Uses WriteConsoleInput on Windows via AttachConsole + CreateFile("CONIN$")
 * to inject keystrokes directly into the console input buffer.
 * No window focus needed — works with Windows Terminal ConPTY.
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

  // Build C# char array from input string
  const charArray = Array.from(input).map(c => {
    if (c === '\n') return "(char)10";
    if (c === '\r') return "(char)13";
    return `(char)${c.charCodeAt(0)}`;
  }).join(", ");

  const scriptPath = `${(process.env.HOME || process.env.USERPROFILE || ".").replace(/\\/g, "/")}/_bridge_input.ps1`;

  const script = `
$cs = @"
using System;
using System.Runtime.InteropServices;

public class ConIn {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(int pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool WriteConsoleInput(
        IntPtr hConsoleInput, INPUT_RECORD[] lpBuffer,
        uint nLength, out uint lpNumberOfEventsWritten);

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD {
        [FieldOffset(0)]  public int bKeyDown;
        [FieldOffset(4)]  public ushort wRepeatCount;
        [FieldOffset(6)]  public ushort wVirtualKeyCode;
        [FieldOffset(8)]  public ushort wVirtualScanCode;
        [FieldOffset(10)] public char UnicodeChar;
        [FieldOffset(12)] public uint dwControlKeyState;
    }

    public static bool Send(int pid, char[] chars) {
        FreeConsole();
        if (!AttachConsole(pid)) {
            Console.Error.WriteLine("AttachConsole(" + pid + ") failed: " + Marshal.GetLastWin32Error());
            return false;
        }

        // CONIN$ gives the attached console's input buffer handle
        IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == (IntPtr)(-1)) {
            Console.Error.WriteLine("CreateFile CONIN$ failed: " + Marshal.GetLastWin32Error());
            FreeConsole();
            return false;
        }

        var records = new INPUT_RECORD[chars.Length * 2];
        for (int i = 0; i < chars.Length; i++) {
            char c = chars[i];
            ushort vk = 0;
            char uc = c;
            // Map newline to Enter key
            if (c == (char)10 || c == (char)13) { vk = 0x0D; uc = (char)13; }

            // Key down
            records[i * 2].EventType = 1;
            records[i * 2].KeyEvent.bKeyDown = 1;
            records[i * 2].KeyEvent.wRepeatCount = 1;
            records[i * 2].KeyEvent.UnicodeChar = uc;
            records[i * 2].KeyEvent.wVirtualKeyCode = vk;

            // Key up
            records[i * 2 + 1].EventType = 1;
            records[i * 2 + 1].KeyEvent.bKeyDown = 0;
            records[i * 2 + 1].KeyEvent.wRepeatCount = 1;
            records[i * 2 + 1].KeyEvent.UnicodeChar = uc;
            records[i * 2 + 1].KeyEvent.wVirtualKeyCode = vk;
        }

        uint written;
        bool ok = WriteConsoleInput(h, records, (uint)records.Length, out written);
        if (!ok) {
            Console.Error.WriteLine("WriteConsoleInput failed: " + Marshal.GetLastWin32Error());
        }
        CloseHandle(h);
        FreeConsole();
        return ok;
    }
}
"@

Add-Type -TypeDefinition $cs

$chars = @(${charArray})
if ([ConIn]::Send(${pid}, $chars)) {
    Write-Output "OK"
} else {
    exit 1
}
`;

  try {
    await Bun.write(scriptPath, script);
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
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

    console.error(`${LOG_PREFIX} Terminal input failed (exit=${exitCode}): ${stderr.trim() || stdout.trim()}`);
    return false;
  } catch (err) {
    console.error(`${LOG_PREFIX} Terminal input error:`, err);
    return false;
  }
}
