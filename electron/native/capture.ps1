param([switch]$Direct)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CopyNative {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int length);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] static extern IntPtr Message(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", ExactSpelling=true, CharSet=CharSet.Unicode)] static extern IntPtr ReadText(IntPtr hwnd, uint msg, IntPtr wp, StringBuilder lp, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", ExactSpelling=true, CharSet=CharSet.Unicode)] static extern IntPtr WriteText(IntPtr hwnd, uint msg, IntPtr wp, string lp, uint flags, uint timeout, out IntPtr result);
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO {
    public uint size, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public int left, top, right, bottom;
  }
  public class Selection {
    public IntPtr window, field;
    public uint process, range;
    public string contents, text;
  }
  const uint TimedMessageFlags = 0x23;
  public static Selection GetSelection(IntPtr window) {
    var gui = new GUITHREADINFO { size = (uint)Marshal.SizeOf(typeof(GUITHREADINFO)) };
    if (window == IntPtr.Zero || GetForegroundWindow() != window ||
        !GetGUIThreadInfo(0, ref gui) || gui.active != window || gui.focus == IntPtr.Zero) return null;
    var name = new StringBuilder(32);
    if (GetClassName(gui.focus, name, name.Capacity) == 0 || name.ToString() != "Edit") return null;
    // 只对可写的普通 Win32 编辑框做定向替换。
    long style = GetWindowLongPtr(gui.focus, -16).ToInt64();
    if ((style & 0x2838) != 0) return null;
    uint process;
    if (GetWindowThreadProcessId(gui.focus, out process) == 0) return null;
    IntPtr selected, length;
    if (Message(gui.focus, 0xB0, IntPtr.Zero, IntPtr.Zero, TimedMessageFlags, 150, out selected) == IntPtr.Zero ||
        Message(gui.focus, 0x0E, IntPtr.Zero, IntPtr.Zero, TimedMessageFlags, 150, out length) == IntPtr.Zero ||
        length.ToInt64() <= 0 || length.ToInt64() > 1024 * 1024) return null;
    uint range = unchecked((uint)selected.ToInt64());
    int start = (int)(range & 0xffff), end = (int)(range >> 16);
    if (range == uint.MaxValue || start >= end || end > length.ToInt64()) return null;
    var text = new StringBuilder((int)length.ToInt64() + 1);
    IntPtr copied;
    if (ReadText(gui.focus, 0x0D, new IntPtr(text.Capacity), text, TimedMessageFlags, 150, out copied) == IntPtr.Zero ||
        copied.ToInt64() != length.ToInt64() || end > text.Length) return null;
    string contents = text.ToString();
    return new Selection { window=window, field=gui.focus, process=process, range=range, contents=contents,
      text=contents.Substring(start, end-start) };
  }
  public static bool Replace(Selection original, string text) {
    if (text.IndexOf('\0') >= 0) return false;
    Selection now = GetSelection(original.window);
    if (now == null || now.field != original.field || now.process != original.process ||
        now.range != original.range || !String.Equals(now.contents, original.contents, StringComparison.Ordinal) ||
        GetForegroundWindow() != original.window) return false;
    if (String.Equals(text, original.text, StringComparison.Ordinal)) return true;
    if ((GetWindowLongPtr(now.field, -16).ToInt64() & 4) == 0 && text.IndexOfAny(new[] { '\r', '\n' }) >= 0) return false;
    IntPtr result, limit;
    string expected = now.contents.Remove((int)(now.range & 0xffff), now.text.Length)
      .Insert((int)(now.range & 0xffff), text);
    if (Message(now.field, 0xD5, IntPtr.Zero, IntPtr.Zero, TimedMessageFlags, 150, out limit) == IntPtr.Zero ||
        expected.Length > limit.ToInt64() || GetForegroundWindow() != original.window ||
        WriteText(now.field, 0xC2, new IntPtr(1), text, TimedMessageFlags, 200, out result) == IntPtr.Zero) return false;
    var written = new StringBuilder(expected.Length + 2);
    return ReadText(now.field, 0x0D, new IntPtr(written.Capacity), written, TimedMessageFlags, 150, out result) != IntPtr.Zero &&
        String.Equals(written.ToString(), expected, StringComparison.Ordinal);
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
  public static void Copy() {
    var inputs = new INPUT[4];
    inputs[0].type=1; inputs[0].data.keyboard.vk=0x11;
    inputs[1].type=1; inputs[1].data.keyboard.vk=0x43;
    inputs[2].type=1; inputs[2].data.keyboard.vk=0x43; inputs[2].data.keyboard.flags=2;
    inputs[3].type=1; inputs[3].data.keyboard.vk=0x11; inputs[3].data.keyboard.flags=2;
    if(SendInput(4,inputs,Marshal.SizeOf(typeof(INPUT)))!=4) throw new Exception("无法发送复制操作，请检查目标程序权限");
  }
}
'@
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  while (([CopyNative]::GetAsyncKeyState(0x10) -band 0x8000) -or ([CopyNative]::GetAsyncKeyState(0x11) -band 0x8000) -or ([CopyNative]::GetAsyncKeyState(0x12) -band 0x8000) -or ([CopyNative]::GetAsyncKeyState(0x5B) -band 0x8000)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw '请松开快捷键后再试' }
    Start-Sleep -Milliseconds 20
  }
  $selection = $null
  if ($Direct) {
    $origin = [CopyNative]::GetForegroundWindow()
    $selection = [CopyNative]::GetSelection($origin)
  }
  $before = [CopyNative]::GetClipboardSequenceNumber()
  [CopyNative]::Copy()
  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  while ([CopyNative]::GetClipboardSequenceNumber() -eq $before -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 30 }
  $after = [CopyNative]::GetClipboardSequenceNumber()
  if ($before -eq $after) { throw '未检测到本次复制更新，请选中文字，并检查目标程序权限' }
  $text = $null
  if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText) }
  if ($Direct -and [CopyNative]::GetForegroundWindow() -ne $origin) { throw '取文期间已切换应用，请重新选中文字' }
  $canReplace = $null -ne $selection -and [String]::Equals($selection.text, $text, [StringComparison]::Ordinal)
  $capture = @{before=$before;after=$after;text=$text;direct=$canReplace} | ConvertTo-Json -Compress
  [Console]::WriteLine($capture)
  if ($Direct -and $canReplace) {
    $line = [Console]::ReadLine()
    if ($null -ne $line) {
      $result = ConvertFrom-Json -InputObject $line
      $response = @{pasted=($result.text -is [string] -and [CopyNative]::Replace($selection, $result.text))} | ConvertTo-Json -Compress
      [Console]::WriteLine($response)
    }
  }
} catch { @{error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 1 }
