import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const temp = await mkdtemp(path.join(os.tmpdir(), "copyx-scheme-share-"));
const userData = path.join(temp, "data");
const withTests = path.join(temp, "with-tests.copyx.json");
const withoutTests = path.join(temp, "without-tests.copyx.json");
const aiPath = path.join(temp, "ai.copyx.json");
const invalidPath = path.join(temp, "invalid.copyx.json");
const script = "function transform(text) { return text; }";
const testCases = [
  { id: "one", name: "原样返回", input: "甲\t乙\r\n", expected: "甲\t乙\r\n" },
];
const sharedKey = "Control+Alt+Shift+F17";
let app, page;
const errors = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const footer = (text) => page.locator("footer").filter({ hasText: text });
const config = () =>
  page.evaluate(async () => (await window.desktop.getConfig()).data);
async function selectFiles({ input, output, include = false } = {}) {
  await app.evaluate(
    ({ dialog }, values) => {
      dialog.showOpenDialog = async () => ({
        canceled: !values.input,
        filePaths: values.input ? [values.input] : [],
      });
      dialog.showSaveDialog = async () => ({
        canceled: !values.output,
        filePath: values.output,
      });
      dialog.showMessageBox = async (_parent, options) => {
        if (options.checkboxChecked || options.checkboxLabel !== "包含测试用例")
          throw new Error("分享测试用例必须由用户主动勾选");
        return { response: 0, checkboxChecked: values.include };
      };
    },
    { input, output, include },
  );
}
async function start() {
  const executable = process.env.TEXT_WORKBENCH_EXECUTABLE;
  app = await electron.launch({
    executablePath: executable || require("electron"),
    args: executable ? [] : ["."],
    env: { ...process.env, TEXT_WORKBENCH_TEST_DIR: userData },
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
    path.join(userData, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      schemes: [
        {
          id: "source",
          name: "文本清理",
          kind: "script",
          script,
          prompt: "",
          testCases,
          enabled: true,
          shortcutMac: "",
          shortcutWin: "",
          activeScript: { status: "legacy", script, testCases: [] },
        },
      ],
      models: [],
      aiShortcut: { enabled: true, shortcutMac: sharedKey, shortcutWin: "" },
    }),
  );
  await writeFile(
    aiPath,
    JSON.stringify({
      format: "copyx.custom-processing",
      version: 1,
      scheme: {
        name: "AI 转表格",
        kind: "ai",
        prompt: "转成表格\r\n",
        modelId: "foreign",
        apiKey: "foreign-key",
        shortcutMac: sharedKey,
        enabled: true,
      },
    }),
  );
  await writeFile(invalidPath, "错误文件");
  await start();
  await button("自定义处理").click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1000, 700),
  );
  await page.waitForFunction(() => innerWidth === 1000);
  assert(
    await page
      .locator(".item-list-actions")
      .evaluate((row) =>
        [...row.querySelectorAll("button")].every(
          (item) =>
            item.getBoundingClientRect().right <=
            row.getBoundingClientRect().right + 1,
        ),
      ),
  );
  await selectFiles({ output: withoutTests });
  await button("分享").click();
  await footer("分享文件已保存").waitFor();
  assert.deepEqual(JSON.parse(await readFile(withoutTests, "utf8")).scheme, {
    name: "文本清理",
    kind: "script",
    script,
    testCases: [],
  });
  await selectFiles({ output: withTests, include: true });
  await button("分享").click();
  await footer("分享文件已保存").waitFor();
  assert.deepEqual(
    JSON.parse(await readFile(withTests, "utf8")).scheme.testCases,
    testCases,
  );

  await selectFiles();
  await button("导入处理").click();
  await footer("已取消导入").waitFor();
  assert.equal(await page.locator(".item-list .item").count(), 1);
  await selectFiles({ input: invalidPath });
  await button("导入处理").click();
  await footer("无法读取分享文件").waitFor();
  assert.equal(await page.locator(".item-list .item").count(), 1);
  await selectFiles({ input: withTests });
  await button("导入处理").click();
  await footer("已导入脚本草稿").waitFor();
  assert.equal(
    await page.getByLabel("处理名称", { exact: true }).inputValue(),
    "文本清理（导入）",
  );
  assert.equal((await config()).schemes.length, 1);
  await button("保存草稿").click();
  await footer("配置已保存").waitFor();
  const draft = (await config()).schemes.find((item) => item.id !== "source");
  assert.deepEqual(draft.testCases, testCases);
  assert.equal(draft.activeScript, undefined);
  assert.equal(draft.enabled, false);
  const blocked = await page.evaluate(
    (id) => window.desktop.run({ schemeId: id, text: "测试" }),
    draft.id,
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /尚未生效/);
  await button("运行全部测试").click();
  await page
    .locator(".test-summary")
    .filter({ hasText: "全部通过：1/1" })
    .waitFor();
  await button("启用此版本").click();
  await footer("脚本已通过测试并生效").waitFor();
  assert.equal(
    (await config()).schemes.find((item) => item.id === draft.id).activeScript
      .status,
    "verified",
  );

  await selectFiles({
    input: aiPath,
    output: path.join(temp, "ai-reexport.copyx.json"),
  });
  await button("导入处理").click();
  await footer("已导入 AI 处理草稿").waitFor();
  assert.equal(
    await page.getByLabel("模型配置", { exact: true }).inputValue(),
    "",
  );
  await button("分享").click();
  await footer("分享文件已保存").waitFor();
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(temp, "ai-reexport.copyx.json"), "utf8"),
    ).scheme,
    { name: "AI 转表格", kind: "ai", prompt: "转成表格\r\n" },
  );
  await page
    .getByRole("button", { name: /^(保存草稿|保存自定义处理|保存设置)$/ })
    .click();
  await footer("配置已保存").waitFor();
  const ai = (await config()).schemes.find((item) => item.kind === "ai");
  assert.equal(ai.modelId, undefined);
  assert.equal(ai.enabled, false);
  assert(
    !(await app.evaluate(
      ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
      sharedKey,
    )),
  );
  const noModel = await page.evaluate(
    (id) => window.desktop.runPrompt({ schemeId: id, text: "测试" }),
    ai.id,
  );
  assert.equal(noModel.ok, false);
  assert.match(noModel.error, /选择模型/);
  await app.close();
  await start();
  const restored = await config();
  assert.equal(restored.schemes.length, 3);
  assert.equal(
    restored.schemes.find((item) => item.id === ai.id).prompt,
    "转成表格\r\n",
  );
  assert.equal(
    restored.schemes.find((item) => item.id === "source").activeScript.status,
    "legacy",
  );
  assert.deepEqual(errors, []);
  console.log(
    "分享与导入桌面验证通过：可选用例、取消和错误保护、同名草稿、本机测试生效、AI 无模型保存、无快捷键注册、重启保留。",
  );
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
