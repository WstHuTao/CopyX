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

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success
        ? value : nil
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return (value as! AXUIElement)
}

struct Selection {
    let window: AXUIElement
    let field: AXUIElement
    let contents: String
    let text: String
    let range: CFRange
    let singleLine: Bool

    init?(_ pid: pid_t) {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        guard let window = elementAttribute(app, kAXFocusedWindowAttribute),
              let field = elementAttribute(app, kAXFocusedUIElementAttribute),
              let role = attribute(field, kAXRoleAttribute) as? String,
              [kAXTextFieldRole, kAXTextAreaRole].contains(role),
              (attribute(field, kAXSubroleAttribute) as? String) != kAXSecureTextFieldSubrole,
              let contents = attribute(field, kAXValueAttribute) as? String,
              contents.utf8.count <= 1024 * 1024,
              let text = attribute(field, kAXSelectedTextAttribute) as? String, !text.isEmpty,
              let value = attribute(field, kAXSelectedTextRangeAttribute),
              CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        var range = CFRange()
        var writable = DarwinBoolean(false)
        guard AXValueGetValue(value as! AXValue, .cfRange, &range), range.length > 0,
              range.location >= 0, range.location <= contents.utf16.count,
              range.length <= contents.utf16.count - range.location,
              (contents as NSString).substring(with: NSRange(location: range.location, length: range.length)).utf8.elementsEqual(text.utf8),
              AXUIElementIsAttributeSettable(field, kAXSelectedTextAttribute as CFString, &writable) == .success,
              writable.boolValue
        else { return nil }
        self.window = window
        self.field = field
        self.contents = contents
        self.text = text
        self.range = range
        self.singleLine = role == kAXTextFieldRole
    }

    func matches(_ current: Selection) -> Bool {
        CFEqual(window, current.window) && CFEqual(field, current.field)
            && range.location == current.range.location && range.length == current.range.length
            && contents.utf8.elementsEqual(current.contents.utf8)
            && text.utf8.elementsEqual(current.text.utf8)
    }
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
let origin = mode == "--direct" ? NSWorkspace.shared.frontmostApplication?.processIdentifier : nil
let selection = origin.flatMap(Selection.init)
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
if mode == "--direct", NSWorkspace.shared.frontmostApplication?.processIdentifier != origin {
    fail("取文期间已切换应用，请重新选中文字")
}
let canReplace = selection?.text.utf8.elementsEqual(text.utf8) == true
try send(["before": before, "after": board.changeCount, "text": text, "direct": canReplace])
if mode == "--direct", canReplace, let origin, let selection,
   let line = readLine(), let data = line.data(using: .utf8),
   let replacement = try? JSONDecoder().decode([String: String].self, from: data),
   let result = replacement["text"] {
    // 始终对原控件发起定向替换，避免把结果发送给后来获得焦点的其他应用。
    let matched = NSWorkspace.shared.frontmostApplication?.processIdentifier == origin
        && Selection(origin).map(selection.matches) == true
        && NSWorkspace.shared.frontmostApplication?.processIdentifier == origin
    var pasted = matched && text.utf8.elementsEqual(result.utf8)
    if matched && !pasted && !(selection.singleLine && result.rangeOfCharacter(from: .newlines) != nil),
       NSWorkspace.shared.frontmostApplication?.processIdentifier == origin,
       AXUIElementSetAttributeValue(selection.field, kAXSelectedTextAttribute as CFString, result as CFString) == .success {
        let range = NSRange(location: selection.range.location, length: selection.range.length)
        let expected = (selection.contents as NSString).replacingCharacters(in: range, with: result)
        pasted = (attribute(selection.field, kAXValueAttribute) as? String)?.utf8.elementsEqual(expected.utf8) == true
    }
    try send(["pasted": pasted])
}
