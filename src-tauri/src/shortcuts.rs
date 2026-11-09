use crate::contract::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

const MAC: bool = cfg!(target_os = "macos");

#[derive(Clone)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub shared: bool,
}

#[derive(Clone)]
struct Binding {
    hotkey: Shortcut,
    text: String,
    target: Target,
    runnable: bool,
}

#[derive(Default)]
pub struct State {
    active: BTreeMap<u32, Binding>,
    pub suspended: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInput {
    scheme_id: String,
    key: String,
    schemes: Vec<Scheme>,
    ai_shortcut: Option<ShortcutSettings>,
    #[serde(default, alias = "sharedAI")]
    shared_ai: bool,
}

fn normalize(value: &str, mac: bool) -> Result<Option<(String, Shortcut)>> {
    if value.encode_utf16().count() > 160 {
        return Err("快捷键格式不正确".into());
    }
    if value.trim().is_empty() {
        return Ok(None);
    }
    let meta = if mac { "Command" } else { "Super" };
    let modifiers = ["Command", "Control", "Alt", "Shift", "Super"];
    let mut active = Vec::new();
    let mut key = None;
    for part in value.split('+').map(str::trim) {
        let lower = part.to_ascii_lowercase();
        let modifier = match lower.as_str() {
            "command" | "cmd" | "meta" | "super" | "win" => Some(meta),
            "commandorcontrol" | "cmdorctrl" => Some(if mac { "Command" } else { "Control" }),
            "control" | "ctrl" => Some("Control"),
            "alt" | "option" => Some("Alt"),
            "shift" => Some("Shift"),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if active.contains(&modifier) {
                return Err("快捷键包含重复的修饰键".into());
            }
            active.push(modifier);
            continue;
        }
        if key.is_some() || part.is_empty() {
            return Err("快捷键应包含修饰键和一个按键".into());
        }
        let recognized = match lower.as_str() {
            "space" => "Space",
            "tab" => "Tab",
            "escape" | "esc" => "Escape",
            "enter" | "return" => "Enter",
            "backspace" => "Backspace",
            "delete" => "Delete",
            "insert" => "Insert",
            "home" => "Home",
            "end" => "End",
            "pageup" => "PageUp",
            "pagedown" => "PageDown",
            "up" => "Up",
            "down" => "Down",
            "left" => "Left",
            "right" => "Right",
            "plus" => "Plus",
            "-" | "=" | ";" | "'" | "," | "." | "/" | "\\" | "[" | "]" | "`" => part,
            _ if (part.len() == 1 && part.as_bytes()[0].is_ascii_alphanumeric())
                || lower
                    .strip_prefix('f')
                    .and_then(|v| v.parse::<u8>().ok())
                    .is_some_and(|n| (1..=24).contains(&n)) =>
            {
                key = Some(part.to_ascii_uppercase());
                continue;
            }
            _ => return Err("暂不支持此按键，请使用字母、数字或功能键".into()),
        };
        key = Some(recognized.to_owned());
    }
    let key = key
        .filter(|_| active.iter().any(|modifier| *modifier != "Shift"))
        .ok_or("快捷键需要搭配 Command、Control、Alt 或 Windows 键")?;
    let ordered = modifiers
        .into_iter()
        .filter(|m| active.contains(m))
        .collect::<Vec<_>>();
    let text = format!("{}+{key}", ordered.join("+"));
    // 主键盘的加号对应 Shift 与等号的组合。
    let native = if key == "Plus" {
        if active.contains(&"Shift") {
            format!("{}+=", ordered.join("+"))
        } else {
            format!("{}+Shift+=", ordered.join("+"))
        }
    } else {
        text.clone()
    };
    Ok(Some((
        text,
        native.parse().map_err(|_| "系统不支持这个快捷键")?,
    )))
}

fn reserved(key: &str) -> bool {
    let base = if MAC { "Command" } else { "Control" };
    if key
        .strip_prefix(base)
        .and_then(|v| v.strip_prefix('+'))
        .is_some_and(|suffix| matches!(suffix, "C" | "V" | "X" | "A" | "Z" | "Y"))
    {
        return true;
    }
    if MAC {
        matches!(key, "Command+Q" | "Command+Tab" | "Command+Space")
    } else {
        matches!(
            key,
            "Alt+Tab"
                | "Alt+F4"
                | "Super+L"
                | "Super+D"
                | "Super+E"
                | "Super+R"
                | "Control+Alt+Delete"
        )
    }
}

fn from_setting(
    settings: &ShortcutSettings,
    target: Target,
    runnable: bool,
) -> Result<Option<Binding>> {
    if !settings.enabled {
        return Ok(None);
    }
    let value = if MAC {
        &settings.shortcut_mac
    } else {
        &settings.shortcut_win
    };
    Ok(normalize(value, MAC)?.map(|(text, hotkey)| Binding {
        hotkey,
        text,
        target,
        runnable,
    }))
}

fn entries(
    schemes: &[Scheme],
    ai: Option<&ShortcutSettings>,
    for_registration: bool,
) -> Result<Vec<Binding>> {
    let mut out = Vec::new();
    for scheme in schemes
        .iter()
        .filter(|s| !s.disabled && s.kind == Kind::Script)
    {
        if let Some(binding) = from_setting(
            &scheme.shortcut,
            Target {
                id: scheme.id.clone(),
                name: scheme.name.clone(),
                shared: false,
            },
            scheme.active_script.is_some(),
        )? {
            out.push(binding);
        }
    }
    if let Some(ai) = ai.filter(|_| {
        schemes.iter().any(|s| {
            !s.disabled
                && s.kind == Kind::Ai
                && (!for_registration || s.model_id.as_ref().is_some_and(|id| !id.is_empty()))
        })
    }) {
        if let Some(binding) = from_setting(
            ai,
            Target {
                id: "ai-prompt-shortcut".into(),
                name: "AI 提示词命令".into(),
                shared: true,
            },
            true,
        )? {
            out.push(binding);
        }
    }
    Ok(out)
}

impl State {
    pub fn target(&self, id: u32) -> Option<Target> {
        self.active.get(&id).map(|b| b.target.clone())
    }

    pub fn apply(&mut self, app: &AppHandle, config: &Config) -> Result<()> {
        let mut next: BTreeMap<u32, Binding> = BTreeMap::new();
        for binding in entries(&config.schemes, config.ai_shortcut.as_ref(), true)? {
            if reserved(&binding.text) {
                return Err(format!("{} 是常用系统快捷键，请换一个组合", binding.text));
            }
            if let Some(other) = next.get(&binding.hotkey.id()) {
                return Err(format!(
                    "快捷键冲突：「{}」与「{}」使用了 {}",
                    other.target.name, binding.target.name, binding.text
                ));
            }
            next.insert(binding.hotkey.id(), binding);
        }
        if self.suspended {
            return Ok(());
        }
        next.retain(|_, b| b.runnable);
        let manager = app.global_shortcut();
        let mut added = Vec::new();
        for (id, binding) in &next {
            if !self.active.contains_key(id) {
                if manager.is_registered(binding.hotkey)
                    || manager.register(binding.hotkey).is_err()
                {
                    for key in added {
                        let _ = manager.unregister(key);
                    }
                    return Err(format!(
                        "快捷键 {} 无法注册，可能已被系统或其他软件占用",
                        binding.text
                    ));
                }
                added.push(binding.hotkey);
            }
        }
        let mut removed = Vec::new();
        for (id, binding) in &self.active {
            if !next.contains_key(id) {
                if manager.unregister(binding.hotkey).is_err() {
                    for key in added {
                        let _ = manager.unregister(key);
                    }
                    for key in removed {
                        let _ = manager.register(key);
                    }
                    return Err("无法更新快捷键，旧配置已保留".into());
                }
                removed.push(binding.hotkey);
            }
        }
        self.active = next;
        Ok(())
    }

    pub fn suspend(&mut self, app: &AppHandle) -> Result<()> {
        if self.suspended {
            return Ok(());
        }
        let manager = app.global_shortcut();
        let mut removed = Vec::new();
        for binding in self.active.values() {
            if manager.unregister(binding.hotkey).is_err() {
                for key in removed {
                    let _ = manager.register(key);
                }
                return Err("无法暂停快捷键录制，请稍后再试".into());
            }
            removed.push(binding.hotkey);
        }
        self.active.clear();
        self.suspended = true;
        Ok(())
    }

    pub fn resume(&mut self, app: &AppHandle, config: &Config) -> Result<()> {
        if self.suspended {
            self.suspended = false;
            if let Err(error) = self.apply(app, config) {
                self.suspended = true;
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn check(&self, app: &AppHandle, input: CheckInput) -> Result<Value> {
        if input.schemes.len() > 100 {
            return Err("自定义处理列表格式不正确".into());
        }
        let answer =
            |available, message: &str| Ok(json!({"available":available,"message":message}));
        let Some((text, key)) = normalize(&input.key, MAC)? else {
            return answer(true, "尚未设置快捷键");
        };
        if reserved(&text) {
            return answer(false, "这是常用系统快捷键，请换一个组合");
        }
        for item in entries(&input.schemes, input.ai_shortcut.as_ref(), false)? {
            if (item.target.id != input.scheme_id || item.target.shared != input.shared_ai)
                && item.hotkey.id() == key.id()
            {
                return answer(false, &format!("与「{}」的快捷键重复", item.target.name));
            }
        }
        if self.active.contains_key(&key.id()) {
            return answer(true, "未发现注册冲突，保存后生效");
        }
        let manager = app.global_shortcut();
        if manager.is_registered(key) || manager.register(key).is_err() {
            return answer(false, "该快捷键无法注册，可能已被系统或其他软件占用");
        }
        manager.unregister(key).map_err(|_| "无法释放临时快捷键")?;
        answer(true, "未发现注册冲突，保存后生效")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 快捷键检查识别前端发送的共享标识() {
        let shared: CheckInput = serde_json::from_value(json!({
            "schemeId": "ai-prompt-shortcut",
            "key": "Command+Shift+B",
            "schemes": [],
            "sharedAI": true
        }))
        .unwrap();
        assert!(shared.shared_ai);

        let script: CheckInput = serde_json::from_value(json!({
            "schemeId": "script",
            "key": "Command+Shift+B",
            "schemes": []
        }))
        .unwrap();
        assert!(!script.shared_ai);
    }

    #[test]
    fn 禁用指令不占用独立或共享快捷键() {
        let mut scheme: Scheme = serde_json::from_value(serde_json::json!({
            "id":"disabled", "name":"测试", "kind":"script", "script":"", "prompt":"",
            "enabled":true, "shortcutMac":"Command+Shift+F9", "shortcutWin":"Control+Shift+F9"
        }))
        .unwrap();
        assert!(!scheme.disabled);
        assert!(scheme.ensure_enabled().is_ok());
        assert_eq!(entries(&[scheme.clone()], None, false).unwrap().len(), 1);
        scheme.disabled = true;
        assert!(scheme.ensure_enabled().is_err());
        assert!(entries(&[scheme.clone()], None, false).unwrap().is_empty());
        scheme.kind = Kind::Ai;
        let shared = scheme.shortcut.clone();
        assert!(entries(&[scheme.clone()], Some(&shared), false)
            .unwrap()
            .is_empty());
        scheme.disabled = false;
        assert_eq!(entries(&[scheme], Some(&shared), false).unwrap().len(), 1);
    }

    #[test]
    fn 旧版键位别名和主键盘加号兼容() {
        assert_eq!(
            normalize("shift+cmd+c", true).unwrap().unwrap().0,
            "Command+Shift+C"
        );
        assert_eq!(
            normalize("CmdOrCtrl+Shift+k", false).unwrap().unwrap().0,
            "Control+Shift+K"
        );
        assert_eq!(
            normalize("Control+Plus", false).unwrap().unwrap().1.id(),
            normalize("Control+Shift+=", false).unwrap().unwrap().1.id()
        );
        assert!(normalize("Shift+C", true).is_err());
    }
}
