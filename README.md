<p align="center">
  <img src="assets/copyx-brand.png" width="96" height="96" alt="CopyX 蓝紫色小熊图标">
</p>

<h1 align="center">CopyX</h1>

<p align="center"><strong>复制一下，熊有办法。</strong></p>

CopyX 是一个桌面纯文本处理工具。在其他应用里选中文字，按下自定义快捷键，用 JavaScript 或 AI 提示词整理文本。左边看原文，右边看差异、改结果，确认后再复制。

**适用平台** · macOS 14+（Apple Silicon） · Windows 10/11（x64）

[快速上手](#快速上手) · [用模型生成脚本](#用模型生成脚本) · [从源码构建](#从源码构建)

## CopyX 能做什么

| 你想做的事 | CopyX 怎么帮你 |
| --- | --- |
| 反复清理同一种文本 | 把规则保存为 JavaScript 脚本，在本地执行，为不同脚本配置专用快捷键。 |
| 临时换个格式或语气 | 用 AI 提示词处理文本。所有 AI 指令共用一个快捷键，默认复用最近一次成功使用的提示词。常用提示词可以收藏。 |
| 看清楚改了什么 | 左右对照高亮差异，结果可以直接编辑。原文和结果各有复制按钮。 |
| 把规则分享给同事 | 导出 `.copyx.json`，对方可以导入为草稿。脚本可附带测试用例。 |

## 快速上手

1. 在「自定义处理」新建 JavaScript 或 AI 提示词指令，录入快捷键并保存。录入并保存即可在其他应用中使用。要只在工作台手动执行，清空键位后保存。
2. 在其他应用里选中文字，按下并松开配置好的快捷键。macOS 首次使用时，在「系统设置 → 隐私与安全性 → 辅助功能」开启 CopyX，再回工作台点「权限检查」。
3. 检查差异，按需要编辑右侧结果，然后复制到目标应用。也可以在工作台手动输入文本或载入样例试用。

例如，要去掉文本首尾的空白，可以把这段脚本保存为处理草稿：

```javascript
function transform(text) {
  return text.trim();
}
```

在「测试集」添加用例，比如输入 `  你好  `，预期输出 `你好`。运行测试，全部通过后点击「启用此版本」。脚本接收一个字符串并返回一个字符串，运行环境与文件、网络和系统隔离。

已测试并启用的 JavaScript 指令，可在「编辑设置」开启「处理后直接复制」并保存。从其他应用选中文字并按专用快捷键，CopyX 会在后台处理并把结果放入剪贴板。随后可以在任意位置按系统粘贴快捷键。处理失败时会显示错误，剪贴板已变化或写入失败时可在核对页复制结果。

## 用模型生成脚本

1. 在「模型设置」填写服务地址、API Key 和模型名称，并测试连接。支持 OpenAI 兼容的 Chat Completions 接口，可填服务商的版本路径（如 `/v1`）或完整请求地址。
2. 在当前处理的「测试集」添加至少 1 条用例，再点击「使用模型生成脚本」。CopyX 会先测试当前脚本，把已有代码和用例的输入、预期输出及实际结果作为讨论上下文。
3. 先让模型提出方案，可以继续补充要求。确认方案后再生成脚本，CopyX 会自动跑测试并展示结果。将生成的代码应用到草稿，测试通过后再启用。

对话保存在本机，重启后可继续。用例按字符比较，空格、换行和空字符串也参与比较。

## 数据与权限

- **AI 请求** · 执行 AI 提示词会把选中文字和提示词发送到你配置的模型服务。回复格式不符合约定时，会自动重试一次，两次共用 60 秒等待上限。生成脚本会发送当前代码、测试上下文和相关对话。
- **本机存储** · API Key 加密保存在本机配置中，加密密钥单独存放。测试用例、提示词历史和脚本对话保存在本机。
- **分享范围** · 分享文件包含处理名称、脚本或初始提示词，以及你选择附带的测试用例。模型配置和 API Key 留在原设备。
- **macOS 辅助功能** · 若系统开关已开启但「权限检查」仍显示未授权，可移除旧条目并重新添加「应用程序」里的 CopyX。使用临时签名的版本更新后，可能需要重新授权。

## 检查更新

发现新版本时，侧边栏的 CopyX 名称旁会显示红色 `NEW`。点击它可查看更新说明，也可通过 macOS 的 CopyX 应用菜单或两端的托盘菜单手动检查。下载并验签后，再确认安装。安装前请保存草稿和需要保留的处理结果。0.2.2 及更早版本需要手动安装一次支持更新的版本。

## 从源码构建

需要 Node.js 22.12+ 和 Rust stable。macOS 需要 Xcode 命令行工具，Windows 需要 x64 MSVC 构建工具及 Windows SDK。

```sh
npm ci
```

| 构建平台 | 命令 |
| --- | --- |
| macOS Apple Silicon | `npm run package:tauri:mac` |
| Windows x64 | `npm run package:tauri:win` |

安装包输出到 `src-tauri/target/<目标平台>/release/bundle/`。Windows 缺少 WebView2 时，安装器会尝试联网补装。

运行 `npm test` 执行单元测试，运行 `npm run build` 检查 TypeScript 并构建前端。桌面回归可运行 `npm run test:desktop` 和 `npm run test:script-tests`。更多实现细节见[架构设计](docs/架构设计.md)、[需求说明](docs/需求说明.md)和 [Tauri 迁移设计](docs/tauri-迁移设计.md)。

### 发布更新

发布更新时，在仓库外保管签名私钥，通过 `TAURI_SIGNING_PRIVATE_KEY` 提供文件路径，并在两端的打包命令后加上 `-- --config '{"bundle":{"createUpdaterArtifacts":true}}'`。需要密码时使用 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。将 macOS 更新归档与 Windows 安装程序分别命名为 `CopyX-<版本>-macos-arm64.app.tar.gz` 和 `CopyX-<版本>-windows-x64-setup.exe`，各自的签名文件加同名 `.sig` 后缀。运行 `node scripts/prepare-update.mjs <发布目录> [更新说明文件]` 后，把两个包与 `latest.json` 一起发布到同一个 `v<版本>` 的 GitHub Release。macOS 用户首次安装仍使用普通 DMG。

## 作者与许可证

作者为 Ivan。项目采用 [Apache License 2.0](LICENSE)。
