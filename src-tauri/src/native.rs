use crate::contract::*;
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{io::AsyncReadExt, process::Command};

const CAPTURE_JSON_LIMIT: usize = 6 * MB + 4 * KB;

#[cfg(target_os = "macos")]
fn mac_capture_command(app: &AppHandle) -> Result<Command> {
    let dir = app.path().resource_dir().map_err(|_| "无法定位取文程序")?;
    Ok(Command::new(dir.join("capture-mac")))
}

fn capture_command(app: &AppHandle) -> Result<Command> {
    #[cfg(target_os = "macos")]
    let command = mac_capture_command(app)?;
    #[cfg(windows)]
    let command = {
        let dir = app.path().resource_dir().map_err(|_| "无法定位取文程序")?;
        let shell = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .map(|root| root.join("System32/WindowsPowerShell/v1.0/powershell.exe"))
            .unwrap_or_else(|| "powershell.exe".into());
        let mut command = Command::new(shell);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-STA",
                "-File",
            ])
            .arg(dir.join("capture.ps1"));
        command.creation_flags(0x08000000);
        command
    };
    Ok(command)
}

pub async fn capture(app: &AppHandle) -> Result<String> {
    let mut child = capture_command(app)?
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "无法启动取文程序")?;
    let stdout = child.stdout.take().ok_or("无法接收取文结果")?;
    let (bytes, status) = tokio::time::timeout(Duration::from_secs(6), async {
        // JSON 转义最多占用每个字符六字节，同时限制异常输出的内存占用。
        let mut bytes = Vec::new();
        stdout
            .take((CAPTURE_JSON_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "无法接收取文结果")?;
        if bytes.len() > CAPTURE_JSON_LIMIT {
            return Err("选中文字超过 1 MB，请分段处理");
        }
        let status = child.wait().await.map_err(|_| "系统复制未完成")?;
        Ok((bytes, status))
    })
    .await
    .map_err(|_| "获取选文超时，请松开快捷键后再试")??;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "获取选文失败，请检查系统权限并确认目标应用支持复制")?;
    if let Some(message) = value["error"].as_str() {
        return Err(message.into());
    }
    if !status.success() {
        return Err("系统复制未完成".into());
    }
    capture_text(&value)
}

fn capture_text(value: &Value) -> Result<String> {
    if let Some(message) = value["error"].as_str() {
        return Err(message.into());
    }
    let before = value["before"]
        .as_u64()
        .or_else(|| value["before"].as_i64().map(|n| n as u64));
    let after = value["after"]
        .as_u64()
        .or_else(|| value["after"].as_i64().map(|n| n as u64));
    if before.is_none() || after.is_none() || before == after {
        return Err("未检测到本次复制更新，请先选中文字后再试".into());
    }
    let text = value["text"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("本次复制没有可处理的纯文本")?;
    if text.len() > MB {
        return Err("选中文字超过 1 MB，请分段处理".into());
    }
    Ok(text.into())
}

#[cfg(windows)]
pub async fn check_permission(_app: &AppHandle) -> Result<bool> {
    Ok(true)
}

#[cfg(target_os = "macos")]
pub async fn check_permission(app: &AppHandle) -> Result<bool> {
    const ERROR: &str = "无法检查辅助功能权限，请确认 CopyX 已完整安装";
    let output = tokio::time::timeout(
        Duration::from_secs(3),
        mac_capture_command(app)?
            .arg("--check-permission")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| ERROR)?
    .map_err(|_| ERROR)?;
    if !output.status.success() {
        return Err(ERROR.into());
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| ERROR)?;
    value["allowed"].as_bool().ok_or_else(|| ERROR.into())
}
