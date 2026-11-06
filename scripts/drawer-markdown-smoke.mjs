import { _electron as electron } from "playwright";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { LocalKeyVault } = require("../electron/core/local-vault.cjs");
const temp = await mkdtemp(path.join(os.tmpdir(), "copyx-drawer-"));
const code = "function transform(text) { return text; }";
const markdown = [
  "# 处理方案",
  "",
  "**目标**：保持 `transform(text)` 的输入输出一致。",
  "",
  "- 保留换行",
  "- 保留正常引号",
  "",
  "> 先确认方案，再生成脚本。",
  "",
  "| 字段 | 规则 |",
  "| --- | --- |",
  "| 原文 | 逐字符保留 |",
  "",
  "```javascript",
  code,
  "```",
  "",
  "~~旧规则~~",
  "",
  "- [x] 检查空白字符",
  "",
  "[文档链接](https://example.invalid/docs)",
  "[危险链接](javascript:alert(1))",
  "![跟踪图](https://example.invalid/tracker.png)",
  "",
  "<script>window.__drawerInjected = 1</script>",
  '<img src="https://example.invalid/html.png" onerror="window.__drawerInjected=1">',
  "",
  "```text",
  "x".repeat(250),
  "```",
].join("\n");
let requests = 0;
const timers = new Set();
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const plan =
    JSON.parse(body).messages[0].content.includes("CopyX 脚本方案讨论助手");
  requests++;
  const timer = setTimeout(
    () => {
      timers.delete(timer);
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: plan ? markdown : code },
              finish_reason: "stop",
            },
          ],
        }),
      );
    },
    plan ? 800 : 100,
  );
  timers.add(timer);
  res.on("close", () => {
    clearTimeout(timer);
    timers.delete(timer);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const encryptedKey = await new LocalKeyVault(
  path.join(temp, "master.key"),
).encrypt("drawer-local-fixture", "model");
await writeFile(
  path.join(temp, "config.json"),
  JSON.stringify({
    schemes: [
      {
        id: "s",
        name: "抽屉测试",
        kind: "script",
        script: code,
        prompt: "",
        enabled: false,
        shortcutMac: "",
        shortcutWin: "",
        testCases: [],
      },
    ],
    models: [
      {
        id: "model",
        name: "本地 Markdown 测试",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        model: "fixture",
        encryptedKey,
      },
    ],
  }),
);
let app, page;
const errors = [],
  external = [];
async function start() {
  app = await electron.launch({
    executablePath:
      process.env.TEXT_WORKBENCH_EXECUTABLE || require("electron"),
    args: process.env.TEXT_WORKBENCH_EXECUTABLE ? [] : ["."],
    env: { ...process.env, TEXT_WORKBENCH_TEST_DIR: temp },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("request", (r) => {
    if (r.url().startsWith("https://example.invalid")) external.push(r.url());
  });
  await page.getByRole("button", { name: "载入样例", exact: true }).waitFor();
  assert.equal(await page.title(), "CopyX");
  assert(page.url().endsWith("/dist/index.html"));
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
}
const dialog = () =>
  page.getByRole("dialog", { name: "模型对话", exact: true });
async function open() {
  await page
    .getByRole("button", { name: "使用模型生成脚本", exact: true })
    .click();
  await dialog().waitFor();
  await page.waitForFunction(() => {
    const d = document.querySelector("dialog[open]");
    return d && Math.abs(d.getBoundingClientRect().right - innerWidth) < 1;
  });
}
try {
  await start();
  const conf = (await page.evaluate(() => window.desktop.getConfig())).data;
  conf.schemes[0].testCases = [
    {
      id: "one",
      name: "保持文本",
      input: "甲\t乙\r\n",
      expected: "甲\t乙\r\n",
    },
  ];
  assert(
    (await page.evaluate((value) => window.desktop.saveConfig(value), conf)).ok,
  );
  await page.reload();
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  const before = await page.evaluate(() => document.body.style.overflow);
  await open();
  const box = await dialog().boundingBox(),
    viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
  assert(Math.abs(box.x + box.width - viewport.width) < 1);
  assert.equal(Math.round(box.y), 0);
  assert(Math.abs(box.height - viewport.height) < 1);
  assert(await dialog().evaluate((d) => d.contains(document.activeElement)));
  const unsent = "## 保留文本\n**不要改变**空格和换行。";
  await page.getByLabel("处理要求", { exact: true }).fill(unsent);
  await page.keyboard.press("Escape");
  assert(!(await dialog().isVisible()));
  assert.equal(await page.evaluate(() => document.body.style.overflow), before);
  assert(
    await page
      .getByRole("button", { name: "使用模型生成脚本", exact: true })
      .evaluate((el) => el === document.activeElement),
  );
  await open();
  assert.equal(
    await page.getByLabel("处理要求", { exact: true }).inputValue(),
    unsent,
  );
  await page.getByRole("button", { name: "讨论处理方案", exact: true }).click();
  await page.getByRole("button", { name: "取消请求", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭模型对话", exact: true }).click();
  assert(!(await dialog().isVisible()));
  assert(
    !(await page
      .getByRole("button", { name: "使用模型生成脚本", exact: true })
      .isDisabled()),
  );
  await open();
  await page
    .locator(".script-chat .markdown-body h1")
    .filter({ hasText: "处理方案" })
    .waitFor();
  assert.equal(
    await page
      .locator(".script-chat strong")
      .filter({ hasText: "目标" })
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator(".script-chat .markdown-body strong")
      .first()
      .evaluate((el) => getComputedStyle(el).display),
    "inline",
  );
  assert.equal(await page.locator(".script-chat blockquote").count(), 1);
  assert.equal(await page.locator(".script-chat table tbody tr").count(), 1);
  assert.equal(
    await page.locator(".script-chat code.language-javascript").innerText(),
    code + "\n",
  );
  assert.equal(await page.locator(".script-chat del").innerText(), "旧规则");
  assert.equal(
    await page.locator(".script-chat input[type=checkbox][disabled]").count(),
    1,
  );
  assert.equal(
    await page.locator(".script-chat img, .script-chat script").count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.__drawerInjected), undefined);
  assert(
    !(
      (await page
        .getByRole("link", { name: "危险链接", exact: true })
        .getAttribute("href")) || ""
    ).startsWith("javascript:"),
  );
  assert.deepEqual(external, []);
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    assert(await dialog().evaluate((d) => d.contains(document.activeElement)));
  }
  const stored = JSON.parse(
    await readFile(path.join(temp, "script-conversations.json"), "utf8"),
  );
  assert.equal(
    stored.conversations[0].turns.find((t) => t.kind === "plan").content,
    markdown,
  );
  await mkdir("docs/screenshots", { recursive: true });
  await page.locator(".script-chat").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: "docs/screenshots/模型对话抽屉.png",
    scale: "css",
  });
  await page.mouse.click(80, 120);
  assert(!(await dialog().isVisible()));
  await open();
  assert.equal(requests, 1);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1000, 700),
  );
  await page.waitForFunction(() => innerWidth === 1000);
  const narrow = await dialog().boundingBox();
  assert(narrow.width <= 1000);
  assert(Math.abs(narrow.x + narrow.width - 1000) < 1);
  assert(await dialog().evaluate((d) => d.scrollWidth <= d.clientWidth + 1));
  assert(
    await page
      .locator(".script-chat pre")
      .last()
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  );
  await page.screenshot({
    path: "docs/screenshots/模型对话抽屉窄窗口.png",
    scale: "css",
  });
  await page.getByRole("button", { name: "关闭模型对话", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open();
  assert.equal(
    await dialog().evaluate((d) => getComputedStyle(d).animationName),
    "none",
  );
  await app.close();
  await start();
  await open();
  await page
    .locator(".script-chat h1")
    .filter({ hasText: "处理方案" })
    .waitFor();
  assert.equal(requests, 1);
  await page
    .getByRole("button", { name: "确认方案并生成脚本", exact: true })
    .click();
  await page.getByText("生成脚本预览", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "应用到脚本编辑器", exact: true })
    .click();
  assert(!(await dialog().isVisible()));
  await page.getByRole("button", { name: "启用此版本", exact: true }).click();
  await page
    .locator("footer")
    .filter({ hasText: "脚本已通过测试并生效" })
    .waitFor();
  assert.equal(requests, 2);
  assert.deepEqual(errors, []);
  console.log(
    "右侧抽屉和 Markdown 验证通过：靠右全高、打开动画、窄窗口、焦点限制与恢复、Esc/遮罩/按钮关闭、请求中关闭重开、输入与历史保留、应用后收起、标题列表表格引用代码块、原文持久化、危险 HTML/链接与远程图片隔离；原有确认和测试门禁有效。",
  );
} finally {
  if (app) await app.close();
  for (const t of timers) clearTimeout(t);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}
