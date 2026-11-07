import {
  discussThenGenerate,
  latestDiscussion,
} from "./script-conversation-test-helpers.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import http from "node:http";
const temp = await mkdtemp(path.join(os.tmpdir(), "text-workbench-"));
const executablePath =
  process.env.TEXT_WORKBENCH_EXECUTABLE ||
  path.resolve(
    "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );
let generationRequests = 0;
let processingRequests = 0;
async function activateForTest(page, schemeId, testCases) {
  const tested = await page.evaluate(
    async ({ schemeId, testCases }) => {
      const config = (await window.desktop.getConfig()).data;
      const scheme = config.schemes.find((s) => s.id === schemeId);
      scheme.testCases = testCases;
      const saved = await window.desktop.saveConfig(config);
      if (!saved.ok) return saved;
      const run = await window.desktop.testScript({
        requestId: crypto.randomUUID(),
        schemeId,
        script: scheme.script,
        testCases,
      });
      if (!run.ok || !run.data.passed)
        return { ok: false, error: run.error || "预置样例未通过" };
      return window.desktop.activateScript({
        schemeId,
        fingerprint: run.data.fingerprint,
      });
    },
    { schemeId, testCases },
  );
  assert(tested.ok, tested.error);
}
const server = http.createServer(async (req, res) => {
  let text = "";
  for await (const c of req) text += c;
  const body = JSON.parse(text);
  res.setHeader("Content-Type", "application/json");
  if (body.messages[0].content.includes("CopyX 脚本方案讨论助手")) {
    generationRequests++;
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "处理方案：按要求转换字段，保持其他字符和换行。",
            },
          },
        ],
      }),
    );
    return;
  }
  if (body.messages[0].content.includes("CopyX 脚本生成助手")) {
    generationRequests++;
    const request = latestDiscussion(body.messages);
    const content = request.includes("生成错误脚本测试")
      ? "function wrong(text) { return text; }"
      : '```javascript\nfunction transform(text) { return text.replace(/,/g, "\\t"); }\n```';
    const answer = () =>
      res.end(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: "stop" }],
        }),
      );
    if (request.includes("慢速生成测试")) setTimeout(answer, 1200);
    else answer();
    return;
  }
  processingRequests++;
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content:
              body.messages[1].content === "请回复：连接成功"
                ? "连接成功"
                : JSON.stringify({ text: "公司\t联系人\r\n示例\t张三" }),
          },
          finish_reason: "stop",
        },
      ],
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let app;
try {
  app = await electron.launch({
    executablePath,
    args: process.env.TEXT_WORKBENCH_EXECUTABLE ? [] : ["."],
    env: { ...process.env, TEXT_WORKBENCH_TEST_DIR: temp },
    timeout: 30000,
  });
  console.log("桌面验证：应用已启动");
  let page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "载入样例", exact: true }).waitFor();
  assert(
    await page.evaluate(
      async () => (await document.fonts.load("16px codicon")).length > 0,
    ),
    "编辑器图标字体必须在离线安装包中可用",
  );
  await page.getByRole("button", { name: "载入样例", exact: true }).click();
  await page.getByRole("button", { name: "执行处理", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "处理完成" })
    .waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "复制原文", exact: true }).click();
  const original = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.equal(
    original,
    "公司名称\t联系人\t电话\r\n示例公司\t张三\t13800000000\r\n",
  );
  await page.getByRole("button", { name: "复制结果", exact: true }).click();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    original,
  );
  assert(
    await page
      .getByRole("button", { name: "复制结果", exact: true })
      .evaluate((el) => el.classList.contains("primary")),
    "处理完成后突出复制结果",
  );
  assert(
    !(await page
      .getByRole("button", { name: "执行处理", exact: true })
      .evaluate((el) => el.classList.contains("primary"))),
    "完成后重新执行降为次级",
  );
  console.log("桌面验证：原文与结果复制及完成态按钮层级通过");
  assert.equal(await page.locator("aside").getByText("关于 CopyX").count(), 0);
  const aboutInfo = await app.evaluate(({ app, dialog, Menu }) => {
    const item = Menu.getApplicationMenu()
      .items.find(({ label }) => label === "CopyX")
      ?.submenu.items.find(({ label }) => label === "关于 CopyX");
    if (!item) return null;

    const original = dialog.showMessageBox;
    let options;
    try {
      dialog.showMessageBox = async (_window, messageOptions) => {
        options = messageOptions;
        return { response: 0 };
      };
      item.click();
      return { options, version: app.getVersion() };
    } finally {
      dialog.showMessageBox = original;
    }
  });
  if (process.platform === "darwin") {
    assert.equal(aboutInfo?.options?.title, "关于 CopyX");
    assert.equal(
      aboutInfo.options.detail,
      `版本 ${aboutInfo.version}\n作者 Ivan`,
    );
  } else {
    assert.equal(aboutInfo, null);
  }
  console.log("桌面验证：关于 CopyX 的平台入口与版本信息通过");
  assert.equal(
    await page.locator("aside").getByText("CopyX", { exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  assert(
    !(await page.locator("footer").innerText()).includes("已复制"),
    "切换页面清除工作台旧状态",
  );
  assert(
    (await page.locator("footer").innerText()).includes("配置与对话保存在本机"),
  );
  assert.equal(
    await page.getByRole("button", { name: /^保存配置/ }).count(),
    0,
    "脚本页没有重复保存入口",
  );
  await page
    .getByRole("tab", { name: "处理脚本", exact: true })
    .press("ArrowRight");
  assert.equal(
    await page
      .getByRole("tab", { name: /^测试集/ })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.getByRole("tab", { name: /^测试集/ }).press("ArrowLeft");
  assert.equal(
    await page
      .getByRole("tab", { name: "处理脚本", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  const beforeWindow = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getSize(),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1000, 700),
  );
  await page.waitForFunction(() => innerWidth <= 1000);
  const actionBox = await page
    .getByRole("button", { name: "启用此版本", exact: true })
    .boundingBox();
  const viewSize = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  assert(
    actionBox.x >= 0 &&
      actionBox.x + actionBox.width <= viewSize.width &&
      actionBox.y + actionBox.height <= viewSize.height,
    "最小窗口完整显示生效操作",
  );
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0].setSize(...size),
    beforeWindow,
  );

  if (
    await page
      .getByRole("button", { name: "编辑设置", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "编辑设置", exact: true }).click();
  assert.equal(await page.getByLabel("快捷键", { exact: true }).count(), 1);
  assert.equal(
    await page.getByLabel("macOS 快捷键", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Windows 快捷键", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "新增处理", exact: true }).click();
  await page.getByLabel("处理名称", { exact: true }).fill("重复快捷键处理");
  await page.getByLabel("快捷键", { exact: true }).click();
  await page.keyboard.press("Control+Alt+Shift+F8");
  await page
    .locator("#shortcut-feedback")
    .filter({ hasText: "未发现注册冲突" })
    .waitFor();
  await page.keyboard.press("Meta+Shift+1");
  await page
    .locator("#shortcut-feedback")
    .filter({ hasText: "与「文本清理」的快捷键重复" })
    .waitFor();
  assert.equal(
    await page.getByLabel("快捷键", { exact: true }).inputValue(),
    "Command+Shift+1",
  );
  await page
    .getByRole("button", { name: /^(保存草稿|保存自定义处理|保存设置)$/ })
    .click();
  await page.getByRole("status").filter({ hasText: "快捷键冲突" }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.desktop.getConfig())).data.schemes.length,
    1,
  );
  assert.equal(
    await page.getByLabel("启用全局快捷键", { exact: true }).count(),
    0,
  );
  await page.getByLabel("快捷键", { exact: true }).click();
  await page.keyboard.press("Backspace");
  assert.equal(
    await page.getByLabel("快捷键", { exact: true }).inputValue(),
    "",
  );
  await page
    .getByRole("button", { name: /^(保存草稿|保存自定义处理|保存设置)$/ })
    .click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  const disabledConfig = await page.evaluate(() => window.desktop.getConfig());
  const disabledItem = disabledConfig.data.schemes.find(
    (item) => item.name === "重复快捷键处理",
  );
  assert.equal(disabledItem.enabled, false);
  assert.equal(disabledItem.shortcutMac, "");
  await activateForTest(page, disabledItem.id, [
    {
      id: "manual",
      name: "手动执行",
      input: "关闭后仍可手动执行",
      expected: "关闭后仍可手动执行",
    },
  ]);
  const manual = await page.evaluate(
    (id) => window.desktop.run({ schemeId: id, text: "关闭后仍可手动执行" }),
    disabledItem.id,
  );
  assert(manual.ok && manual.data === "关闭后仍可手动执行");
  const legacyShortcut = await page.evaluate(async (id) => {
    const { data } = await window.desktop.getConfig();
    const item = data.schemes.find((scheme) => scheme.id === id);
    item.shortcutMac = "Control+Alt+Shift+F8";
    return window.desktop.saveConfig(data);
  }, disabledItem.id);
  assert(legacyShortcut.ok);
  await page.reload();
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  await page.getByRole("button", { name: /^重复快捷键处理/ }).click();
  await page.getByRole("button", { name: "编辑设置", exact: true }).click();
  assert.equal(
    await page.getByLabel("快捷键", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered("Control+Alt+Shift+F8"),
    ),
    false,
  );
  await page.getByLabel("快捷键", { exact: true }).click();
  await page.keyboard.press("Control+Alt+Shift+F8");
  await page
    .locator("#shortcut-feedback")
    .filter({ hasText: "未发现注册冲突" })
    .waitFor();
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  assert(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered("Control+Alt+Shift+F8"),
    ),
  );
  const occupied = "Control+Alt+Shift+F19";
  assert(
    await app.evaluate(
      ({ globalShortcut }, key) => globalShortcut.register(key, () => {}),
      occupied,
    ),
  );
  const blocked = await page.evaluate(async (key) => {
    const saved = await window.desktop.getConfig();
    return window.desktop.checkShortcut({
      schemeId: "test",
      key,
      schemes: saved.data.schemes,
    });
  }, occupied);
  assert(blocked.ok && !blocked.data.available);
  assert(
    await app.evaluate(
      ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
      occupied,
    ),
  );
  await app.evaluate(
    ({ globalShortcut }, key) => globalShortcut.unregister(key),
    occupied,
  );
  await page.getByRole("button", { name: "处理工作台", exact: true }).click();
  console.log(
    "桌面验证：快捷键录入、系统注册检测、内部冲突阻止保存、清空后手动模式通过",
  );
  const configReply = await page.evaluate(() => window.desktop.getConfig());
  assert(configReply.ok);
  const config = configReply.data;
  config.schemes[0].script =
    'function transform(text) { return text.replace("示例公司", "处理后公司"); }';
  const saved = await page.evaluate(
    (value) => window.desktop.saveConfig(value),
    config,
  );
  assert(saved.ok);
  await activateForTest(page, config.schemes[0].id, [
    { id: "copy", name: "公司替换", input: "示例公司", expected: "处理后公司" },
  ]);
  await page.reload();
  await page.getByRole("button", { name: "载入样例", exact: true }).click();
  await page.getByRole("button", { name: "执行处理", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "处理完成" }).waitFor();
  await page.getByRole("button", { name: "复制结果", exact: true }).click();
  assert.match(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    /处理后公司/,
  );
  await page
    .locator(".modified .view-lines")
    .click({ position: { x: 100, y: 20 } });
  await page.keyboard.press("Meta+End");
  await page.keyboard.type("人工修改");
  await page.getByRole("button", { name: "复制结果", exact: true }).click();
  assert.match(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    /人工修改/,
  );
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  if (
    await page
      .getByRole("button", { name: "编辑设置", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "编辑设置", exact: true }).click();
  await page.getByRole("button", { name: "处理工作台", exact: true }).click();
  assert.match(
    await page.locator(".modified .view-lines").innerText(),
    /人工修改/,
  );
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await page.getByRole("button", { name: "执行处理", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "处理完成" }).waitFor();
  await page.waitForFunction(
    () =>
      !document
        .querySelector(".modified .view-lines")
        ?.textContent?.includes("人工修改"),
    undefined,
    { timeout: 5000 },
  );
  await page.getByRole("button", { name: "复制结果", exact: true }).click();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    original.replace("示例公司", "处理后公司"),
  );
  console.log("桌面验证：人工修改、跨页保留与重跑通过");
  if (!process.env.TEXT_WORKBENCH_LOCAL_ONLY) {
    config.schemes[0].testCases = [
      {
        id: "commas",
        name: "逗号转换",
        input: "甲,乙\n1,,3",
        expected: "甲\t乙\n1\t\t3",
      },
    ];
    const withModel = {
      ...config,
      models: [
        {
          id: "local-test",
          name: "本地测试服务",
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          model: "local-test",
          apiKey: "test-secret-not-real",
        },
      ],
    };
    console.log("桌面验证：开始保存测试模型");
    const modelSaved = await page.evaluate(
      (value) => window.desktop.saveConfig(value),
      withModel,
    );
    assert(modelSaved.ok, modelSaved.error);
    assert(!JSON.stringify(modelSaved).includes("test-secret-not-real"));
    const stored = await readFile(path.join(temp, "config.json"), "utf8");
    assert(!stored.includes("test-secret-not-real"));
    assert(JSON.parse(stored).models[0].encryptedKey.startsWith("copyx:v1:"));
    assert.equal((await readFile(path.join(temp, "master.key"))).length, 32);
    await app.close();
    app = await electron.launch({
      executablePath,
      args: process.env.TEXT_WORKBENCH_EXECUTABLE ? [] : ["."],
      env: { ...process.env, TEXT_WORKBENCH_TEST_DIR: temp },
      timeout: 30000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "载入样例", exact: true }).waitFor();
    const afterRestart = await page.evaluate(() => window.desktop.getConfig());
    assert(
      afterRestart.ok &&
        afterRestart.data.models[0].hasKey &&
        !afterRestart.data.models[0].needsKeyUpdate,
    );
    console.log("桌面验证：密钥加密保存与应用重启读取通过");
    const modelTest = await page.evaluate(() =>
      window.desktop.testModel("local-test"),
    );
    assert(modelTest.ok, modelTest.error);
    console.log("桌面验证：模型连接通过");
    assert.equal(await page.locator(".script-generator").count(), 0);
    await page.getByRole("button", { name: "自定义处理", exact: true }).click();
    if (
      await page
        .getByRole("button", { name: "编辑设置", exact: true })
        .isVisible()
    )
      await page.getByRole("button", { name: "编辑设置", exact: true }).click();
    await page.getByLabel("处理类型", { exact: true }).selectOption("ai");
    assert.equal(await page.locator(".script-generator").count(), 0);
    await page.getByLabel("处理类型", { exact: true }).selectOption("script");
    await page
      .getByRole("button", { name: "使用模型生成脚本", exact: true })
      .click();
    await page.getByLabel("处理要求", { exact: true }).fill("将逗号换成制表符");
    await discussThenGenerate(page);
    await page.getByText("生成脚本预览", { exact: true }).waitFor();
    const generatedCode =
      'function transform(text) { return text.replace(/,/g, "\\t"); }';
    const beforeApply = await page.evaluate(() => window.desktop.getConfig());
    assert.equal(beforeApply.data.schemes[0].script, config.schemes[0].script);
    assert.match(
      await page.locator(".script-editor .view-lines").innerText(),
      /处理后公司/,
    );
    await mkdir("docs/screenshots", { recursive: true });
    await page
      .getByRole("button", { name: "应用到脚本编辑器", exact: true })
      .scrollIntoViewIfNeeded();
    await page.mouse.move(600, 40);
    await page.screenshot({
      scale: "css",
      path: "docs/screenshots/AI生成脚本.png",
    });
    await page
      .getByRole("button", { name: "关闭模型对话", exact: true })
      .click();
    await page
      .locator(".script-editor .view-lines")
      .click({ position: { x: 140, y: 20 } });
    await page.keyboard.press("Meta+End");
    await page.keyboard.insertText("\n// 人工修改");
    await page
      .getByRole("button", { name: "使用模型生成脚本", exact: true })
      .click();
    await page.evaluate(() => {
      window.confirm = () => false;
    });
    await page
      .getByRole("button", { name: "应用到脚本编辑器", exact: true })
      .click();
    assert.equal(await page.locator(".generated-preview").count(), 1);
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    await page
      .getByRole("button", { name: "应用到脚本编辑器", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "生成的脚本已应用到编辑器" })
      .waitFor();
    assert.equal(
      (await page.evaluate(() => window.desktop.getConfig())).data.schemes[0]
        .script,
      config.schemes[0].script,
    );
    await page.getByRole("button", { name: "启用此版本", exact: true }).click();
    await page
      .locator("footer")
      .filter({ hasText: "脚本已通过测试并生效" })
      .waitFor();
    assert.equal(await page.locator("h1").innerText(), "自定义处理");
    assert.equal(
      await page.getByRole("button", { name: "执行处理", exact: true }).count(),
      0,
    );
    assert.equal(
      (await page.evaluate(() => window.desktop.getConfig())).data.schemes[0]
        .script,
      generatedCode,
    );
    const requestsBeforeLocalRun = { generationRequests, processingRequests };
    await page.getByRole("button", { name: "处理工作台", exact: true }).click();
    assert.equal(await page.locator(".script-generator").count(), 0);
    await page.locator("summary").filter({ hasText: "手动输入原文" }).click();
    await page.getByLabel("手动输入原文", { exact: true }).fill("甲,乙\n1,,3");
    await page.getByRole("button", { name: "执行处理", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "处理完成" }).waitFor();
    await page.getByRole("button", { name: "复制结果", exact: true }).click();
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      "甲\t乙\n1\t\t3",
    );
    assert.deepEqual(
      { generationRequests, processingRequests },
      requestsBeforeLocalRun,
      "保存后的 JS 处理必须本地执行，不请求生成模型或 AI 处理接口",
    );
    await page.getByRole("button", { name: "自定义处理", exact: true }).click();
    if (
      await page
        .getByRole("button", { name: "编辑设置", exact: true })
        .isVisible()
    )
      await page.getByRole("button", { name: "编辑设置", exact: true }).click();
    await page
      .getByRole("button", { name: "使用模型生成脚本", exact: true })
      .click();
    await page.getByLabel("处理要求", { exact: true }).fill("生成错误脚本测试");
    await discussThenGenerate(page);
    await page
      .locator(".generator-message.error")
      .filter({ hasText: "transform" })
      .waitFor();
    assert.equal(
      (await page.evaluate(() => window.desktop.getConfig())).data.schemes[0]
        .script,
      generatedCode,
    );
    await page.getByLabel("处理要求", { exact: true }).fill("慢速生成测试");
    await discussThenGenerate(page);
    await page.getByRole("button", { name: "取消请求", exact: true }).waitFor();
    await page.evaluate(() =>
      window.desktop.cancelScriptGeneration("unrelated-request"),
    );
    await page.getByRole("button", { name: "取消请求", exact: true }).click();
    await page
      .locator(".generator-message")
      .filter({ hasText: /已取消/ })
      .waitFor();
    assert.equal(await page.locator(".generated-preview").count(), 0);
    assert.equal(
      (await page.evaluate(() => window.desktop.getConfig())).data.schemes[0]
        .script,
      generatedCode,
    );
    config.schemes[0].script = generatedCode;
    console.log(
      "桌面验证：AI生成预览、覆盖保护、显式应用保存、沙箱试运行与失败取消保护通过",
    );

    const aiConfig = {
      ...modelSaved.data,
      schemes: [
        ...config.schemes,
        {
          id: "ai-test",
          name: "转为表格",
          kind: "ai",
          modelId: "local-test",
          prompt: "整理成表格",
          script: "",
          shortcutMac: "",
          shortcutWin: "",
          enabled: true,
        },
      ],
    };
    assert(
      (
        await page.evaluate(
          (value) => window.desktop.saveConfig(value),
          aiConfig,
        )
      ).ok,
    );
    await page.reload();
    await page.getByRole("button", { name: "载入样例", exact: true }).click();
    await page
      .getByLabel("自定义处理", { exact: true })
      .selectOption("ai-test");
    await page.getByRole("button", { name: "执行处理", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "处理完成" }).waitFor();
    await page.getByRole("button", { name: "复制结果", exact: true }).click();
    assert.equal(
      await app.evaluate(({ clipboard }) => clipboard.readText()),
      "公司\t联系人\r\n示例\t张三",
    );
    await page.getByRole("button", { name: "自定义处理", exact: true }).click();
    if (
      await page
        .getByRole("button", { name: "编辑设置", exact: true })
        .isVisible()
    )
      await page.getByRole("button", { name: "编辑设置", exact: true }).click();
    await page.getByRole("button", { name: "新增处理", exact: true }).click();
    await page.getByLabel("处理名称", { exact: true }).fill("界面新建处理");
    await page
      .getByRole("button", { name: /^(保存草稿|保存自定义处理|保存设置)$/ })
      .click();
    await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page
      .getByRole("button", { name: "本地测试服务", exact: false })
      .click();
    assert.equal(
      await page.getByLabel("API Key", { exact: true }).inputValue(),
      "",
    );
    await page.getByRole("button", { name: "处理工作台", exact: true }).click();
  }
  await mkdir("docs/screenshots", { recursive: true });
  await page.mouse.move(600, 40);
  await page.screenshot({ scale: "css", path: "docs/screenshots/工作台.png" });
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  if (
    await page
      .getByRole("button", { name: "编辑设置", exact: true })
      .isVisible()
  )
    await page.getByRole("button", { name: "编辑设置", exact: true }).click();
  await page.mouse.move(600, 40);
  await page.screenshot({
    scale: "css",
    path: "docs/screenshots/方案管理.png",
  });
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await page.mouse.move(600, 40);
  await page.screenshot({
    scale: "css",
    path: "docs/screenshots/模型设置.png",
  });
  assert.deepEqual(errors, []);
  console.log(
    process.env.TEXT_WORKBENCH_LOCAL_ONLY
      ? "桌面本地功能验证通过：脚本处理、精确复制、人工编辑、跨页保留与重跑、离线字体、三页操作。模型与凭据未在本次测试中运行。"
      : "桌面完整验证通过：脚本处理、精确复制、人工编辑、跨页保留与重跑、配置保存、密钥加密及隐藏、模型连接、AI 转换、三页操作。",
  );
} finally {
  if (app) await app.close();
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}
