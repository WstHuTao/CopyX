import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const { LocalKeyVault } = require("../electron/core/local-vault.cjs");
const temp = await mkdtemp(path.join(os.tmpdir(), "copyx-prompt-history-"));
const userData = path.join(temp, "data");
const keyA = "Control+Alt+Shift+F7";
const keyB = "Control+Alt+Shift+F8";
const keyScript = "Control+Alt+Shift+F9";
const text = "仅用于测试的选中文字\t甲\r\n";
const requests = [];
let slowStarted;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { messages, model } = JSON.parse(body);
  const system = messages[0].content;
  const prompt = system.split("\n用户处理要求：\n")[1];
  const retry = system.includes("上次回复不符合返回格式");
  const firstEmailRequest =
    prompt === "提取邮箱" && !requests.some((item) => item.prompt === prompt);
  requests.push({ prompt, text: messages[1].content, model });
  if (prompt === "失败提示词") {
    res.writeHead(503).end();
  } else if (prompt === "取消提示词" && retry) {
    slowStarted?.();
  } else {
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                prompt === "说明性回复" ||
                prompt === "取消提示词" ||
                firstEmailRequest
                  ? "无需改动，结果为 **飒飒**"
                  : JSON.stringify({ text: "仅在工作台显示的结果" }),
            },
          },
        ],
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let app, page;
const errors = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const field = (name) => page.getByLabel(name, { exact: true });
const footer = (phrase) => page.locator("footer").filter({ hasText: phrase });
const entry = (prompt) =>
  page
    .locator(".prompt-history-entry")
    .filter({ has: page.getByText(prompt, { exact: true }) });
const config = () =>
  page.evaluate(async () => (await window.desktop.getConfig()).data);
const keyTrigger = () =>
  app.evaluate(({ globalShortcut }, key) => {
    if (!globalShortcut.isRegistered(key))
      throw new Error("共享快捷键尚未注册");
    globalThis.copyxFixtureShortcuts.get(key)();
  }, keyA);
async function run(prompt) {
  await field("本次提示词").fill(prompt);
  await button("执行处理").click();
  try {
    await footer("处理完成").waitFor();
  } catch (error) {
    throw new Error(
      `处理验证失败：${await page.locator("footer").innerText()}`,
      { cause: error },
    );
  }
}
async function start() {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [temp],
    env: {
      ...process.env,
      TEXT_WORKBENCH_TEST_DIR: userData,
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await button("载入样例").waitFor();
}
try {
  await mkdir(userData);
  await writeFile(
    path.join(temp, "package.json"),
    JSON.stringify({ main: "main.cjs" }),
  );
  // 使用真实注册器，测试直接调用已注册回调。模拟系统取文以隔离用户剪贴板与辅助功能授权。
  await writeFile(
    path.join(temp, "main.cjs"),
    `
    const { clipboard, globalShortcut } = require("electron");
    const register = globalShortcut.register.bind(globalShortcut);
    globalThis.copyxFixtureShortcuts = new Map();
    globalShortcut.register = (key, callback) => {
      const registered = register(key, callback);
      if (registered) globalThis.copyxFixtureShortcuts.set(key, callback);
      return registered;
    };
    clipboard.readText = () => globalThis.copyxFixtureClipboard;
    clipboard.writeText = (value) => {
      globalThis.copyxFixtureClipboard = value;
      globalThis.copyxDirectDone?.(value);
    };
    require(${JSON.stringify(require.resolve("../electron/core/capture.cjs"))}).captureSelection = async () => {
      const original = ${JSON.stringify(text)};
      globalThis.copyxFixtureClipboard = globalThis.copyxClipboardChanged ? "用户新复制的文字" : original;
      return original;
    };
    require(${JSON.stringify(require.resolve("../electron/main.cjs"))});
  `,
  );
  const vault = new LocalKeyVault(path.join(userData, "master.key"));
  const makeScheme = (id, name, shortcutMac) => ({
    id,
    name,
    kind: "ai",
    modelId: id,
    prompt: "初始提示词",
    script: "",
    shortcutMac,
    shortcutWin: "",
    enabled: true,
  });
  const models = await Promise.all(
    ["a", "b"].map(async (id) => ({
      id,
      name: "本地模型 " + id,
      model: "fixture-" + id,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      encryptedKey: await vault.encrypt("copyx-prompt-fixture-key", id),
    })),
  );
  const script = "function transform(text) { return text; }";
  await writeFile(
    path.join(userData, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      models,
      schemes: [
        makeScheme("a", "AI 处理甲", keyA),
        makeScheme("b", "AI 处理乙", keyB),
        {
          ...makeScheme("s", "本地脚本", keyScript),
          kind: "script",
          script,
          activeScript: { script, status: "legacy", testCases: [] },
        },
      ],
    }),
  );
  await start();
  const originalSettings = await config();
  assert.deepEqual(originalSettings.promptHistory, []);
  assert.equal(originalSettings.aiShortcut.shortcutMac, keyA);
  await button("自定义处理").click();
  for (const name of ["AI 处理乙 AI 提示词命令", "AI 处理甲 AI 提示词命令"]) {
    await button(name).click();
    await button("编辑设置").click();
    assert.equal(await field("快捷键").inputValue(), keyA);
    assert.equal(await field("启用全局快捷键").count(), 0);
  }
  await button("保存自定义处理").click();
  await footer("配置已保存").waitFor();
  assert.deepEqual(
    await app.evaluate(
      ({ globalShortcut }, keys) =>
        keys.map((key) => globalShortcut.isRegistered(key)),
      [keyA, keyB, keyScript],
    ),
    [true, false, true],
  );
  const conflict = await page.evaluate(async (key) => {
    const config = (await window.desktop.getConfig()).data;
    return window.desktop.checkShortcut({
      ...config,
      schemeId: "ai-prompt-shortcut",
      sharedAI: true,
      key,
    });
  }, keyScript);
  assert.equal(conflict.data.available, false);
  await page.screenshot({
    path: path.join(os.tmpdir(), "copyx-shared-ai-shortcut.png"),
    scale: "css",
  });

  await keyTrigger();
  await footer("请先在工作台成功执行一次提示词").waitFor();
  assert.equal(requests.length, 0);
  await run("转成 JSON");
  await field("自定义处理").selectOption("b");
  await run("提取邮箱");
  assert.equal(
    requests.filter(({ prompt }) => prompt === "提取邮箱").length,
    2,
  );
  await button("提示词历史").click();
  await entry("转成 JSON")
    .getByRole("button", { name: "收藏", exact: true })
    .click();
  await page
    .locator(".prompt-history-entry")
    .first()
    .getByText("转成 JSON", { exact: true })
    .waitFor();
  assert.equal((await config()).promptHistory[0].prompt, "提取邮箱");
  await entry("提取邮箱")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await field("编辑提示词").fill("提取邮箱和姓名");
  await button("保存提示词").click();
  await entry("提取邮箱和姓名").getByText("已编辑，执行后更新快捷键").waitFor();
  await page.screenshot({
    path: path.join(os.tmpdir(), "copyx-prompt-history.png"),
    scale: "css",
  });
  await button("关闭提示词历史").click();

  const choices = page.getByRole("group", { name: "快捷提示词" });
  assert.deepEqual(await choices.locator("button span").allTextContents(), [
    "转成 JSON",
    "提取邮箱和姓名",
  ]);
  const requestsBeforeChoice = requests.length;
  const favoriteChoice = choices.getByRole("button", { name: /转成 JSON/ });
  await favoriteChoice.click();
  assert.equal(await field("本次提示词").inputValue(), "转成 JSON");
  assert.equal(await favoriteChoice.getAttribute("aria-pressed"), "true");
  assert.equal(requests.length, requestsBeforeChoice);
  assert.equal((await config()).promptHistory[0].lastRun.prompt, "提取邮箱");
  await page.screenshot({
    path: path.join(os.tmpdir(), "copyx-prompt-quick-choices.png"),
    scale: "css",
  });

  await field("自定义处理").selectOption("a");
  await keyTrigger();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="自定义处理"]').value === "b",
  );
  await footer("处理完成").waitFor();
  assert.equal(await field("本次提示词").inputValue(), "提取邮箱");
  assert.deepEqual(requests.at(-1), {
    prompt: "提取邮箱",
    text,
    model: "fixture-b",
  });
  assert.equal((await config()).promptHistory.length, 2);
  await field("本次提示词").fill("说明性回复");
  await button("执行处理").click();
  await footer("模型未按要求返回处理结果").waitFor();
  assert.equal(
    requests.filter(({ prompt }) => prompt === "说明性回复").length,
    2,
  );
  assert.equal((await config()).promptHistory[0].lastRun.prompt, "提取邮箱");
  await field("本次提示词").fill("失败提示词");
  await button("执行处理").click();
  await footer("HTTP 503").waitFor();
  assert.equal(
    requests.filter(({ prompt }) => prompt === "失败提示词").length,
    1,
  );
  const pending = new Promise((resolve) => {
    slowStarted = resolve;
  });
  await field("本次提示词").fill("取消提示词");
  await button("执行处理").click();
  await pending;
  await button("取消处理").click();
  await footer("处理已取消").waitFor();
  assert.equal(
    requests.filter(({ prompt }) => prompt === "取消提示词").length,
    2,
  );
  assert.equal((await config()).promptHistory[0].lastRun.prompt, "提取邮箱");
  assert.equal((await config()).promptHistory.length, 2);

  await button("提示词历史").click();
  await entry("提取邮箱和姓名")
    .getByRole("button", { name: "使用此提示词" })
    .click();
  assert.equal(await field("本次提示词").inputValue(), "提取邮箱和姓名");
  assert.equal((await config()).promptHistory[0].lastRun.prompt, "提取邮箱");
  await run("提取邮箱和姓名");
  assert.equal(
    (await config()).promptHistory[0].lastRun.prompt,
    "提取邮箱和姓名",
  );
  await button("提示词历史").click();
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await entry("提取邮箱和姓名")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await entry("提取邮箱和姓名").waitFor({ state: "detached" });
  await button("关闭提示词历史").click();
  await keyTrigger();
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="自定义处理"]').value === "a",
  );
  await footer("处理完成").waitFor();
  assert.deepEqual(requests.at(-1), {
    prompt: "转成 JSON",
    text,
    model: "fixture-a",
  });

  const changedModel = await config();
  changedModel.schemes.find((scheme) => scheme.id === "a").modelId = "b";
  const modelChange = await page.evaluate(
    (value) => window.desktop.saveConfig(value),
    changedModel,
  );
  assert(modelChange.ok, modelChange.error);
  const beforeReplay = requests.length;
  await keyTrigger();
  await footer("上次使用的 AI 处理已禁用或配置已变更").waitFor();
  assert.equal(requests.length, beforeReplay);

  const saved = await page.evaluate(
    (value) => window.desktop.saveConfig(value),
    originalSettings,
  );
  assert(saved.ok, saved.error);
  assert.equal(saved.data.promptHistory.length, 1);
  await app.close();
  await start();
  const restored = await config();
  assert.equal(restored.promptHistory[0].prompt, "转成 JSON");
  assert.equal(restored.promptHistory[0].favorite, true);
  assert.equal(restored.aiShortcut.shortcutMac, keyA);
  const stored = await readFile(path.join(userData, "config.json"), "utf8");
  assert(!stored.includes("仅用于测试的选中文字"));
  assert(!stored.includes("仅在工作台显示的结果"));
  assert(!stored.includes("copyx-prompt-fixture-key"));
  const enabledScript = await page.evaluate(async (input) => {
    const settings = (await window.desktop.getConfig()).data;
    const scheme = settings.schemes.find((item) => item.id === "s");
    scheme.script = 'function transform(text) { return text + "已处理"; }';
    scheme.testCases = [
      { id: "case", name: "直接复制", input, expected: input + "已处理" },
    ];
    const saved = await window.desktop.saveConfig(settings);
    if (!saved.ok) return saved;
    const tested = await window.desktop.testScript({
      requestId: crypto.randomUUID(),
      schemeId: scheme.id,
      script: scheme.script,
      testCases: scheme.testCases,
    });
    if (!tested.ok) return tested;
    return window.desktop.activateScript({
      schemeId: scheme.id,
      fingerprint: tested.data.fingerprint,
    });
  }, text);
  assert(enabledScript.ok, enabledScript.error);
  await page.reload();
  await button("自定义处理").click();
  await button("本地脚本 JavaScript 脚本").click();
  await button("编辑设置").click();
  const direct = page.getByRole("checkbox", { name: "处理后直接复制" });
  assert.equal(await direct.isChecked(), false);
  await direct.check();
  await button("保存草稿").click();
  await footer("配置已保存").waitFor();
  assert.equal(
    (await config()).schemes.find(({ id }) => id === "s").directPaste,
    true,
  );
  async function triggerDirect(changed) {
    return app.evaluate(
      ({ globalShortcut }, { key, changed }) => {
        if (!globalShortcut.isRegistered(key))
          throw new Error("脚本快捷键尚未注册");
        globalThis.copyxClipboardChanged = changed;
        if (changed) {
          globalThis.copyxFixtureShortcuts.get(key)();
          return;
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("处理结果未复制")),
            5000,
          );
          globalThis.copyxDirectDone = (value) => {
            clearTimeout(timer);
            delete globalThis.copyxDirectDone;
            resolve(value);
          };
          globalThis.copyxFixtureShortcuts.get(key)();
        });
      },
      { key: keyScript, changed },
    );
  }
  assert.equal(await triggerDirect(false), text + "已处理");
  assert.equal(
    await page.getByRole("heading", { name: "自定义处理" }).count(),
    1,
  );
  await triggerDirect(true);
  await footer("处理期间剪贴板已变化").waitFor();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    "用户新复制的文字",
  );
  await page
    .locator(".monaco-diff-editor .modified .view-lines")
    .filter({ hasText: "已处理" })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "AI 提示词桌面验证通过：旧键位迁移、单一键位入口、共享注册、冲突检测、首次使用提示、成功记录、收藏排序、胶囊选择、编辑与删除、旧默认保护、失败与取消、同模型复用、重启保留及正文不落盘。",
  );
  console.log(
    "直接复制桌面验证通过：默认关闭、验证后启用、成功复制结果并保留当前页面、剪贴板变化时保留用户新复制的内容并展示结果。",
  );
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
