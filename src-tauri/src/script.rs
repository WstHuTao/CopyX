use crate::contract::*;
use rquickjs::{Context, Ctx, Runtime, Value};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Read, Write},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
#[cfg(not(test))]
use {
    std::process::Stdio,
    tokio::{io::AsyncWriteExt, process::Command},
};

const CASE_TIMEOUT: Duration = Duration::from_secs(2);
const SUITE_TIMEOUT: Duration = Duration::from_secs(15);
const ACORN: &str = include_str!("../../node_modules/acorn/dist/acorn.js");
const VALIDATOR: &str = include_str!("script-validator.js");

#[derive(Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum WorkerInput {
    Run { text: String, source: String },
    Normalize { source: String },
}

pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn fingerprint(source: &str, cases: &[TestCase]) -> String {
    // 字段顺序与旧版 JSON.stringify 契约一致，旧脚本快照可直接复验。
    let bytes =
        serde_json::to_vec(&serde_json::json!({"version": 1, "script": source, "cases": cases}))
            .expect("无法序列化测试指纹");
    sha256(&bytes)
}

pub fn validate_source(source: &str) -> Result<()> {
    if source.len() > 64 * KB {
        return Err("脚本必须是 64 KB 以内的文本".into());
    }
    Ok(())
}

pub fn validate_cases(cases: &[TestCase]) -> Result<()> {
    if cases.len() > 50 {
        return Err("测试集最多支持 50 条用例".into());
    }
    let mut ids = HashSet::new();
    let mut size = 0;
    for c in cases {
        if c.id.is_empty() || c.id.encode_utf16().count() > 80 || !ids.insert(&c.id) {
            return Err("测试用例标识为空、过长或重复".into());
        }
        if c.name.trim().is_empty() || c.name.encode_utf16().count() > 128 {
            return Err("请填写 128 字以内的用例名称".into());
        }
        if c.input.len() > 64 * KB || c.expected.len() > 64 * KB {
            return Err("每个测试输入或预期结果必须是 64 KB 以内的文本".into());
        }
        size += c.input.len() + c.expected.len();
    }
    if size > 512 * KB {
        return Err("测试集文本总量不能超过 512 KB".into());
    }
    Ok(())
}

pub fn active_source(active: &ActiveScript) -> Result<&str> {
    validate_cases(&active.test_cases)?;
    match active.status.as_str() {
        "legacy" => Ok(&active.script),
        "verified"
            if !active.test_cases.is_empty()
                && active.fingerprint.as_deref()
                    == Some(fingerprint(&active.script, &active.test_cases).as_str()) =>
        {
            validate_source(&active.script)?;
            Ok(&active.script)
        }
        _ => Err("生效脚本的测试记录不一致，请重新测试并生效".into()),
    }
}

fn js_error(ctx: &Ctx<'_>, deadline: Instant) -> String {
    if Instant::now() >= deadline {
        return "脚本执行超时，请检查循环或输入大小".into();
    }
    let value = ctx.catch();
    let error = value
        .as_exception()
        .and_then(|e| e.message())
        .unwrap_or_else(|| "脚本执行失败，请检查代码".into());
    truncate(error, 4 * KB)
}

fn truncate(mut text: String, max: usize) -> String {
    if text.len() > max {
        let mut index = max;
        while !text.is_char_boundary(index) {
            index -= 1;
        }
        text.truncate(index);
    }
    text
}

fn evaluate(input: WorkerInput) -> Result<String> {
    let runtime = Runtime::new().map_err(|_| "脚本运行环境异常")?;
    runtime.set_memory_limit(32 * MB);
    runtime.set_max_stack_size(512 * KB);
    let deadline = Instant::now() + CASE_TIMEOUT;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(|_| "无法初始化脚本运行环境")?;
    context.with(|ctx| {
        let result: Value<'_> = match input {
            WorkerInput::Run { text, source } => {
                let text = serde_json::to_string(&text).map_err(|_| "原文编码不正确")?;
                let program = format!("\"use strict\";\n{source}\n;transform({text})");
                ctx.eval(program).map_err(|_| js_error(&ctx, deadline))?
            }
            WorkerInput::Normalize { source } => {
                validate_source(&source)?;
                ctx.eval::<(), _>(ACORN)
                    .map_err(|_| "无法初始化脚本静态检查")?;
                ctx.globals()
                    .set("candidate", source)
                    .map_err(|_| "无法读取生成脚本")?;
                ctx.eval(VALIDATOR).map_err(|_| js_error(&ctx, deadline))?
            }
        };
        let output = result
            .as_string()
            .ok_or("脚本必须返回字符串")?
            .to_string()
            .map_err(|_| "脚本返回的文本编码不正确")?;
        if output.len() > 2 * MB {
            return Err("处理结果超过 2 MB，请分段处理".into());
        }
        Ok(output)
    })
}

pub fn worker_main() {
    let mut bytes = Vec::new();
    let answer = if std::io::stdin()
        .take((80 * MB + 1) as u64)
        .read_to_end(&mut bytes)
        .is_ok()
        && bytes.len() <= 80 * MB
    {
        serde_json::from_slice::<WorkerInput>(&bytes)
            .map_err(|_| "脚本输入格式不正确".to_string())
            .and_then(evaluate)
    } else {
        Err("脚本输入超过限制".into())
    };
    let _ = serde_json::to_writer(std::io::stdout().lock(), &answer);
    let _ = std::io::stdout().flush();
}

#[cfg(not(test))]
async fn isolated(input: WorkerInput, cancel: &CancellationToken) -> Result<String> {
    let bytes = serde_json::to_vec(&input).map_err(|_| "脚本输入格式不正确")?;
    if bytes.len() > 80 * MB {
        return Err("脚本输入超过限制".into());
    }
    let exe = std::env::current_exe().map_err(|_| "无法定位脚本子进程")?;
    let mut command = Command::new(exe);
    command
        .arg("--script-worker")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| "无法启动脚本子进程")?;
    let mut stdin = child.stdin.take().ok_or("无法发送脚本")?;
    let job = async {
        stdin.write_all(&bytes).await.map_err(|_| "无法发送脚本")?;
        drop(stdin);
        let output = child
            .wait_with_output()
            .await
            .map_err(|_| "脚本运行环境异常")?;
        if !output.status.success() {
            return Err("脚本执行意外结束".into());
        }
        serde_json::from_slice::<Result<String>>(&output.stdout)
            .map_err(|_| "脚本返回格式不正确")?
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("处理已取消".into()),
        r = tokio::time::timeout(CASE_TIMEOUT + Duration::from_millis(1500), job) => r.map_err(|_| "脚本执行超时，请检查循环或输入大小")?,
    }
}

#[cfg(test)]
async fn isolated(input: WorkerInput, cancel: &CancellationToken) -> Result<String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("处理已取消".into()),
        result = tokio::task::spawn_blocking(move || evaluate(input)) => result.map_err(|_| "脚本运行环境异常")?,
    }
}

pub async fn run(text: &str, source: &str, cancel: &CancellationToken) -> Result<String> {
    isolated(
        WorkerInput::Run {
            text: text.into(),
            source: source.into(),
        },
        cancel,
    )
    .await
}

pub async fn normalize(source: &str, cancel: &CancellationToken) -> Result<String> {
    isolated(
        WorkerInput::Normalize {
            source: source.into(),
        },
        cancel,
    )
    .await
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseResult {
    pub id: String,
    pub passed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub fingerprint: String,
    pub passed: bool,
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub results: Vec<CaseResult>,
}

pub async fn test(source: &str, cases: &[TestCase], cancel: &CancellationToken) -> Result<Report> {
    validate_source(source)?;
    validate_cases(cases)?;
    let mut report = Report {
        fingerprint: fingerprint(source, cases),
        passed: false,
        total: cases.len(),
        message: None,
        results: vec![],
    };
    if cases.is_empty() {
        report.message = Some("至少添加 1 条测试用例，全部通过后才能生效".into());
        return Ok(report);
    }
    let deadline = tokio::time::Instant::now() + SUITE_TIMEOUT;
    for c in cases {
        let start = Instant::now();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("测试已取消".into()),
            _ = tokio::time::sleep_until(deadline) => {
                report.message = Some("测试集执行超时，生成或编辑的脚本可保留为草稿，请优化后重新测试".into());
                return Ok(report);
            },
            result = run(&c.input, source, cancel) => result,
        };
        let mut line = CaseResult {
            id: c.id.clone(),
            passed: false,
            actual: None,
            error: None,
            elapsed_ms: start.elapsed().as_millis() as u64,
        };
        match result {
            Ok(output) if output.len() > 64 * KB => {
                line.error = Some("测试输出超过 64 KB，未返回过长内容".into())
            }
            Ok(output) => {
                line.passed = output == c.expected;
                line.actual = Some(output);
            }
            Err(e) => line.error = Some(e),
        }
        report.results.push(line);
    }
    if cancel.is_cancelled() {
        return Err("测试已取消".into());
    }
    report.passed = report.results.iter().all(|r| r.passed);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn 旧版测试指纹及纯文本兼容() {
        let source = "function transform(text) { return text; }";
        let cases = vec![TestCase {
            id: "one".into(),
            name: "空白与 Unicode".into(),
            input: "甲\t乙\r\n😀".into(),
            expected: "甲\t乙\r\n😀".into(),
        }];
        let report = test(source, &cases, &CancellationToken::new())
            .await
            .unwrap();
        assert!(report.passed);
        assert_eq!(
            report.fingerprint,
            "84fc5baebd4d2d3d5e987326c5bbee2ff7f2dd7b38e021e329c97418a30ce1e7"
        );
    }
    #[tokio::test]
    async fn 脚本宿主隔离且代码静态检查不执行顶层() {
        let token = CancellationToken::new();
        assert_eq!(run("", "function transform(){return [typeof process,typeof require,typeof fetch,typeof document].join(',')}", &token).await.unwrap(), "undefined,undefined,undefined,undefined");
        assert!(normalize(
            "throw new Error('不可执行'); function transform(text){ return text; }",
            &token
        )
        .await
        .is_ok());
        assert!(
            normalize("async function transform(text){return text}", &token)
                .await
                .is_err()
        );
        assert!(run("", "function transform(){return 1}", &token)
            .await
            .is_err());
    }
    #[test]
    fn 死循环在时限内被中断() {
        let start = Instant::now();
        let result = evaluate(WorkerInput::Run {
            text: String::new(),
            source: "function transform(){while(true){}}".into(),
        });
        assert!(result.unwrap_err().contains("超时"));
        assert!(start.elapsed() < Duration::from_secs(4));
    }
}
