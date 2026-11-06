import {
  discussThenGenerate,
  latestDiscussion,
} from "./script-conversation-test-helpers.mjs";
import { _electron as electron } from "playwright";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { LocalKeyVault } = require("../electron/core/local-vault.cjs");
const temp = await mkdtemp(path.join(os.tmpdir(), "copyx-test-suite-ui-"));
const executablePath =
  process.env.TEXT_WORKBENCH_EXECUTABLE || require("electron");
const identity = "function transform(text) { return text; }";
const code = 'function transform(text) { return text.replace(/,/g, "\\t"); }';
const requests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const messages = JSON.parse(body).messages;
  const input = latestDiscussion(messages);
  requests.push(JSON.stringify(messages));
  if (messages[0].content.includes("CopyX 脚本方案讨论助手")) {
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "处理方案：转换逗号为制表符，保留换行和空字段。",
            },
          },
        ],
      }),
    );
    return;
  }
  const source = input.includes("总超时")
    ? "function transform(text){while(true){}}"
    : input.includes("错误结果")
      ? "function transform(text) { return text.toUpperCase(); }"
      : code;
  res.end(
    JSON.stringify({
      choices: [{ message: { content: source }, finish_reason: "stop" }],
    }),
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const encryptedKey = await new LocalKeyVault(
  path.join(temp, "master.key"),
).encrypt("local-fixture-key", "model");
await writeFile(
  path.join(temp, "config.json"),
  JSON.stringify({
    schemes: [
      {
        id: "legacy",
        name: "旧处理",
        kind: "script",
        script: identity,
        prompt: "",
        enabled: false,
        shortcutMac: "",
        shortcutWin: "",
      },
    ],
    models: [
      {
        id: "model",
        name: "本地测试模型",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        model: "fixture",
        encryptedKey,
      },
    ],
  }),
);
let app, page;
const errors = [];
const config = async () => {
  const r = await page.evaluate(() => window.desktop.getConfig());
  assert(r.ok, r.error);
  return r.data;
};
const run = async (text) =>
  page.evaluate(
    (text) => window.desktop.run({ schemeId: "legacy", text }),
    text,
  );
async function start() {
  app = await electron.launch({
    executablePath,
    args: process.env.TEXT_WORKBENCH_EXECUTABLE ? [] : ["."],
    env: { ...process.env, TEXT_WORKBENCH_TEST_DIR: temp },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.getByRole("button", { name: "载入样例", exact: true }).waitFor();
}
async function saveDraft() {
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.locator("footer").filter({ hasText: "配置已保存" }).waitFor();
}
async function setScript(source) {
  const reopen = await page
    .getByRole("dialog", { name: "模型对话", exact: true })
    .isVisible();
  if (reopen)
    await page
      .getByRole("button", { name: "关闭模型对话", exact: true })
      .click();
  await page.getByRole("tab", { name: "处理脚本", exact: true }).click();
  await page
    .locator(".script-editor .view-lines")
    .click({ position: { x: 90, y: 10 } });
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText(source);
  if (reopen)
    await page
      .getByRole("button", { name: "使用模型生成脚本", exact: true })
      .click();
}
try {
  await start();
  assert.equal((await config()).schemes[0].activeScript.status, "legacy");
  assert.equal((await run("甲,乙")).data, "甲,乙");
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  await page
    .getByText("请先在测试集中添加至少 1 条用例", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "使用模型生成脚本", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("tab", { name: /^测试集/ })
      .getAttribute("aria-selected"),
    "true",
  );
  assert(!(await page.getByRole("dialog", { name: "模型对话" }).isVisible()));
  await page.getByRole("button", { name: "添加测试用例", exact: true }).click();
  assert.equal(
    await page
      .getByText("请先在测试集中添加至少 1 条用例", { exact: true })
      .count(),
    0,
  );
  await page.getByLabel("用例名称", { exact: true }).fill("多行与空字段");
  await page.getByLabel("测试输入", { exact: true }).fill("甲,乙\n1,,3");
  await page.getByLabel("预期输出", { exact: true }).fill("甲\t乙\n1\t\t3");
  await page.getByRole("button", { name: "添加测试用例", exact: true }).click();
  await page.getByLabel("用例名称", { exact: true }).fill("空字符串");
  await saveDraft();
  assert.equal((await config()).schemes[0].testCases.length, 2);
  await page
    .getByRole("button", { name: "使用模型生成脚本", exact: true })
    .click();
  await page
    .getByLabel("处理要求", { exact: true })
    .fill("错误结果测试：将逗号替换为制表符");
  await page.getByRole("button", { name: "讨论处理方案", exact: true }).click();
  await page
    .getByRole("button", { name: "确认方案并生成脚本", exact: true })
    .waitFor({ state: "visible" });
  await page
    .locator(".plan-confirmation button:not(:disabled)")
    .filter({ hasText: "确认方案并生成脚本" })
    .waitFor();
  const firstPlan = (
    await page.evaluate(() => window.desktop.getScriptConversation("legacy"))
  ).data.conversation.plan.id;
  assert.equal(requests.length, 1, "只讨论方案时不能发起脚本生成请求");
  await page
    .getByLabel("处理要求", { exact: true })
    .fill("补充：仍使用错误结果测试，保留原有换行和空字段。");
  assert(
    await page
      .getByRole("button", { name: "确认方案并生成脚本", exact: true })
      .isDisabled(),
  );
  await page.getByRole("button", { name: "发送补充意见", exact: true }).click();
  await page
    .locator(".plan-confirmation button:not(:disabled)")
    .filter({ hasText: "确认方案并生成脚本" })
    .waitFor();
  assert.notEqual(
    (await page.evaluate(() => window.desktop.getScriptConversation("legacy")))
      .data.conversation.plan.id,
    firstPlan,
  );
  assert(requests[1].includes("assistant"));
  await mkdir("docs/screenshots", { recursive: true });
  await page.locator(".script-chat").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "docs/screenshots/脚本方案对话.png",
    scale: "css",
  });
  const savedPlan = (
    await page.evaluate(() => window.desktop.getScriptConversation("legacy"))
  ).data.conversation.plan.id;
  await app.close();
  await start();
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  await page
    .getByRole("button", { name: "使用模型生成脚本", exact: true })
    .click();
  await page
    .locator(".plan-confirmation button:not(:disabled)")
    .filter({ hasText: "确认方案并生成脚本" })
    .waitFor();
  assert.equal(
    (await page.evaluate(() => window.desktop.getScriptConversation("legacy")))
      .data.conversation.plan.id,
    savedPlan,
  );
  await setScript(identity + "\n// 临时修改草稿以验证恢复");
  assert(
    await page
      .getByRole("button", { name: "确认方案并生成脚本", exact: true })
      .isDisabled(),
  );
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await page.getByRole("button", { name: "恢复会话草稿", exact: true }).click();
  await page
    .locator(".plan-confirmation button:not(:disabled)")
    .filter({ hasText: "确认方案并生成脚本" })
    .waitFor();
  await page
    .getByRole("button", { name: "确认方案并生成脚本", exact: true })
    .click();

  await page
    .locator(".generated-preview .test-summary")
    .filter({ hasText: "测试未通过" })
    .waitFor();
  assert(requests[0].includes("甲,乙"));
  assert(requests[0].includes("多行与空字段"));
  await page
    .getByRole("button", { name: "应用到脚本编辑器", exact: true })
    .click();
  assert(
    await page
      .getByRole("button", { name: "启用此版本", exact: true })
      .isDisabled(),
  );
  await saveDraft();
  assert.equal((await run("甲,乙")).data, "甲,乙");
  const bypass = await page.evaluate(() =>
    window.desktop.activateScript({
      schemeId: "legacy",
      fingerprint: "forged",
    }),
  );
  assert(!bypass.ok);
  await mkdir("docs/screenshots", { recursive: true });
  await page
    .locator(".script-settings .settings-actions")
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "docs/screenshots/脚本测试失败.png",
    scale: "css",
  });
  await app.close();
  await start();
  const restoredConversation = await page.evaluate(() =>
    window.desktop.getScriptConversation("legacy"),
  );
  assert(
    restoredConversation.data.conversation.turns.some((t) =>
      t.content.includes("补充：仍使用错误结果测试"),
    ),
  );
  assert(
    restoredConversation.data.conversation.generated.script.includes(
      "toUpperCase",
    ),
  );
  const persisted = await config();
  assert.equal(persisted.schemes[0].testCases.length, 2);
  assert(persisted.schemes[0].script.includes("toUpperCase"));
  assert.equal((await run("甲,乙")).data, "甲,乙");
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  await page
    .getByRole("button", { name: "使用模型生成脚本", exact: true })
    .click();
  await page
    .getByLabel("处理要求", { exact: true })
    .fill("正确生成：将逗号替换为制表符");
  await discussThenGenerate(page);
  await page
    .locator(".generated-preview .test-summary")
    .filter({ hasText: "全部通过：2/2" })
    .waitFor();
  assert(requests[3].includes("甲,乙"));
  assert(requests[3].includes("toUpperCase"));
  await setScript(persisted.schemes[0].script + "\n// 修改当前原稿后继续讨论");
  await page
    .getByLabel("处理要求", { exact: true })
    .fill("请参考刚才生成的代码和测试结果复核方案");
  await page.getByRole("button", { name: "发送补充意见", exact: true }).click();
  await page
    .locator(".plan-confirmation button:not(:disabled)")
    .filter({ hasText: "确认方案并生成脚本" })
    .waitFor();
  await page.evaluate(() => {
    window.confirm = () => true;
  });

  await page
    .getByRole("button", { name: "应用到脚本编辑器", exact: true })
    .click();
  assert(
    await page
      .getByRole("button", { name: "启用此版本", exact: true })
      .isDisabled(),
  );
  await page.getByRole("button", { name: "运行全部测试", exact: true }).click();
  await page
    .locator(".script-settings .test-results .test-summary")
    .filter({ hasText: "全部通过：2/2" })
    .waitFor();
  await page.getByRole("button", { name: "启用此版本", exact: true }).click();
  await page
    .locator("footer")
    .filter({ hasText: "脚本已通过测试并生效" })
    .waitFor();
  const activated = (await config()).schemes[0];
  assert.equal(activated.activeScript.status, "verified");
  assert.equal((await run("甲,乙\n1,,3")).data, "甲\t乙\n1\t\t3");
  assert.equal(requests.length, 6);
  await setScript(code + "\n// 人工修改后的草稿");
  assert(
    await page
      .getByRole("button", { name: "启用此版本", exact: true })
      .isDisabled(),
  );
  await saveDraft();
  const stale = await page.evaluate(
    (fp) =>
      window.desktop.activateScript({ schemeId: "legacy", fingerprint: fp }),
    activated.activeScript.fingerprint,
  );
  assert(!stale.ok);
  assert.equal((await run("甲,乙")).data, "甲\t乙");
  await page.getByRole("button", { name: "运行全部测试", exact: true }).click();
  await page
    .locator(".script-settings .test-results .test-summary")
    .filter({ hasText: "全部通过：2/2" })
    .waitFor();
  await page.getByRole("button", { name: "启用此版本", exact: true }).click();
  await page
    .locator("footer")
    .filter({ hasText: "脚本已通过测试并生效" })
    .waitFor();
  await page
    .locator(".script-settings .settings-actions")
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "docs/screenshots/脚本测试通过.png",
    scale: "css",
  });
  await setScript("function transform(text){while(true){}}");
  await page.getByRole("button", { name: "运行全部测试", exact: true }).click();
  await page.getByRole("button", { name: "取消测试", exact: true }).waitFor();
  assert(
    await page
      .getByRole("button", { name: "使用模型生成脚本", exact: true })
      .isDisabled(),
  );
  assert(
    !(await page
      .getByRole("dialog", { name: "模型对话", exact: true })
      .isVisible()),
  );
  await page.getByRole("button", { name: "取消测试", exact: true }).click();
  await page.locator("footer").filter({ hasText: "测试已取消" }).waitFor();
  assert(
    !(await page
      .getByRole("button", { name: "使用模型生成脚本", exact: true })
      .isDisabled()),
  );
  const cancellation = await page.evaluate(async () => {
    const id = crypto.randomUUID();
    const pending = window.desktop.testScript({
      requestId: id,
      schemeId: "legacy",
      script: "function transform(text){while(true){}}",
      testCases: [{ id: "loop", name: "取消", input: "", expected: "" }],
    });
    await window.desktop.cancelScriptTests("unrelated");
    setTimeout(() => window.desktop.cancelScriptTests(id), 100);
    return pending;
  });
  assert(!cancellation.ok && /取消/.test(cancellation.error));
  await page.getByRole("button", { name: "新增处理", exact: true }).click();
  await page.getByLabel("处理名称", { exact: true }).fill("未验证的新处理");
  await saveDraft();
  const fresh = (await config()).schemes.find(
    (s) => s.name === "未验证的新处理",
  );
  assert(!fresh.activeScript);
  const unverified = await page.evaluate(
    (id) => window.desktop.run({ schemeId: id, text: "不能运行草稿" }),
    fresh.id,
  );
  assert(!unverified.ok);
  await page.getByRole("button", { name: "处理工作台", exact: true }).click();
  await page.getByLabel("自定义处理", { exact: true }).selectOption(fresh.id);
  assert(
    await page
      .getByRole("button", { name: "执行处理", exact: true })
      .isDisabled(),
  );
  const pendingShortcut = "Control+Alt+Shift+F18";
  const shortcutDraft = await config();
  shortcutDraft.schemes.find((s) => s.id === fresh.id).shortcutMac =
    pendingShortcut;
  assert(
    (
      await page.evaluate(
        (value) => window.desktop.saveConfig(value),
        shortcutDraft,
      )
    ).ok,
  );
  await page.evaluate(() => window.desktop.beginShortcutRecording());
  await page.evaluate(() => window.desktop.endShortcutRecording());
  assert(
    !(await app.evaluate(
      ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
      pendingShortcut,
    )),
  );
  const timeoutSetup = await page.evaluate(async (id) => {
    const saved = (await window.desktop.getConfig()).data;
    saved.schemes.find((s) => s.id === id).testCases = Array.from(
      { length: 10 },
      (_, i) => ({
        id: `timeout-${i}`,
        name: `超时样例 ${i + 1}`,
        input: "",
        expected: "",
      }),
    );
    return window.desktop.saveConfig(saved);
  }, fresh.id);
  assert(timeoutSetup.ok);
  await page.reload();
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  await page
    .locator(".item-list button.item")
    .filter({ hasText: "未验证的新处理" })
    .click();
  await page
    .getByRole("button", { name: "使用模型生成脚本", exact: true })
    .click();
  await page
    .getByLabel("处理要求", { exact: true })
    .fill("总超时测试：生成循环脚本");
  await discussThenGenerate(page);
  await page
    .locator(".generated-preview .test-summary")
    .filter({ hasText: "测试集执行超时" })
    .waitFor({ timeout: 30000 });
  await page
    .getByRole("button", { name: "应用到脚本编辑器", exact: true })
    .click();
  assert(
    await page
      .getByRole("button", { name: "启用此版本", exact: true })
      .isDisabled(),
  );
  await saveDraft();
  assert(
    (await config()).schemes
      .find((s) => s.id === fresh.id)
      .script.includes("while(true)"),
  );
  await app.close();
  await start();
  assert.equal((await run("甲,乙")).data, "甲\t乙");
  assert(
    (await config()).schemes
      .find((s) => s.id === fresh.id)
      .script.includes("while(true)"),
  );
  assert.equal(requests.length, 8);
  await app.close();
  const historyFile = path.join(temp, "script-conversations.json");
  const damaged = JSON.parse(await readFile(historyFile, "utf8"));
  delete damaged.conversations.find((c) => c.schemeId === "legacy").context;
  const damagedBytes = JSON.stringify(damaged);
  await writeFile(historyFile, damagedBytes);
  await start();
  const protectedHistory = await page.evaluate(() =>
    window.desktop.getScriptConversation("legacy"),
  );
  assert(!protectedHistory.ok && /历史对话格式/.test(protectedHistory.error));
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  await page
    .getByRole("button", { name: "使用模型生成脚本", exact: true })
    .click();
  await page
    .locator(".generator-message.error")
    .filter({ hasText: "历史对话格式" })
    .waitFor();
  assert(
    await page
      .getByRole("button", { name: "讨论处理方案", exact: true })
      .isDisabled(),
  );
  await page
    .getByRole("button", { name: "重新开始对话", exact: true })
    .waitFor();
  assert.equal(await readFile(historyFile, "utf8"), damagedBytes);
  assert.equal((await run("甲,乙")).data, "甲\t乙");
  assert.deepEqual(errors, []);

  console.log(
    "脚本测试集桌面验证通过：旧版兼容、用例编辑与重启保留、错误生成自动测试、失败差异、已有脚本与测试上下文发送、多轮方案确认后生成、对话与代码预览重启恢复、后台防绕过、通过后生效、手改失效、旧版本继续运行、手动重测、运行中取消、新草稿不可用、外部忙状态禁止生成、整套超时保留代码、待生效快捷键不注册、生效版本重启保留、损坏业务历史不影响界面与处理、继续讨论后旧预览需重测；模型请求均为本地测试服务。",
  );
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}
