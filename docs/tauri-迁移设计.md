# CopyX Tauri 与 Rust 迁移设计

用户已选择 Tauri 加 Rust。目标是减少下载安装体积，复用 React、Monaco 和既有 `Desktop` 接口。发布目标为 macOS 14+ Apple Silicon、Windows 10/11 x64。Tauri 版独立构建和验证，Electron 版保留为对照与回退。

## 结构

前端通过独立 Tauri 适配器调用受限命令。Rust 接管窗口、托盘、快捷键、剪贴板、原生文件选择和请求互斥。保留现有 Swift 与 PowerShell 取文辅助程序，先在源应用完成取文，再展示对照窗口。Tauri 包由系统 WebView 渲染，不包含 Node 或 Chromium。Windows 安装包默认在缺失 WebView2 时联网补装。

Rust 核心按配置与凭据、脚本与测试、模型与对话、分享格式分模块。模型请求和 API Key 只在后台。QuickJS 每次创建独立运行环境，沿用 32 MB 内存、512 KB 栈、2 秒单例、15 秒整套测试，提供取消。脚本运行环境不开放文件、网络和系统接口。生成代码沿用 Acorn 的静态校验契约，运行仍依赖接收端测试通过后生效。

## 兼容与交付

沿用 `config.json`、`master.key`、`script-conversations.json` 和 `.copyx.json` 的数据格式。首次启动将旧版数据复制到 Tauri 自己的目录，整体提交后才使用。缺失、损坏或并发写入需要明确处理，避免静默覆盖旧数据。现有方案标识、AES-256-GCM 密文布局和 AAD、测试指纹、AI 共享快捷键、提示词历史与收藏规则继续兼容。测试使用合成数据和本地模型服务，实际发布前分别记录 Mac 和 Windows 的构建及实机验收状态。

优先验证带原界面的 Mac ARM64 预览包，记录和 0.1.13 的实测差异。原版应用及真实权限配置在验证期继续独立。打包及安装使用系统支持的签名与授权流程。
