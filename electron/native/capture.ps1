$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CopyNative {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
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
  $before = [CopyNative]::GetClipboardSequenceNumber()
  [CopyNative]::Copy()
  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  while ([CopyNative]::GetClipboardSequenceNumber() -eq $before -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 30 }
  $after = [CopyNative]::GetClipboardSequenceNumber()
  if ($before -eq $after) { throw '未检测到本次复制更新，请选中文字，并检查目标程序权限' }
  $text = $null
  if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText) }
  @{before=$before;after=$after;text=$text} | ConvertTo-Json -Compress
} catch { @{error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 1 }
