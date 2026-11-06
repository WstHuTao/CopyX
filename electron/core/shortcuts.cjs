const modifiers = ["Command", "Control", "Alt", "Shift", "Super"];
function legacyAIShortcut(schemes) {
  const ai = schemes.filter((scheme) => scheme.kind === "ai");
  const active = ai.filter((scheme) => scheme.enabled);
  const source = active.length ? active : ai;
  return {
    enabled: active.length > 0,
    shortcutMac:
      source.find((scheme) => scheme.shortcutMac.trim())?.shortcutMac || "",
    shortcutWin:
      source.find((scheme) => scheme.shortcutWin.trim())?.shortcutWin || "",
  };
}
function shortcutBindings(config, { requireAIModel = false } = {}) {
  const bindings = config.schemes.filter(
    (scheme) => !scheme.disabled && scheme.kind === "script",
  );
  if (
    config.schemes.some(
      (scheme) =>
        !scheme.disabled &&
        scheme.kind === "ai" &&
        (!requireAIModel || scheme.modelId),
    )
  )
    bindings.push({
      ...(config.aiShortcut ?? legacyAIShortcut(config.schemes)),
      id: "ai-prompt-shortcut",
      name: "AI 提示词命令",
      sharedAI: true,
    });
  return bindings;
}
function normalizeShortcut(value, platform = process.platform) {
  if (typeof value !== "string" || value.length > 160)
    throw new Error("快捷键格式不正确");
  if (!value.trim()) return "";
  const aliases = {
    command: platform === "darwin" ? "Command" : "Super",
    cmd: platform === "darwin" ? "Command" : "Super",
    meta: platform === "darwin" ? "Command" : "Super",
    super: platform === "darwin" ? "Command" : "Super",
    win: platform === "darwin" ? "Command" : "Super",
    control: "Control",
    ctrl: "Control",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    commandorcontrol: platform === "darwin" ? "Command" : "Control",
    cmdorctrl: platform === "darwin" ? "Command" : "Control",
  };
  const keys = {
    space: "Space",
    tab: "Tab",
    escape: "Escape",
    esc: "Escape",
    enter: "Enter",
    return: "Enter",
    backspace: "Backspace",
    delete: "Delete",
    insert: "Insert",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    plus: "Plus",
  };
  const found = new Set();
  let key = "";
  for (const part of value.split("+").map((p) => p.trim())) {
    const lower = part.toLowerCase();
    if (aliases[lower]) {
      if (found.has(aliases[lower])) throw new Error("快捷键包含重复的修饰键");
      found.add(aliases[lower]);
    } else {
      if (key || !part) throw new Error("快捷键应包含修饰键和一个按键");
      if (/^[a-z0-9]$/i.test(part) || /^f([1-9]|1\d|2[0-4])$/i.test(part))
        key = part.toUpperCase();
      else if (keys[lower]) key = keys[lower];
      else if (
        ["-", "=", ";", "'", ",", ".", "/", "\\", "[", "]", "`"].includes(part)
      )
        key = part;
      else throw new Error("暂不支持此按键，请使用字母、数字或功能键");
    }
  }
  if (!key || ![...found].some((m) => m !== "Shift"))
    throw new Error("快捷键需要搭配 Command、Control、Alt 或 Windows 键");
  return [...modifiers.filter((m) => found.has(m)), key].join("+");
}
function systemShortcut(key, platform) {
  const prefix = platform === "darwin" ? "Command" : "Control";
  const reserved = ["C", "V", "X", "A", "Z", "Y"].map((k) => `${prefix}+${k}`);
  if (platform === "darwin")
    reserved.push("Command+Q", "Command+Tab", "Command+Space");
  else
    reserved.push(
      "Alt+Tab",
      "Alt+F4",
      "Super+L",
      "Super+D",
      "Super+E",
      "Super+R",
      "Control+Alt+Delete",
    );
  return reserved.includes(key);
}
class ShortcutManager {
  constructor(api, platform, trigger) {
    this.api = api;
    this.platform = platform;
    this.trigger = trigger;
    this.active = new Map();
    this.schemes = [];
    this.suspended = false;
  }
  keyOf(scheme) {
    return this.platform === "darwin" ? scheme.shortcutMac : scheme.shortcutWin;
  }
  entries(schemes) {
    const entries = new Map();
    for (const scheme of schemes) {
      if (!scheme.enabled) continue;
      const key = normalizeShortcut(this.keyOf(scheme), this.platform);
      if (!key) continue;
      if (systemShortcut(key, this.platform))
        throw new Error(`${key} 是常用系统快捷键，请换一个组合`);
      const other = entries.get(key);
      if (other)
        throw new Error(
          `快捷键冲突：「${other.name}」与「${scheme.name}」使用了 ${key}`,
        );
      entries.set(key, { ...scheme, key });
    }
    return entries;
  }
  apply(schemes) {
    const next = this.entries(schemes);
    if (this.suspended) {
      this.schemes = schemes;
      return;
    }
    const added = [];
    try {
      for (const [key, scheme] of next) {
        if (this.active.has(key)) continue;
        let registered = false;
        try {
          registered =
            !this.api.isRegistered(key) &&
            this.api.register(key, () => {
              const current = this.active.get(key);
              if (current) this.trigger(current.id, current.sharedAI === true);
            });
        } catch {}
        if (!registered)
          throw new Error(`快捷键 ${key} 无法注册，可能已被系统或其他软件占用`);
        added.push(key);
      }
    } catch (error) {
      for (const key of added) this.api.unregister(key);
      throw error;
    }
    for (const key of this.active.keys())
      if (!next.has(key)) this.api.unregister(key);
    this.active = next;
    this.schemes = schemes;
  }
  check({ schemeId, key, schemes, sharedAI = false }) {
    if (!Array.isArray(schemes) || schemes.length > 101)
      throw new Error("自定义处理列表格式不正确");
    const normalized = normalizeShortcut(key, this.platform);
    if (!normalized) return { available: true, message: "尚未设置快捷键" };
    if (systemShortcut(normalized, this.platform))
      return { available: false, message: "这是常用系统快捷键，请换一个组合" };
    const other = schemes.find(
      (s) =>
        (s.id !== schemeId || Boolean(s.sharedAI) !== sharedAI) &&
        s.enabled &&
        normalizeShortcut(this.keyOf(s), this.platform) === normalized,
    );
    if (other)
      return { available: false, message: `与「${other.name}」的快捷键重复` };
    if (this.active.has(normalized))
      return { available: true, message: "未发现注册冲突，保存后生效" };
    if (this.api.isRegistered(normalized))
      return { available: false, message: "该快捷键已被占用，请换一个组合" };
    let registered = false;
    try {
      registered = this.api.register(normalized, () => {});
      return {
        available: registered,
        message: registered
          ? "未发现注册冲突，保存后生效"
          : "该快捷键无法注册，可能已被系统或其他软件占用",
      };
    } catch {
      return {
        available: false,
        message: "快捷键无效或无法注册，请换一个组合",
      };
    } finally {
      if (registered) this.api.unregister(normalized);
    }
  }
  suspend() {
    if (this.suspended) return;
    for (const key of this.active.keys()) this.api.unregister(key);
    this.active = new Map();
    this.suspended = true;
  }
  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.apply(this.schemes);
  }
}
module.exports = {
  normalizeShortcut,
  ShortcutManager,
  legacyAIShortcut,
  shortcutBindings,
};
