use crate::{
    ai::Ai,
    contract::*,
    conversation::{self, Repository},
    native, script, share, shortcuts,
    store::{self, Store},
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskKind {
    Process,
    ScriptTest,
    Conversation,
}

struct Request {
    kind: TaskKind,
    id: Option<String>,
    cancel: CancellationToken,
    finishing: bool,
}

#[derive(Default)]
struct Requests {
    active: Option<Request>,
    early_cancellations: VecDeque<(TaskKind, String, Instant)>,
}

struct Task<'a> {
    requests: &'a Mutex<Requests>,
    cancel: CancellationToken,
}
impl Task<'_> {
    fn complete(&self) -> Result<()> {
        let mut current = lock(self.requests)?;
        if self.cancel.is_cancelled() {
            return Err("处理已取消".into());
        }
        if let Some(request) = current.active.as_mut() {
            request.finishing = true;
        }
        Ok(())
    }
}
impl Drop for Task<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.requests.lock() {
            state.active = None;
        }
    }
}

pub struct Desktop {
    store: Mutex<Store>,
    conversations: Mutex<Repository>,
    shortcuts: Mutex<shortcuts::State>,
    proofs: Mutex<HashMap<String, String>>,
    operation: tokio::sync::Mutex<()>,
    initial_shortcuts: tokio::sync::OnceCell<Result<()>>,
    requests: Mutex<Requests>,
    ai: Ai,
}

fn lock<T>(state: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    state
        .lock()
        .map_err(|_| "本机状态异常，请重启 CopyX".into())
}

fn decode<T: DeserializeOwned>(input: Value) -> Result<T> {
    serde_json::from_value(input).map_err(|_| "请求字段格式不正确".into())
}

fn identifier(input: &Value, field: &str) -> Result<String> {
    let value = string(input, field)?;
    if value.is_empty() || value.encode_utf16().count() > 80 {
        return Err("处理或请求标识不正确".into());
    }
    Ok(value.into())
}

fn request_id(input: &Value) -> Result<String> {
    let id = identifier(input, "requestId")?;
    if !valid_request_id(&id) {
        return Err("请求标识不正确".into());
    }
    Ok(id)
}

fn valid_request_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn notice(app: &AppHandle, message: String) {
    let _ = app.emit_to("main", "copyx-notice", message);
}

impl Desktop {
    pub fn try_update_install(&self) -> Result<tokio::sync::MutexGuard<'_, ()>> {
        self.operation
            .try_lock()
            .map_err(|_| "请等待当前处理完成，再检查更新".into())
    }

    pub fn load(app: &AppHandle) -> Result<Self> {
        let dir = match std::env::var_os("TEXT_WORKBENCH_TEST_DIR") {
            Some(dir) => PathBuf::from(dir),
            None => {
                let dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|_| "无法定位 CopyX 数据目录")?
                    .join("data");
                let legacy = app
                    .path()
                    .data_dir()
                    .map_err(|_| "无法定位旧版 CopyX 数据目录")?
                    .join("文本工坊");
                store::migrate(&legacy, &dir)?;
                dir
            }
        };
        Ok(Self {
            store: Mutex::new(Store::load(dir.clone())?),
            conversations: Mutex::new(Repository::load(&dir)),
            shortcuts: Mutex::default(),
            proofs: Mutex::default(),
            operation: tokio::sync::Mutex::new(()),
            initial_shortcuts: tokio::sync::OnceCell::new(),
            requests: Mutex::default(),
            ai: Ai::new()?,
        })
    }

    async fn register(&self, app: &AppHandle) -> Result<()> {
        let _gate = self.operation.lock().await;
        let config = lock(&self.store)?.value.clone();
        lock(&self.shortcuts)?.apply(app, &config)
    }

    pub async fn resume(&self, app: &AppHandle) -> Result<()> {
        let _gate = self.operation.lock().await;
        let config = lock(&self.store)?.value.clone();
        lock(&self.shortcuts)?.resume(app, &config)
    }

    fn begin(&self, kind: TaskKind, id: Option<String>) -> Result<Task<'_>> {
        let mut requests = lock(&self.requests)?;
        let pending = &mut requests.early_cancellations;
        pending.retain(|(_, _, since)| since.elapsed() < Duration::from_secs(5));
        if let Some(index) = pending
            .iter()
            .position(|(k, key, _)| *k == kind && id.as_deref() == Some(key))
        {
            pending.remove(index);
            return Err("处理已取消".into());
        }
        let cancel = CancellationToken::new();
        requests.active = Some(Request {
            kind,
            id,
            cancel: cancel.clone(),
            finishing: false,
        });
        Ok(Task {
            requests: &self.requests,
            cancel,
        })
    }

    fn cancel(&self, kind: Option<TaskKind>, id: Option<&str>) -> Result<()> {
        let mut requests = lock(&self.requests)?;
        let active = requests.active.as_ref().filter(|request| {
            kind.is_none_or(|kind| kind == request.kind)
                && id.is_none_or(|id| request.id.as_deref() == Some(id))
        });
        if let Some(request) = active {
            if !request.finishing {
                request.cancel.cancel();
            }
        } else if let (Some(kind), Some(id)) = (kind, id.filter(|id| valid_request_id(id))) {
            // 取消请求可能先于处理请求被调度，按请求标识短暂保留。
            let pending = &mut requests.early_cancellations;
            pending.push_back((kind, id.into(), Instant::now()));
            if pending.len() > 32 {
                pending.pop_front();
            }
        }
        Ok(())
    }

    pub fn cancel_all(&self) {
        let _ = self.cancel(None, None);
    }

    fn persist_config(&self, app: &AppHandle, store: &mut Store, next: Config) -> Result<Value> {
        let mut shortcuts = lock(&self.shortcuts)?;
        shortcuts.apply(app, &next)?;
        if let Err(error) = store.persist(next) {
            let _ = shortcuts.apply(app, &store.value);
            return Err(error);
        }
        Ok(store.public())
    }

    pub async fn capture(&self, app: &AppHandle, key: u32) {
        let Ok(gate) = self.operation.try_lock() else {
            notice(app, "已有任务正在执行，请完成或取消后再试".into());
            return;
        };
        let target = lock(&self.shortcuts)
            .ok()
            .and_then(|state| state.target(key));
        let Some(target) = target else {
            return;
        };
        let result = match self.capture_payload(target) {
            Ok((payload, Some(source))) => self.capture_and_paste(app, payload, &source).await,
            Ok((mut payload, None)) => native::capture(app).await.map(|text| {
                payload["text"] = json!(text);
                Some(payload)
            }),
            Err(error) => Err(error),
        };
        if matches!(&result, Ok(None)) {
            return;
        }
        // 取文及直接粘贴结束后再打开核对窗口。
        open(app);
        drop(gate);
        match result {
            Ok(Some(payload)) => {
                let _ = app.emit_to("main", "copyx-capture", payload);
            }
            Ok(None) => {}
            Err(error) => notice(app, error),
        }
    }

    async fn capture_and_paste(
        &self,
        app: &AppHandle,
        mut payload: Value,
        source: &str,
    ) -> Result<Option<Value>> {
        let (text, session) = native::capture_direct(app).await?;
        let outcome: Result<Option<String>> = async {
            let task = self.begin(TaskKind::Process, None)?;
            let result = script::run(&text, source, &task.cancel).await?;
            if result.len() > 2 * MB {
                return Err("处理结果超过 2 MB，请分段处理".into());
            }
            task.complete()?;
            if let Some(session) = session {
                if session.replace(&result).await {
                    return Ok(None);
                }
            }
            Ok(Some(result))
        }
        .await;
        let prepared = match outcome {
            Ok(None) => return Ok(None),
            Ok(Some(result)) => json!({
                "result":result,"notice":"无法确认已粘贴，请核对原应用与处理结果。"
            }),
            Err(error) => json!({"error":error}),
        };
        payload["text"] = json!(text);
        payload["prepared"] = prepared;
        Ok(Some(payload))
    }

    fn capture_payload(&self, target: shortcuts::Target) -> Result<(Value, Option<String>)> {
        let store = lock(&self.store)?;
        if target.shared {
            let (entry, latest) = store::latest_target(&store.value);
            if let (Some(entry), Some(scheme)) = (entry, latest) {
                return Ok((
                    json!({"schemeId":scheme.id,"prompt":entry.last_run.prompt,"latestPromptId":entry.id}),
                    None,
                ));
            }
            let scheme = store
                .value
                .schemes
                .iter()
                .find(|s| {
                    !s.disabled
                        && s.kind == Kind::Ai
                        && s.model_id.as_ref().is_some_and(|s| !s.is_empty())
                })
                .ok_or("请先配置 AI 提示词命令")?;
            return Ok((
                json!({"schemeId":scheme.id,"prompt":entry.map(|e|e.last_run.prompt.as_str()).unwrap_or(&scheme.prompt),
                "promptNotice":if entry.is_some(){"上次使用的 AI 处理已禁用或配置已变更，请先在工作台成功执行一次"}else{"请先在工作台成功执行一次提示词，之后可用快捷键直接处理"}}),
                None,
            ));
        }
        let scheme = store
            .value
            .schemes
            .iter()
            .find(|s| s.id == target.id)
            .ok_or("自定义处理已变更")?;
        scheme.ensure_enabled()?;
        let active = scheme.active_script.as_ref().ok_or("请先测试并生效脚本")?;
        let source = script::active_source(active)?;
        let direct =
            (scheme.direct_paste && active.status == "verified").then(|| source.to_owned());
        Ok((json!({"schemeId":target.id}), direct))
    }

    pub async fn call(&self, window: &WebviewWindow, command: &str, input: Value) -> Result<Value> {
        let app = window.app_handle();
        match command {
            "config:get" => {
                let registration = self
                    .initial_shortcuts
                    .get_or_init(|| self.register(app))
                    .await;
                let mut config = lock(&self.store)?.public();
                if let Err(warning) = registration {
                    config["startupWarning"] = json!(warning);
                }
                return Ok(config);
            }
            "clipboard:write" => {
                let text = input
                    .as_str()
                    .filter(|s| s.len() <= 2 * MB)
                    .ok_or("复制内容无效或超过 2 MB")?;
                app.clipboard()
                    .write_text(text)
                    .map_err(|_| "无法写入剪贴板")?;
                return Ok(Value::Null);
            }
            "permission:request" => return Ok(json!(native::check_permission(app).await?)),
            "dialog:confirm" => {
                let message = input
                    .as_str()
                    .filter(|message| !message.is_empty() && message.len() <= 4 * KB)
                    .ok_or("确认提示格式不正确")?;
                let dialog = app
                    .dialog()
                    .message(message)
                    .title("CopyX")
                    .parent(window)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "确定".into(),
                        "取消".into(),
                    ));
                let confirmed =
                    tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
                        .await
                        .map_err(|_| "确认窗口未完成")?;
                return Ok(json!(confirmed));
            }
            "script:conversation-get" => {
                let id = input
                    .as_str()
                    .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 80)
                    .ok_or("处理标识不正确")?;
                let repo = lock(&self.conversations)?;
                return Ok(
                    json!({"conversation":repo.get(id)?.as_ref().map(|r| r.view()),"storageWarning":repo.warning()}),
                );
            }
            "process:cancel" => {
                self.cancel(Some(TaskKind::Process), input.as_str())?;
                return Ok(Value::Null);
            }
            "script:test-cancel" | "script:generate-cancel" => {
                if let Some(id) = input.as_str() {
                    let kind = if command == "script:test-cancel" {
                        TaskKind::ScriptTest
                    } else {
                        TaskKind::Conversation
                    };
                    self.cancel(Some(kind), Some(id))?;
                }
                return Ok(Value::Null);
            }
            _ => {}
        }
        let _gate = self
            .operation
            .try_lock()
            .map_err(|_| "已有任务正在执行，请完成或取消后再试")?;
        match command {
            "shortcut:check" => lock(&self.shortcuts)?.check(app, decode(input)?),
            "shortcut:record-start" => {
                lock(&self.shortcuts)?.suspend(app)?;
                Ok(Value::Null)
            }
            "shortcut:record-end" => {
                let config = lock(&self.store)?.value.clone();
                lock(&self.shortcuts)?.resume(app, &config)?;
                Ok(Value::Null)
            }
            "config:save" => {
                let mut store = lock(&self.store)?;
                let next = store.prepare(decode(input)?)?;
                self.persist_config(app, &mut store, next)
            }
            "scheme:export" | "scheme:import" => {
                let win = window.clone();
                let app = app.clone();
                let export = command == "scheme:export";
                tauri::async_runtime::spawn_blocking(move || {
                    if export {
                        share::export(&app, &win, input)
                    } else {
                        share::import(&app, &win)
                    }
                })
                .await
                .map_err(|_| "文件操作未完成")?
            }
            "process:run" | "process:run-prompt" => {
                self.process(input, command == "process:run-prompt").await
            }
            "prompt-history:update" => self.update_history(input),
            "script:test" => {
                let task = self.begin(TaskKind::ScriptTest, Some(request_id(&input)?))?;
                let scheme = identifier(&input, "schemeId")?;
                let source = string(&input, "script")?;
                let cases = cases(&input)?;
                lock(&self.proofs)?.remove(&scheme);
                let report = script::test(source, &cases, &task.cancel).await?;
                task.complete()?;
                self.remember_proof(&scheme, &report)?;
                Ok(json!(report))
            }
            "script:activate" => self.activate(app, input),
            "script:discuss" | "script:generate" => {
                self.converse(input, command == "script:generate").await
            }
            "model:test" => {
                let id = input.as_str().ok_or("模型标识不正确")?;
                let model = lock(&self.store)?.get_model(id)?;
                let task = self.begin(TaskKind::Process, None)?;
                self.ai
                    .complete(
                        "请回复：连接成功",
                        "只输出简短文本。",
                        &model,
                        Duration::from_secs(15),
                        &task.cancel,
                    )
                    .await?;
                task.complete()?;
                Ok(json!("连接成功"))
            }
            _ => Err("不支持的桌面请求".into()),
        }
    }

    async fn process(&self, input: Value, prompt_only: bool) -> Result<Value> {
        let task = self.begin(TaskKind::Process, Some(request_id(&input)?))?;
        let text = string(&input, "text")?;
        if text.len() > MB {
            return Err("输入必须是 1 MB 以内的文本".into());
        }
        let scheme_id = string(&input, "schemeId")?;
        let replay = input.get("latestPromptId").and_then(Value::as_str);
        let (scheme, prompt, model) = {
            let store = lock(&self.store)?;
            let scheme = store
                .value
                .schemes
                .iter()
                .find(|s| s.id == scheme_id)
                .cloned()
                .ok_or("请先保存自定义处理")?;
            scheme.ensure_enabled()?;
            if prompt_only && scheme.kind != Kind::Ai {
                return Err("请选择 AI 提示词命令".into());
            }
            let prompt = if let Some(replay) = replay {
                let (entry, latest) = store::latest_target(&store.value);
                if let (Some(entry), Some(latest)) = (entry, latest) {
                    if latest.id != scheme_id || entry.id != replay {
                        return Err("最近使用的提示词已变更，请重新按快捷键".into());
                    }
                    entry.last_run.prompt.clone()
                } else {
                    return Err("最近使用的提示词已变更，请重新按快捷键".into());
                }
            } else {
                input["prompt"]
                    .as_str()
                    .unwrap_or(&scheme.prompt)
                    .to_owned()
            };
            let model = if scheme.kind == Kind::Ai {
                let id = scheme
                    .model_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .ok_or("请先在自定义处理中选择模型配置")?;
                store::validate_prompt(&prompt)?;
                Some(store.get_model(id)?)
            } else {
                None
            };
            (scheme, prompt, model)
        };
        let result = if let Some(model) = &model {
            self.ai
                .transform(text, &prompt, model, Duration::from_secs(60), &task.cancel)
                .await?
        } else {
            script::run(
                text,
                script::active_source(
                    scheme
                        .active_script
                        .as_ref()
                        .ok_or("此处理尚未生效，请在自定义处理中添加测试并全部通过后生效")?,
                )?,
                &task.cancel,
            )
            .await?
        };
        if result.len() > 2 * MB {
            return Err("处理结果超过 2 MB，请分段处理".into());
        }
        task.complete()?;
        if let Some(model) = model {
            let mut store = lock(&self.store)?;
            let mut next = store.value.clone();
            store::record_prompt(
                &mut next.prompt_history,
                PromptRun {
                    prompt,
                    scheme_id: scheme.id,
                    model_id: model.id,
                },
                replay,
            );
            let saved =
                store::validate_history(&next.prompt_history).and_then(|_| store.persist(next));
            if prompt_only {
                let mut output = json!({"text":result,"history":store.value.prompt_history});
                if saved.is_err() {
                    output["historyWarning"] =
                        json!("处理完成，但提示词历史保存失败。请检查磁盘空间或清理历史后重试。");
                }
                return Ok(output);
            }
        }
        Ok(json!(result))
    }

    fn update_history(&self, input: Value) -> Result<Value> {
        let mut store = lock(&self.store)?;
        let mut next = store.value.clone();
        let id = identifier(&input, "id")?;
        let items = &mut next.prompt_history;
        let index = items
            .iter()
            .position(|item| item.id == id)
            .ok_or("该提示词已不存在，请刷新历史后再试")?;
        match string(&input, "action")? {
            "delete" => {
                items.remove(index);
            }
            "edit" => {
                let prompt = string(&input, "prompt")?;
                store::validate_prompt(prompt)?;
                if items
                    .iter()
                    .enumerate()
                    .any(|(other, item)| other != index && item.prompt == prompt)
                {
                    return Err("历史中已存在相同的提示词".into());
                }
                items[index].prompt = prompt.into();
            }
            "favorite" => {
                items[index].favorite = input["favorite"].as_bool().ok_or("提示词历史操作不正确")?
            }
            _ => return Err("提示词历史操作不正确".into()),
        }
        store::validate_history(items)?;
        store.persist(next)?;
        Ok(json!(store.value.prompt_history))
    }

    fn remember_proof(&self, scheme: &str, report: &script::Report) -> Result<()> {
        let mut proofs = lock(&self.proofs)?;
        if report.passed {
            proofs.insert(scheme.into(), report.fingerprint.clone());
            if proofs.len() > 200 {
                let oldest = proofs.keys().find(|id| id.as_str() != scheme).cloned();
                if let Some(oldest) = oldest {
                    proofs.remove(&oldest);
                }
            }
        } else {
            proofs.remove(scheme);
        }
        Ok(())
    }

    fn activate(&self, app: &AppHandle, input: Value) -> Result<Value> {
        let id = identifier(&input, "schemeId")?;
        let requested = string(&input, "fingerprint")?;
        let mut store = lock(&self.store)?;
        let mut next = store.value.clone();
        let scheme = next
            .schemes
            .iter_mut()
            .find(|s| s.id == id && s.kind == Kind::Script)
            .ok_or("请先保存 JavaScript 处理草稿")?;
        let current = script::fingerprint(&scheme.script, &scheme.test_cases);
        if scheme.test_cases.is_empty()
            || requested != current
            || lock(&self.proofs)?.get(&id) != Some(&current)
        {
            return Err("当前脚本和测试集尚未全部通过测试，请重新测试".into());
        }
        scheme.active_script = Some(ActiveScript {
            script: scheme.script.clone(),
            test_cases: scheme.test_cases.clone(),
            status: "verified".into(),
            fingerprint: Some(current),
            tested_at: Some(now()),
            count: Some(scheme.test_cases.len()),
        });
        self.persist_config(app, &mut store, next)
    }

    async fn converse(&self, input: Value, generate: bool) -> Result<Value> {
        let task = self.begin(TaskKind::Conversation, Some(request_id(&input)?))?;
        let input: conversation::Input = decode(input)?;
        let scheme = input.scheme_id.clone();
        let model = lock(&self.store)?.get_model(&input.model_id)?;
        let previous = if generate || input.conversation_id.is_some() {
            lock(&self.conversations)?.get(&scheme)?
        } else {
            None
        };
        if generate {
            let (record, outcome) =
                conversation::generate(&self.ai, previous, input, &model, &task.cancel).await?;
            task.complete()?;
            let view = lock(&self.conversations)?.commit(record);
            let generated = outcome?;
            self.remember_proof(&scheme, &generated.report)?;
            Ok(json!({"script":generated.script,"report":generated.report,"conversation":view}))
        } else {
            let record =
                conversation::discuss(&self.ai, previous, input, &model, &task.cancel).await?;
            task.complete()?;
            Ok(lock(&self.conversations)?.commit(record))
        }
    }
}

fn cases(value: &Value) -> Result<Vec<TestCase>> {
    match value.get("testCases") {
        Some(v) => decode(v.clone()),
        None => Ok(vec![]),
    }
}
