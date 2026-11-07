use crate::{
    contract::Result,
    desktop::{notice, open, Desktop},
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

const RELEASE_ORIGIN: &str = "github.com";
const RELEASE_PATH: &str = "/WstHuTao/CopyX/releases/download";

#[derive(Default)]
pub struct Updates(tokio::sync::Mutex<()>);

fn status(window: &WebviewWindow, message: &str) {
    let _ = window.emit("copyx-update-status", message);
}

async fn dialog(window: &WebviewWindow, text: String, action: Option<&str>) -> bool {
    let buttons = match action {
        Some(action) => MessageDialogButtons::OkCancelCustom(action.into(), "取消".into()),
        None => MessageDialogButtons::OkCustom("确定".into()),
    };
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .message(text)
        .title("CopyX 软件更新")
        .parent(window)
        .buttons(buttons)
        .show(move |confirmed| {
            let _ = send.send(confirmed);
        });
    receive.await.unwrap_or(false)
}

fn trusted_download(url: &Url, version: &str, asset: &str) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(RELEASE_ORIGIN)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == format!("{RELEASE_PATH}/v{version}/{asset}")
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let updates = app.state::<Updates>();
        let Ok(_update_guard) = updates.0.try_lock() else {
            return;
        };
        open(&app);
        if let Err(error) = check(&app, &window).await {
            notice(&app, error.clone());
            dialog(&window, error, None).await;
        }
    });
}

async fn available_update(app: &AppHandle) -> Result<Option<Update>> {
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| "无法启动更新检查")?;
    let update = tokio::time::timeout(Duration::from_secs(15), updater.check())
        .await
        .map_err(|_| "检查更新超时，请检查网络后重试")?
        .map_err(|error| match error {
            Error::ReleaseNotFound => "GitHub 暂无可读取的更新清单，请稍后再试",
            _ => "无法读取 GitHub 更新信息，请检查网络后重试",
        })?;
    if let Some(update) = &update {
        let version = &update.version;
        let asset = if cfg!(target_os = "macos") {
            format!("CopyX-{version}-macos-arm64.app.tar.gz")
        } else {
            format!("CopyX-{version}-windows-x64-setup.exe")
        };
        if !trusted_download(&update.download_url, version, &asset) {
            return Err("更新包地址与 CopyX 官方发布不一致".into());
        }
    }
    Ok(update)
}

pub async fn available_version(app: &AppHandle) -> Result<Option<String>> {
    Ok(available_update(app).await?.map(|update| update.version))
}

async fn check(app: &AppHandle, window: &WebviewWindow) -> Result<()> {
    status(window, "正在检查更新…");
    let update = available_update(app).await?;
    let Some(update) = update else {
        let message = format!("CopyX {} 已是最新版本。", app.package_info().version);
        status(window, &message);
        dialog(window, message, None).await;
        return Ok(());
    };
    let version = &update.version;
    let mut message = format!("当前版本 {}\n可用版本 {version}", update.current_version);
    if let Some(notes) = update
        .body
        .as_deref()
        .filter(|notes| !notes.trim().is_empty())
    {
        let notes: String = notes
            .chars()
            .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
            .take(1000)
            .collect();
        message.push_str(&format!("\n\n{notes}"));
    }
    status(window, &format!("发现新版本 {version}"));
    if !dialog(window, message, Some("下载更新")).await {
        status(window, "已取消更新");
        return Ok(());
    }

    status(window, "正在下载更新…");
    let mut received = 0_u64;
    let mut shown_percent = 0;
    let bytes = update
        .download(
            |chunk, total| {
                received = received.saturating_add(chunk as u64);
                if let Some(total) = total.filter(|total| *total > 0) {
                    let percent = received.saturating_mul(100).saturating_div(total).min(100);
                    if percent >= shown_percent + 5 {
                        shown_percent = percent;
                        status(window, &format!("正在下载更新… {percent}%"));
                    }
                }
            },
            || status(window, "正在验证更新签名…"),
        )
        .await
        .map_err(|_| "下载更新或签名验证失败，安装已停止")?;

    let desktop = app.try_state::<Desktop>();
    let _install_guard = desktop
        .as_ref()
        .map(|state| state.try_update_install())
        .transpose()?;
    status(window, "下载完成，签名验证通过");
    if !dialog(
        window,
        format!("CopyX {version} 已下载并通过签名验证。安装时会退出应用。请确认草稿和需要保留的处理结果已保存。"),
        Some("安装更新"),
    ).await {
        status(window, "已取消更新");
        return Ok(());
    }
    status(window, "正在安装更新…");
    tokio::task::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|_| "更新安装程序异常退出")?
        .map_err(|_| "无法安装更新，请检查安装目录权限或手动安装")?;
    #[cfg(target_os = "macos")]
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 更新包只能来自本项目对应版本的发布附件() {
        let name = "CopyX-0.2.3-windows-x64-setup.exe";
        let valid = format!("https://github.com{RELEASE_PATH}/v0.2.3/{name}");
        assert!(trusted_download(
            &Url::parse(&valid).unwrap(),
            "0.2.3",
            name
        ));
        for candidate in [
            valid.replace("https:", "http:"),
            valid.replace("github.com", "example.invalid"),
            valid.replace("/CopyX/", "/Other/"),
            valid.replace("/v0.2.3/", "/v0.2.2/"),
            format!("{valid}?token=1"),
        ] {
            assert!(!trusted_download(
                &Url::parse(&candidate).unwrap(),
                "0.2.3",
                name
            ));
        }
    }
}
