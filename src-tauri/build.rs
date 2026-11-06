fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["desktop"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("无法生成 CopyX 桌面权限配置");
}
