import AppKit
import ApplicationServices

func fail(_ message: String) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: ["error": message])
    FileHandle.standardOutput.write(data)
    exit(1)
}
func send(_ value: [String: Any]) throws {
    var data = try JSONSerialization.data(withJSONObject: value)
    data.append(0x0a)
    FileHandle.standardOutput.write(data)
}

let allowed = AXIsProcessTrusted()
let mode = CommandLine.arguments.dropFirst().first
if mode == "--check-permission" {
    let data = try JSONSerialization.data(withJSONObject: ["allowed": allowed])
    FileHandle.standardOutput.write(data)
    exit(0)
}
guard allowed else {
    fail("macOS 未授权当前 CopyX。请在系统设置 → 隐私与安全性 → 辅助功能中开启 CopyX；若已开启，请移除旧条目并重新添加当前安装的 CopyX。")
}
let board = NSPasteboard.general
let deadline = Date().addingTimeInterval(2)
while !CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand, .maskShift, .maskControl, .maskAlternate]).isEmpty {
    if Date() > deadline { fail("请松开快捷键后再试") }
    Thread.sleep(forTimeInterval: 0.02)
}
let before = board.changeCount
let source = CGEventSource(stateID: .hidSystemState)
let down = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: true)!
let up = CGEvent(keyboardEventSource: source, virtualKey: 8, keyDown: false)!
down.flags = .maskCommand
up.flags = .maskCommand
down.post(tap: .cghidEventTap)
up.post(tap: .cghidEventTap)
let end = Date().addingTimeInterval(2)
while board.changeCount == before && Date() < end { Thread.sleep(forTimeInterval: 0.03) }
guard board.changeCount != before else { fail("未检测到本次复制更新，请选中文字，并确认目标应用允许复制") }
guard let text = board.string(forType: .string) else { fail("本次复制内容不是纯文本") }
try send(["before": before, "after": board.changeCount, "text": text])
