use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;
pub const KB: usize = 1024;
pub const MB: usize = 1024 * KB;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCase {
    pub id: String,
    pub name: String,
    pub input: String,
    pub expected: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    pub enabled: bool,
    pub shortcut_mac: String,
    pub shortcut_win: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Script,
    Ai,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveScript {
    pub script: String,
    #[serde(default)]
    pub test_cases: Vec<TestCase>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tested_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scheme {
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub direct_paste: bool,
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub script: String,
    pub prompt: String,
    #[serde(flatten)]
    pub shortcut: ShortcutSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default)]
    pub test_cases: Vec<TestCase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_script: Option<ActiveScript>,
}

impl Scheme {
    pub fn ensure_enabled(&self) -> Result<()> {
        if self.disabled {
            return Err("此自定义指令已禁用，请在自定义处理中启用并保存".into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypted_key: Option<String>,
    #[serde(skip_serializing)]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing)]
    pub clear_key: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRun {
    pub prompt: String,
    pub scheme_id: String,
    pub model_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEntry {
    pub id: String,
    pub prompt: String,
    pub favorite: bool,
    pub last_run: PromptRun,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub schema_version: u32,
    pub schemes: Vec<Scheme>,
    pub models: Vec<Model>,
    pub ai_shortcut: Option<ShortcutSettings>,
    #[serde(default)]
    pub prompt_history: Vec<PromptEntry>,
}

pub fn string<'a>(value: &'a serde_json::Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| "请求字段格式不正确".into())
}

pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .expect("无法生成记录时间")
}
