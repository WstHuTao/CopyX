import { useEffect, useRef, useState } from "react";
import { unwrap, type Scheme, type ShortcutSettings } from "./desktop";
const api = window.desktop;
export function ShortcutInput({
  scheme,
  schemes,
  aiShortcut,
  sharedAI = false,
  disabled = false,
  onChange,
  notify,
}: {
  scheme: ShortcutSettings & { id: string };
  schemes: Scheme[];
  aiShortcut?: ShortcutSettings;
  sharedAI?: boolean;
  disabled?: boolean;
  onChange: (patch: Partial<ShortcutSettings>) => void;
  notify: (message: string, isError?: boolean) => void;
}) {
  const platform = api?.platform || "darwin";
  const field = platform === "win32" ? "shortcutWin" : "shortcutMac";
  const value = scheme[field];
  const input = useRef<HTMLInputElement>(null),
    recording = useRef(false),
    mounted = useRef(true);
  const [checking, setChecking] = useState(false),
    [result, setResult] = useState<{
      available: boolean;
      message: string;
    } | null>(null);
  useEffect(() => {
    mounted.current = true;
    const blur = () => input.current?.blur();
    window.addEventListener("blur", blur);
    return () => {
      mounted.current = false;
      window.removeEventListener("blur", blur);
      if (recording.current) void api?.endShortcutRecording();
    };
  }, []);
  useEffect(() => {
    let stale = false;
    if (!api || !value || !scheme.enabled) {
      setResult(null);
      setChecking(false);
      return;
    }
    setResult(null);
    setChecking(true);
    const timer = setTimeout(() => {
      void unwrap(
        api.checkShortcut({
          schemeId: scheme.id,
          key: value,
          schemes,
          aiShortcut,
          sharedAI,
        }),
      )
        .then((answer) => {
          if (!stale) setResult(answer);
        })
        .catch((error) => {
          if (!stale) setResult({ available: false, message: error.message });
        })
        .finally(() => {
          if (!stale) setChecking(false);
        });
    }, 180);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [value, scheme.id, scheme.enabled, schemes, aiShortcut, sharedAI]);
  async function start() {
    if (!api) return;
    try {
      await unwrap(api.beginShortcutRecording());
      if (mounted.current && document.activeElement === input.current)
        recording.current = true;
      else await api.endShortcutRecording();
    } catch (error) {
      notify((error as Error).message, true);
      input.current?.blur();
    }
  }
  async function end() {
    recording.current = false;
    if (!api) return;
    try {
      await unwrap(api.endShortcutRecording());
    } catch (error) {
      notify((error as Error).message, true);
    }
  }
  function capture(event: React.KeyboardEvent<HTMLInputElement>) {
    if (
      event.key === "Tab" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      input.current?.blur();
      return;
    }
    if (
      !recording.current ||
      ["Meta", "Control", "Alt", "Shift"].includes(event.key)
    )
      return;
    if (event.key === "Backspace" || event.key === "Delete") {
      onChange({ [field]: "" });
      return;
    }
    const modifiers = [
      event.metaKey ? (platform === "darwin" ? "Command" : "Super") : "",
      event.ctrlKey ? "Control" : "",
      event.altKey ? "Alt" : "",
      event.shiftKey ? "Shift" : "",
    ].filter(Boolean);
    if (!modifiers.some((m) => m !== "Shift")) {
      setResult({
        available: false,
        message: "请搭配 Command、Control、Alt 或 Windows 键",
      });
      return;
    }
    const codes: Record<string, string> = {
      Space: "Space",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Escape: "Escape",
      Semicolon: ";",
      Quote: "'",
      Comma: ",",
      Period: ".",
      Slash: "/",
      Backslash: "\\",
      BracketLeft: "[",
      BracketRight: "]",
      Backquote: "`",
      Minus: "-",
      Equal: "=",
    };
    const key = /^Key[A-Z]$/.test(event.code)
      ? event.code.slice(3)
      : /^Digit[0-9]$/.test(event.code)
        ? event.code.slice(5)
        : codes[event.code] || event.key;
    onChange({ [field]: [...modifiers, key].join("+") });
  }
  return (
    <div className="shortcut-settings">
      <div className="shortcut-row">
        <label className="shortcut-field">
          快捷键
          <input
            ref={input}
            aria-describedby="shortcut-feedback"
            placeholder="点击后按下组合键，删除键清空"
            value={value}
            disabled={disabled}
            onFocus={() => void start()}
            onBlur={() => void end()}
            onKeyDown={capture}
            onChange={() => {}}
            aria-invalid={scheme.enabled && result?.available === false}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={scheme.enabled}
            disabled={disabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          启用全局快捷键
        </label>
      </div>
      <p
        id="shortcut-feedback"
        className={
          "shortcut-feedback " +
          (result?.available === false ? "conflict" : result ? "available" : "")
        }
        role="status"
      >
        {!scheme.enabled
          ? "全局快捷键已关闭，仍可在工作台手动执行。"
          : checking
            ? "正在检查快捷键…"
            : result?.message ||
              (!value
                ? "未设置快捷键时不会触发，仍可在工作台手动执行。"
                : "保存设置后生效。")}
      </p>
      <p className="help shortcut-explanation">
        {sharedAI
          ? "所有 AI 提示词命令共用此键位。按下后使用最近一次成功执行的提示词。"
          : "开启后，可在其他应用中按快捷键获取选中文字。"}
      </p>
    </div>
  );
}
