#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod contract;
mod conversation;
mod desktop;
mod native;
mod script;
mod share;
mod shortcuts;
mod store;
mod updates;

use desktop::{notice, open, Desktop};
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{App, AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

struct StartupError(String);

fn local(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None)
    )
}

#[cfg(target_os = "macos")]
fn show_about(window: &WebviewWindow) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    let app = window.app_handle();
    app.dialog()
        .message(format!(
            "版本 {}\n作者 {}",
            app.package_info().version,
            env!("CARGO_PKG_AUTHORS")
        ))
        .title("关于 CopyX")
        .parent(window)
        .buttons(MessageDialogButtons::OkCustom("确定".into()))
        .show(|_| {});
}

#[tauri::command]
async fn desktop(window: WebviewWindow, command: String, input: Value) -> contract::Result<Value> {
    if window.label() != "main" || !window.url().is_ok_and(|url| local(&url)) {
        return Err("当前窗口无权执行桌面命令".into());
    }
    #[cfg(feature = "smoke-test")]
    if command == "smoke:finish" && std::env::var_os("TEXT_WORKBENCH_TEST_DIR").is_some() {
        println!("COPYX_SMOKE_RESULT {input}");
        window.app_handle().exit(0);
        return Ok(Value::Null);
    }
    match command.as_str() {
        "update:available" => {
            let version = updates::available_version(window.app_handle()).await?;
            return Ok(serde_json::json!(version));
        }
        "update:open" => {
            updates::start(window.app_handle());
            return Ok(Value::Null);
        }
        _ => {}
    }
    let state = window.try_state::<Desktop>().ok_or_else(|| {
        window.try_state::<StartupError>().map_or_else(
            || "CopyX 桌面服务尚未启动".to_string(),
            |error| error.0.clone(),
        )
    })?;
    state.call(&window, &command, input).await
}

fn tray(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "open", "打开 CopyX", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "tray-update", "检查更新…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 CopyX", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &update, &quit])?;
    let mut builder = TrayIconBuilder::new()
        .tooltip("CopyX")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => open(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                open(tray.app_handle());
            }
        });
    #[cfg(target_os = "macos")]
    {
        let icon = app.path().resource_dir()?.join("trayTemplate.png");
        builder = builder
            .icon(tauri::image::Image::from_path(icon)?)
            .icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn edit_menu(app: &App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    let about = MenuItem::with_id(app, "app-about", "关于 CopyX", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "app-update", "检查更新…", true, None::<&str>)?;
    let application = SubmenuBuilder::new(app, "CopyX")
        .item(&about)
        .item(&update)
        .separator()
        .quit_with_text("退出 CopyX")
        .build()?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .undo_with_text("撤销")
        .redo_with_text("重做")
        .separator()
        .cut_with_text("剪切")
        .copy_with_text("复制")
        .paste_with_text("粘贴")
        .select_all_with_text("全选")
        .build()?;
    app.set_menu(
        MenuBuilder::new(app)
            .items(&[&application, &edit])
            .build()?,
    )?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "app-about" {
            if let Some(window) = app.get_webview_window("main") {
                open(app);
                show_about(&window);
            }
        }
    });
    Ok(())
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    match Desktop::load(app.handle()) {
        Ok(state) => {
            app.manage(state);
        }
        Err(error) => {
            app.manage(StartupError(error));
        }
    }
    #[cfg(target_os = "macos")]
    edit_menu(app)?;
    let window = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
        .on_navigation(local)
        .on_new_window(|_, _| NewWindowResponse::Deny);
    #[cfg(feature = "smoke-test")]
    let window = window.on_page_load(|window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished
            && std::env::var_os("TEXT_WORKBENCH_TEST_DIR").is_some()
        {
            let _ = window.eval(include_str!("../../scripts/tauri-smoke-webview.js"));
        }
    });
    window.build()?;
    tray(app)?;
    Ok(())
}

fn window_event(window: &tauri::Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if let Some(state) = window.try_state::<Desktop>() {
                state.cancel_all();
            }
            api.prevent_close();
            let _ = window.hide();
        }
        WindowEvent::Focused(false) => {
            let app = window.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(state) = app.try_state::<Desktop>() {
                    if let Err(error) = state.resume(&app).await {
                        notice(&app, error);
                    }
                }
            });
        }
        _ => {}
    }
}

fn run_event(_app: &AppHandle, _event: tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen { .. } = _event {
        open(_app);
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--script-worker") {
        script::worker_main();
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| open(app)))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(|current, release| {
                    release.version.pre.is_empty() && release.version > current
                })
                .build(),
        )
        .manage(updates::Updates::default())
        .on_menu_event(|app, event| {
            if matches!(event.id().as_ref(), "tray-update" | "app-update") {
                updates::start(app);
            }
        })
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Released {
                        let app = app.clone();
                        let id = shortcut.id();
                        tauri::async_runtime::spawn(async move {
                            if let Some(state) = app.try_state::<Desktop>() {
                                state.capture(&app, id).await;
                            }
                        });
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![desktop])
        .setup(setup)
        .on_window_event(window_event)
        .build(tauri::generate_context!())
        .expect("无法启动 CopyX")
        .run(run_event);
}
