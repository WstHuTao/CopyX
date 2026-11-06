const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  clipboard,
  Tray,
  Menu,
  nativeImage,
  dialog,
} = require("electron");
const path = require("node:path");
const { author } = require("../package.json");
const { ConfigStore } = require("./core/config.cjs");
const { LocalKeyVault } = require("./core/local-vault.cjs");
const { runScript } = require("./core/script.cjs");
const { runAI, transformAI } = require("./core/ai.cjs");
const {
  latestPromptTarget,
  recordPromptUse,
  updatePromptHistory,
  validatePrompt,
} = require("./core/prompt-history.cjs");
const { ScriptConversation } = require("./core/script-conversation.cjs");
const {
  ScriptConversationStore,
} = require("./core/script-conversation-store.cjs");
const { ScriptTests, activeScriptSource } = require("./core/script-tests.cjs");
const scriptTests = new ScriptTests();
const {
  captureSelection,
  checkCapturePermission,
} = require("./core/capture.cjs");
const { ShortcutManager, shortcutBindings } = require("./core/shortcuts.cjs");
const {
  encodeSharedScheme,
  shareFileName,
  readSharedScheme,
  writeSharedScheme,
} = require("./core/scheme-share.cjs");
const shareFilters = [{ name: "CopyX 自定义处理文件", extensions: ["json"] }];
let window,
  store,
  scriptConversationStore,
  scriptConversation,
  tray,
  task = null,
  capturing = false,
  quitting = false,
  saving = false;
// 延续预览版的内部存储名称，保持已有配置目录兼容。
app.setName("文本工坊");
const testing = Boolean(process.env.TEXT_WORKBENCH_TEST_DIR);
if (testing) app.setPath("userData", process.env.TEXT_WORKBENCH_TEST_DIR);
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  const shortcuts = new ShortcutManager(
    globalShortcut,
    process.platform,
    (id, sharedAI) => void capture(id, sharedAI),
  );
  const send = (channel, value) => window?.webContents.send(channel, value);
  function open() {
    window.show();
    window.focus();
  }
  async function showAbout() {
    await dialog.showMessageBox(window, {
      type: "info",
      title: "关于 CopyX",
      message: "CopyX",
      detail: `版本 ${app.getVersion()}\n作者 ${author}`,
      buttons: ["确定"],
    });
  }
  function captureHelper() {
    const win = process.platform === "win32";
    if (app.isPackaged)
      return path.join(
        process.resourcesPath,
        win ? "capture.ps1" : "capture-mac",
      );
    return win
      ? path.join(__dirname, "native/capture.ps1")
      : path.join(__dirname, "../assets/capture-mac");
  }
  async function capture(schemeId, sharedAI) {
    if (capturing || task || saving || shortcuts.suspended) {
      send("notice", "已有任务正在执行，请完成或取消后再试");
      return;
    }
    capturing = true;
    try {
      let target = { schemeId };
      if (sharedAI) {
        const { entry, scheme: latest } = latestPromptTarget(store.value);
        const scheme =
          latest ||
          store.value.schemes.find(
            (s) => !s.disabled && s.kind === "ai" && s.modelId,
          );
        if (!scheme) throw new Error("请先配置 AI 提示词命令");
        target = {
          schemeId: scheme.id,
          prompt: entry?.lastRun.prompt ?? scheme.prompt,
          latestPromptId: latest ? entry.id : undefined,
          promptNotice: latest
            ? undefined
            : entry
              ? "上次使用的 AI 处理已禁用或配置已变更，请先在工作台成功执行一次"
              : "请先在工作台成功执行一次提示词，之后可用快捷键直接处理",
        };
      }
      const scheme = store.value.schemes.find((s) => s.id === target.schemeId);
      if (scheme?.disabled)
        throw new Error("此自定义指令已禁用，请在自定义处理中启用并保存");
      if (scheme?.kind === "script") activeScriptSource(scheme);
      const text = await captureSelection(captureHelper());
      open();
      send("capture", { text, ...target });
    } catch (e) {
      open();
      send("notice", e.message);
    } finally {
      capturing = false;
    }
  }
  function runnableSchemes(schemes) {
    return schemes.map((s) =>
      s.kind === "script" && !s.activeScript ? { ...s, enabled: false } : s,
    );
  }
  function register(config) {
    const schemes = shortcutBindings(config, { requireAIModel: true });
    shortcuts.entries(schemes);
    // 未生效的新脚本不占用后台键位，生效时再进行注册与冲突检查。
    shortcuts.apply(runnableSchemes(schemes));
  }
  function trusted(event) {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("不允许的窗口请求");
  }
  function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        trusted(event);
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  }
  async function transferScheme(action) {
    if (saving || task || capturing)
      throw new Error("已有任务正在执行，请完成后再操作文件");
    saving = true;
    try {
      return await action();
    } finally {
      saving = false;
    }
  }
  async function processText(input, promptOnly = false) {
    if (task || saving || capturing) throw new Error("已有任务正在执行");
    if (
      typeof input?.text !== "string" ||
      Buffer.byteLength(input.text) > 1024 * 1024
    )
      throw new Error("输入必须是 1 MB 以内的文本");
    const scheme = store.value.schemes.find((s) => s.id === input.schemeId);
    if (!scheme) throw new Error("请先保存自定义处理");
    if (scheme.disabled)
      throw new Error("此自定义指令已禁用，请在自定义处理中启用并保存");
    if (promptOnly && scheme.kind !== "ai")
      throw new Error("请选择 AI 提示词命令");
    let prompt =
      typeof input.prompt === "string" ? input.prompt : scheme.prompt;
    if (input.latestPromptId !== undefined) {
      const { entry, scheme: latest } = latestPromptTarget(store.value);
      if (latest !== scheme || entry.id !== input.latestPromptId)
        throw new Error("最近使用的提示词已变更，请重新按快捷键");
      prompt = entry.lastRun.prompt;
    }
    if (scheme.kind === "ai") {
      if (!scheme.modelId) throw new Error("请先在自定义处理中选择模型配置");
      validatePrompt(prompt);
    }
    const controller = new AbortController();
    task = controller;
    try {
      const text =
        scheme.kind === "script"
          ? await runScript(input.text, activeScriptSource(scheme), {
              signal: controller.signal,
            })
          : await transformAI(
              input.text,
              prompt,
              await store.getModel(scheme.modelId),
              { signal: controller.signal },
            );
      if (controller.signal.aborted) throw new Error("处理已取消");
      if (Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw new Error("处理结果超过 2 MB，请分段处理");
      if (scheme.kind === "script") return { text };
      controller.historyCommit = true;
      try {
        const history = await store.persistPromptHistory(
          recordPromptUse(
            store.value.promptHistory,
            { prompt, schemeId: scheme.id, modelId: scheme.modelId },
            input.latestPromptId,
          ),
        );
        return { text, history };
      } catch {
        return {
          text,
          history: store.value.promptHistory,
          historyWarning:
            "处理完成，但提示词历史保存失败。请检查磁盘空间或清理历史后重试。",
        };
      }
    } finally {
      if (task === controller) task = null;
    }
  }
  function initBridge() {
    handle("shortcut:check", (input) => {
      if (saving) throw new Error("正在保存，请稍后检测快捷键");
      if (!Array.isArray(input?.schemes) || input.schemes.length > 100)
        throw new Error("自定义处理列表格式不正确");
      return shortcuts.check({ ...input, schemes: shortcutBindings(input) });
    });
    handle("shortcut:record-start", () => {
      if (saving || task || capturing)
        throw new Error("已有任务正在执行，请稍后录入快捷键");
      shortcuts.schemes = runnableSchemes(
        shortcutBindings(store.value, { requireAIModel: true }),
      );
      shortcuts.suspend();
    });
    handle("shortcut:record-end", () => shortcuts.resume());
    handle("config:get", () =>
      require("./core/config.cjs").publicConfig(store.value),
    );
    handle("config:save", async (input) => {
      if (saving || task || capturing)
        throw new Error("正在保存或处理，请稍后再试");
      saving = true;
      const previous = store.value;
      try {
        const next = await store.prepare(input);
        register(next);
        return await store.persist(next);
      } catch (e) {
        try {
          register(previous);
        } catch {}
        throw e;
      } finally {
        saving = false;
      }
    });
    handle("scheme:export", (input) =>
      transferScheme(async () => {
        let contents = encodeSharedScheme(input);
        if (input.kind === "script" && input.testCases?.length) {
          const choice = await dialog.showMessageBox(window, {
            type: "question",
            message: "分享自定义处理",
            detail: "可以同时分享测试输入和预期输出，方便接收方复测。",
            checkboxLabel: "包含测试用例",
            checkboxChecked: false,
            buttons: ["继续", "取消"],
            cancelId: 1,
            defaultId: 0,
          });
          if (choice.response !== 0) return false;
          if (choice.checkboxChecked)
            contents = encodeSharedScheme(input, true);
        }
        const { canceled, filePath } = await dialog.showSaveDialog(window, {
          title: "保存分享文件",
          defaultPath: path.join(
            app.getPath("documents"),
            shareFileName(input.name),
          ),
          filters: shareFilters,
        });
        if (canceled || !filePath) return false;
        await writeSharedScheme(filePath, contents);
        return true;
      }),
    );
    handle("scheme:import", () =>
      transferScheme(async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(window, {
          title: "导入自定义处理",
          properties: ["openFile"],
          filters: shareFilters,
        });
        return canceled || !filePaths[0]
          ? null
          : readSharedScheme(filePaths[0]);
      }),
    );
    handle("clipboard:write", (text) => {
      if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024)
        throw new Error("复制内容无效或超过 2 MB");
      clipboard.writeText(text);
    });
    handle(
      "permission:request",
      () =>
        process.platform !== "darwin" ||
        checkCapturePermission(captureHelper()),
    );
    handle("process:cancel", () => {
      if (!task?.historyCommit) task?.abort();
    });
    handle("process:run", async (input) => (await processText(input)).text);
    handle("process:run-prompt", (input) => processText(input, true));
    handle("prompt-history:update", async (input) => {
      if (saving || task || capturing)
        throw new Error("正在保存或处理，请稍后再试");
      saving = true;
      try {
        return await store.persistPromptHistory(
          updatePromptHistory(store.value.promptHistory, input),
        );
      } finally {
        saving = false;
      }
    });
    handle("script:conversation-get", (schemeId) => {
      if (typeof schemeId !== "string" || !schemeId || schemeId.length > 80)
        throw new Error("处理标识不正确");
      return {
        conversation: scriptConversation.get(schemeId),
        storageWarning: scriptConversationStore.loadWarning || null,
      };
    });
    async function conversationRequest(input, action) {
      if (task || saving || capturing)
        throw new Error("已有任务正在执行，请稍后讨论或生成脚本");
      if (
        typeof input?.requestId !== "string" ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId)
      )
        throw new Error("请求标识不正确");
      if (typeof input.modelId !== "string")
        throw new Error("请选择已保存的模型配置");
      const controller = new AbortController();
      controller.generationId = input.requestId;
      task = controller;
      try {
        return await action(await store.getModel(input.modelId), {
          signal: controller.signal,
        });
      } finally {
        if (task === controller) task = null;
      }
    }
    handle("script:discuss", (input) =>
      conversationRequest(input, (model, options) =>
        scriptConversation.discuss(input, model, options),
      ),
    );
    handle("script:generate", (input) =>
      conversationRequest(input, (model, options) =>
        scriptConversation.generate(input, model, options),
      ),
    );
    handle("script:generate-cancel", (requestId) => {
      if (typeof requestId === "string" && task?.generationId === requestId)
        task.abort();
    });
    handle("script:test", async (input) => {
      if (task || saving || capturing)
        throw new Error("已有任务正在执行，请稍后测试脚本");
      if (
        typeof input?.requestId !== "string" ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(input.requestId)
      )
        throw new Error("测试请求标识不正确");
      const controller = new AbortController();
      controller.testingId = input.requestId;
      task = controller;
      try {
        return await scriptTests.run(
          input.schemeId,
          input.script,
          input.testCases,
          { signal: controller.signal },
        );
      } finally {
        if (task === controller) task = null;
      }
    });
    handle("script:test-cancel", (requestId) => {
      if (typeof requestId === "string" && task?.testingId === requestId)
        task.abort();
    });
    handle("script:activate", async (input) => {
      if (task || saving || capturing)
        throw new Error("已有任务正在执行，请稍后生效脚本");
      saving = true;
      const previous = store.value;
      try {
        const next = store.activateScript(
          input?.schemeId,
          input?.fingerprint,
          scriptTests,
        );
        register(next);
        return await store.persist(next);
      } catch (e) {
        try {
          register(previous);
        } catch {}
        throw e;
      } finally {
        saving = false;
      }
    });
    handle("model:test", async (id) => {
      if (task || saving || capturing) throw new Error("已有任务正在执行");
      const controller = new AbortController();
      task = controller;
      try {
        await runAI(
          "请回复：连接成功",
          "只输出简短文本。",
          await store.getModel(id),
          { signal: controller.signal, timeout: 15000 },
        );
        return "连接成功";
      } finally {
        if (task === controller) task = null;
      }
    });
  }
  app
    .whenReady()
    .then(async () => {
      if (
        process.platform === "darwin" &&
        (process.arch !== "arm64" ||
          Number(
            process.getSystemVersion?.()?.split(".")[0] ||
              require("node:os").release().split(".")[0],
          ) < 14)
      ) {
        dialog.showErrorBox(
          "系统不支持",
          "需要 macOS 14 及以上的 M 系列芯片设备",
        );
        app.quit();
        return;
      }
      store = new ConfigStore(
        path.join(app.getPath("userData"), "config.json"),
        new LocalKeyVault(path.join(app.getPath("userData"), "master.key")),
      );
      try {
        await store.load();
      } catch (e) {
        dialog.showErrorBox("配置读取失败", e.message);
        app.quit();
        return;
      }
      scriptConversationStore = new ScriptConversationStore(
        path.join(app.getPath("userData"), "script-conversations.json"),
      );
      await scriptConversationStore.load();
      scriptConversation = new ScriptConversation({
        tests: scriptTests,
        repository: scriptConversationStore,
      });
      const assets = path.join(__dirname, "../assets");
      const appIcon = nativeImage.createFromPath(path.join(assets, "icon.png"));
      if (!app.isPackaged) app.dock?.setIcon(appIcon);
      window = new BrowserWindow({
        width: 1380,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        title: "CopyX",
        icon: appIcon,
        backgroundColor: "#f2f4fa",
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      initBridge();
      window.on("blur", () => {
        try {
          shortcuts.resume();
        } catch (error) {
          send("notice", error.message);
        }
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.session.webRequest.onHeadersReceived(
        (details, callback) =>
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              "Content-Security-Policy": [
                "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; worker-src 'self' blob:",
              ],
            },
          }),
      );
      window.on("close", (event) => {
        if (!quitting && !testing) {
          event.preventDefault();
          task?.abort();
          send("notice", "任务已取消，窗口已隐藏");
          window.hide();
        }
      });
      await window.loadFile(path.join(__dirname, "../dist/index.html"));
      const trayIcon =
        process.platform === "darwin"
          ? nativeImage.createFromPath(path.join(assets, "trayTemplate.png"))
          : appIcon.resize({ width: 16, height: 16 });
      if (process.platform === "darwin") trayIcon.setTemplateImage(true);
      tray = new Tray(trayIcon);
      tray.setToolTip("CopyX");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 CopyX", click: open },
          {
            label: "退出",
            click: () => {
              quitting = true;
              app.quit();
            },
          },
        ]),
      );
      tray.on("click", open);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "CopyX",
            submenu: [
              ...(process.platform === "darwin"
                ? [
                    { label: "关于 CopyX", click: () => void showAbout() },
                    { type: "separator" },
                  ]
                : []),
              { label: "打开窗口", click: open },
              {
                label: "退出",
                accelerator: "CmdOrCtrl+Q",
                click: () => {
                  quitting = true;
                  app.quit();
                },
              },
            ],
          },
          {
            label: "编辑",
            submenu: [
              { role: "undo", label: "撤销" },
              { role: "redo", label: "重做" },
              { type: "separator" },
              { role: "cut", label: "剪切" },
              { role: "copy", label: "复制" },
              { role: "paste", label: "粘贴" },
              { role: "selectAll", label: "全选" },
            ],
          },
        ]),
      );
      try {
        if (!testing) register(store.value);
      } catch (e) {
        send("notice", e.message);
      }
      open();
    })
    .catch((e) => {
      dialog.showErrorBox("启动失败", e.message);
      app.quit();
    });
  app.on("before-quit", () => {
    quitting = true;
    task?.abort();
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("activate", () => window && open());
}
