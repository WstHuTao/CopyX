use crate::{contract::*, script};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const CIPHER_PREFIX: &str = "copyx:v1:";
const CONFIG_LIMIT: usize = 512 * MB;
pub const CONVERSATION_LIMIT: usize = 16 * MB;

pub fn read_limited(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > limit as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "文件类型或大小无效",
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "文件过大"));
    }
    Ok(bytes)
}

fn private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "缺少父目录"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map(|_| ()).map_err(|error| error.error)
}

pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法整理本地配置".to_string())?;
    atomic_write(path, &bytes).map_err(|_| "保存失败，请检查本地目录权限和空间".into())
}

pub fn migrate(legacy: &Path, target: &Path) -> Result<()> {
    if target.exists() {
        return Ok(());
    }
    let parent = target.parent().ok_or("本机数据路径不正确")?;
    private_dir(parent).map_err(|_| "无法创建 CopyX 数据目录")?;
    let stage = tempfile::Builder::new()
        .prefix(".copyx-migrate-")
        .tempdir_in(parent)
        .map_err(|_| "无法准备旧版数据迁移")?;
    let files = [
        ("config.json", CONFIG_LIMIT),
        ("master.key", 32),
        ("script-conversations.json", CONVERSATION_LIMIT),
    ];
    let read = |name, limit| {
        if name == "master.key" {
            Vault::new(legacy).read().map(|key| key.to_vec())
        } else {
            read_limited(&legacy.join(name), limit)
        }
    };
    let mut snapshots = Vec::new();
    for (name, limit) in files {
        let bytes = match read(name, limit) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(_) => return Err(format!("无法迁移旧版 {name}，旧数据保持原样")),
        };
        if let Some(bytes) = &bytes {
            atomic_write(&stage.path().join(name), bytes).map_err(|_| "无法保存迁移副本")?;
        }
        snapshots.push((name, limit, bytes));
    }
    for (name, limit, bytes) in snapshots {
        let unchanged = match read(name, limit) {
            Ok(current) => Some(current) == bytes,
            Err(error) => error.kind() == io::ErrorKind::NotFound && bytes.is_none(),
        };
        if !unchanged {
            return Err("旧版数据在迁移期间发生变化，请退出旧版后重试".into());
        }
    }
    // 将完整副本作为一个目录提交，失败时旧目录保持原样。
    fs::rename(stage.path(), target).map_err(|_| "无法完成旧版数据迁移")?;
    Ok(())
}

pub struct Vault(PathBuf);
impl Vault {
    pub fn new(dir: &Path) -> Self {
        Self(dir.join("master.key"))
    }

    fn read(&self) -> io::Result<[u8; 32]> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(&self.0)?;
        let meta = file.metadata()?;
        if !meta.is_file() || meta.len() != 32 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "主密钥格式不正确",
            ));
        }
        let mut bytes = Vec::new();
        file.take(33).read_to_end(&mut bytes)?;
        bytes
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "主密钥格式不正确"))
    }

    fn key(&self, create: bool) -> Result<[u8; 32]> {
        match self.read() {
            Ok(key) => Ok(key),
            Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
                let parent = self.0.parent().ok_or("主密钥路径无效")?;
                private_dir(parent).map_err(|_| "无法创建主密钥目录")?;
                let mut temp =
                    tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建本地主密钥")?;
                let mut key = [0; 32];
                OsRng.fill_bytes(&mut key);
                temp.write_all(&key)
                    .and_then(|_| temp.as_file().sync_all())
                    .map_err(|_| "无法写入本地主密钥")?;
                if let Err(error) = temp.persist_noclobber(&self.0) {
                    if error.error.kind() != io::ErrorKind::AlreadyExists {
                        return Err("无法保存本地主密钥".into());
                    }
                }
                self.read().map_err(|_| "无法读取本地主密钥".into())
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Err("本地主密钥缺失，请恢复备份或重新填写 API Key".into())
            }
            Err(_) => Err("无法读取本地主密钥，请检查文件和访问权限".into()),
        }
    }

    pub fn encrypt(&self, secret: &str, id: &str) -> Result<String> {
        if secret.is_empty() || secret.len() > 16 * KB {
            return Err("API Key 必须为 16 KB 以内的非空文本".into());
        }
        let key = self.key(true)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "主密钥无效")?;
        let mut nonce = [0; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = format!("CopyX/APIKey/v1/{id}");
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: secret.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| "加密 API Key 失败")?;
        let tag_start = encrypted.len() - 16;
        let bytes = [
            nonce.as_slice(),
            &encrypted[tag_start..],
            &encrypted[..tag_start],
        ]
        .concat();
        Ok(format!("{CIPHER_PREFIX}{}", STANDARD.encode(bytes)))
    }

    pub fn decrypt(&self, encrypted: &str, id: &str) -> Result<String> {
        let encoded = encrypted
            .strip_prefix(CIPHER_PREFIX)
            .ok_or("此 API Key 使用旧版系统加密，请在模型设置中重新填写")?;
        if encoded.len() > 24_000 {
            return Err("API Key 密文格式损坏".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "API Key 密文格式损坏")?;
        if bytes.len() < 29 || STANDARD.encode(&bytes) != encoded {
            return Err("API Key 密文格式损坏".into());
        }
        let key = self.key(false)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "主密钥无效")?;
        let aad = format!("CopyX/APIKey/v1/{id}");
        let payload = [&bytes[28..], &bytes[12..28]].concat();
        let text = cipher
            .decrypt(
                Nonce::from_slice(&bytes[..12]),
                Payload {
                    msg: &payload,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| "无法解密 API Key，请恢复备份或重新填写")?;
        String::from_utf8(text).map_err(|_| "API Key 密文格式损坏".into())
    }
}

pub struct Store {
    pub dir: PathBuf,
    pub value: Config,
    vault: Vault,
}

fn initial_config() -> Config {
    let script = "function transform(text) {\n  return text;\n}".to_string();
    Config {
        schema_version: 2,
        ai_shortcut: None,
        models: vec![],
        prompt_history: vec![],
        schemes: vec![Scheme {
            disabled: false,
            direct_paste: false,
            id: "clean".into(),
            name: "文本清理".into(),
            kind: Kind::Script,
            script: script.clone(),
            prompt: String::new(),
            model_id: None,
            test_cases: vec![],
            shortcut: ShortcutSettings {
                enabled: true,
                shortcut_mac: "Command+Shift+1".into(),
                shortcut_win: "Control+Alt+1".into(),
            },
            active_script: Some(legacy_active(script)),
        }],
    }
}

fn legacy_active(script: String) -> ActiveScript {
    ActiveScript {
        script,
        status: "legacy".into(),
        test_cases: vec![],
        fingerprint: None,
        tested_at: None,
        count: None,
    }
}

pub fn validate_prompt(text: &str) -> Result<()> {
    if text.trim().is_empty() {
        return Err("请填写提示词".into());
    }
    if text.len() > 4 * MB {
        return Err("提示词超过 4 MB，请缩短后再试".into());
    }
    Ok(())
}

pub fn validate_history(entries: &[PromptEntry]) -> Result<()> {
    let (mut ids, mut prompts) = (HashSet::new(), HashSet::new());
    if entries.len() > 500 {
        return Err("提示词历史最多保留 500 条".into());
    }
    for entry in entries {
        if entry.id.is_empty()
            || !ids.insert(&entry.id)
            || !prompts.insert(&entry.prompt)
            || entry.last_run.scheme_id.is_empty()
            || entry.last_run.model_id.is_empty()
        {
            return Err("提示词历史格式不正确".into());
        }
        validate_prompt(&entry.prompt)?;
        validate_prompt(&entry.last_run.prompt)?;
    }
    if serde_json::to_vec(entries)
        .map_err(|_| "提示词历史格式不正确")?
        .len()
        > 8 * MB
    {
        return Err("提示词历史超过 8 MB，请删除不再使用的记录".into());
    }
    Ok(())
}

fn legacy_shortcut(schemes: &[Scheme]) -> ShortcutSettings {
    let active = schemes
        .iter()
        .any(|s| s.kind == Kind::Ai && s.shortcut.enabled);
    let ai = || {
        schemes
            .iter()
            .filter(|s| s.kind == Kind::Ai && (!active || s.shortcut.enabled))
    };
    ShortcutSettings {
        enabled: active,
        shortcut_mac: ai()
            .find(|s| !s.shortcut.shortcut_mac.trim().is_empty())
            .map(|s| s.shortcut.shortcut_mac.clone())
            .unwrap_or_default(),
        shortcut_win: ai()
            .find(|s| !s.shortcut.shortcut_win.trim().is_empty())
            .map(|s| s.shortcut.shortcut_win.clone())
            .unwrap_or_default(),
    }
}

fn validate_config(config: &Config) -> Result<()> {
    if config.schemes.len() > 100 || config.models.len() > 50 {
        return Err("方案或模型配置数量超过限制".into());
    }
    let mut ids = HashSet::new();
    for model in &config.models {
        if model.id.is_empty()
            || !ids.insert(&model.id)
            || model.name.trim().is_empty()
            || model.model.trim().is_empty()
        {
            return Err("模型标识或名称不正确".into());
        }
        crate::ai::endpoint(&model.base_url)?;
    }
    ids.clear();
    for scheme in &config.schemes {
        if scheme.id.is_empty() || !ids.insert(&scheme.id) || scheme.name.trim().is_empty() {
            return Err("处理标识或名称不正确".into());
        }
        let legacy = scheme
            .active_script
            .as_ref()
            .is_some_and(|a| a.status == "legacy" && a.script == scheme.script);
        if !legacy {
            script::validate_source(&scheme.script)?;
        }
        script::validate_cases(&scheme.test_cases)?;
        if scheme.kind == Kind::Ai
            && scheme
                .model_id
                .as_ref()
                .is_some_and(|id| !id.is_empty() && !config.models.iter().any(|m| m.id == *id))
        {
            return Err("AI 处理引用的模型不存在，请先添加模型".into());
        }
        if let Some(active) = &scheme.active_script {
            script::active_source(active)?;
        }
    }
    validate_history(&config.prompt_history)
}

impl Store {
    pub fn load(dir: PathBuf) -> Result<Self> {
        private_dir(&dir).map_err(|_| "无法打开本地数据目录")?;
        let mut value: Config = match read_limited(&dir.join("config.json"), CONFIG_LIMIT) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "配置读取失败，原文件保持原样")?
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => initial_config(),
            Err(_) => return Err("配置读取失败，原文件保持原样".into()),
        };
        if value.schema_version != 2 {
            value.schema_version = 2;
            for scheme in &mut value.schemes {
                scheme.test_cases.clear();
                scheme.active_script =
                    (scheme.kind == Kind::Script).then(|| legacy_active(scheme.script.clone()));
            }
        }
        value
            .ai_shortcut
            .get_or_insert_with(|| legacy_shortcut(&value.schemes));
        validate_config(&value)?;
        for model in &mut value.models {
            model.api_key = None;
            model.clear_key = false;
        }
        Ok(Self {
            vault: Vault::new(&dir),
            dir,
            value,
        })
    }

    pub fn public(&self) -> Value {
        let mut public = json!(&self.value);
        for (item, model) in public["models"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .zip(&self.value.models)
        {
            if let Some(obj) = item.as_object_mut() {
                obj.remove("encryptedKey");
                let key = model.encrypted_key.as_deref().filter(|s| !s.is_empty());
                obj.insert("hasKey".into(), json!(key.is_some()));
                obj.insert(
                    "needsKeyUpdate".into(),
                    json!(key.is_some_and(|s| !s.starts_with(CIPHER_PREFIX))),
                );
            }
        }
        public
    }

    pub fn prepare(&self, mut next: Config) -> Result<Config> {
        next.schema_version = 2;
        next.prompt_history = self.value.prompt_history.clone();
        if next.ai_shortcut.is_none() {
            next.ai_shortcut = self.value.ai_shortcut.clone();
        }
        for scheme in &mut next.schemes {
            scheme.active_script = self
                .value
                .schemes
                .iter()
                .find(|s| s.id == scheme.id)
                .and_then(|s| s.active_script.clone());
            scheme.direct_paste &= scheme.kind == Kind::Script
                && scheme
                    .active_script
                    .as_ref()
                    .is_some_and(|s| s.status == "verified");
        }
        validate_config(&next)?;
        for model in &mut next.models {
            model.encrypted_key = self
                .value
                .models
                .iter()
                .find(|m| m.id == model.id)
                .and_then(|m| m.encrypted_key.clone());
            if let Some(key) = model.api_key.take().filter(|s| !s.is_empty()) {
                model.encrypted_key = Some(self.vault.encrypt(&key, &model.id)?);
            }
            if model.clear_key {
                model.encrypted_key = None;
            }
            model.clear_key = false;
        }
        Ok(next)
    }

    pub fn persist(&mut self, next: Config) -> Result<()> {
        write_json(&self.dir.join("config.json"), &next)?;
        self.value = next;
        Ok(())
    }

    pub fn get_model(&self, id: &str) -> Result<Model> {
        let mut model = self
            .value
            .models
            .iter()
            .find(|m| m.id == id)
            .cloned()
            .ok_or("请先配置模型")?;
        let encrypted = model
            .encrypted_key
            .as_deref()
            .ok_or("请先为模型保存 API Key")?;
        model.api_key = Some(self.vault.decrypt(encrypted, id)?);
        Ok(model)
    }
}

pub fn record_prompt(entries: &mut Vec<PromptEntry>, run: PromptRun, replay: Option<&str>) {
    let previous = entries
        .iter()
        .position(|item| replay.map_or(item.prompt == run.prompt, |id| item.id == id))
        .map(|i| entries.remove(i));
    let mut item = previous.unwrap_or_else(|| PromptEntry {
        id: Uuid::new_v4().to_string(),
        prompt: run.prompt.clone(),
        favorite: false,
        last_run: run.clone(),
    });
    item.last_run = run;
    entries.insert(0, item);
}

pub fn latest_target(config: &Config) -> (Option<&PromptEntry>, Option<&Scheme>) {
    let latest = config.prompt_history.first();
    let scheme = latest.and_then(|entry| {
        config.schemes.iter().find(|s| {
            !s.disabled
                && s.kind == Kind::Ai
                && s.id == entry.last_run.scheme_id
                && s.model_id.as_deref() == Some(entry.last_run.model_id.as_str())
        })
    });
    (latest, scheme)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 旧版密文及模型绑定兼容() {
        let temp = tempfile::tempdir().unwrap();
        let vault = Vault::new(temp.path());
        fs::write(temp.path().join("master.key"), [11; 32]).unwrap();
        let previous =
            "copyx:v1:BwcHBwcHBwcHBwcHVITHoabKDiqhG3hZ6O0nnjsNjzmOh8nItRmi9z3TJ9zCKUB4VqUL/w==";
        assert_eq!(
            vault.decrypt(previous, "model-test").unwrap(),
            "仅用于互操作测试"
        );
        assert!(vault.decrypt(previous, "wrong").is_err());
        let encrypted = vault.encrypt("新测试密钥", "m").unwrap();
        assert_eq!(vault.decrypt(&encrypted, "m").unwrap(), "新测试密钥");
    }

    #[test]
    fn 迁移副本独立且不覆盖新配置() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("legacy");
        let next = temp.path().join("next");
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("config.json"), b"{}").unwrap();
        migrate(&legacy, &next).unwrap();
        assert_eq!(fs::read(next.join("config.json")).unwrap(), b"{}");
        fs::write(legacy.join("config.json"), b"null").unwrap();
        migrate(&legacy, &next).unwrap();
        assert_eq!(fs::read(next.join("config.json")).unwrap(), b"{}");
    }
}
