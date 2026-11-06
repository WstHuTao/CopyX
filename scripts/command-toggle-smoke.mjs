import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const temp = await mkdtemp(path.join(tmpdir(), "copyx-toggle-"));
let app;
async function launch() {
  app = await electron.launch({
    args: [path.resolve("electron/main.cjs")],
    env: { ...process.env, TEXT_WORKBENCH_TEST_DIR: temp },
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "自定义处理", exact: true }).click();
  await page.getByRole("switch", { name: "启用指令" }).waitFor();
  return page;
}
try {
  let page = await launch();
  const toggle = page.getByRole("switch", { name: "启用指令" });
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await page.getByRole("status").filter({ hasText: "指令已禁用" }).waitFor();
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.equal(await page.locator("header").getByText("设置已保存").count(), 1);
  assert.equal(
    await page.getByText("有未保存修改", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByText("指令暂停时不响应快捷键，也不可手动执行").count(),
    0,
  );
  const disabled = await page.evaluate(async () => {
    const config = (await window.desktop.getConfig()).data;
    return {
      config,
      run: await window.desktop.run({
        schemeId: config.schemes[0].id,
        text: "暂停测试",
      }),
    };
  });
  assert.equal(disabled.config.schemes[0].disabled, true);
  assert.equal(disabled.config.schemes[0].enabled, true);
  assert.equal(disabled.run.ok, false);
  assert.match(disabled.run.error, /已禁用/);
  assert.equal(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered("Command+Shift+1"),
    ),
    false,
  );
  await page.getByRole("button", { name: "处理工作台", exact: true }).click();
  await page.getByRole("button", { name: "载入样例", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "执行处理", exact: true })
      .isDisabled(),
    true,
  );
  await app.close();
  page = await launch();
  assert.equal(
    await page
      .getByRole("switch", { name: "启用指令" })
      .getAttribute("aria-checked"),
    "false",
  );
  await page.getByRole("button", { name: "编辑设置", exact: true }).click();
  const name = page.getByLabel("处理名称", { exact: true });
  await name.fill("未保存的名称");
  const editor = page.getByRole("textbox", { name: "处理脚本编辑器" });
  await editor.focus();
  await page.keyboard.press("Meta+A");
  await page.keyboard.insertText(
    "function transform(text) { return text + '草稿'; }",
  );
  await page.getByRole("switch", { name: "启用指令" }).click();
  await page.getByRole("status").filter({ hasText: "指令已启用" }).waitFor();
  assert.equal(await name.inputValue(), "未保存的名称");
  assert.equal(
    await page.locator("header").getByText("有未保存修改").count(),
    1,
  );
  const storedName = await page.evaluate(
    async () => (await window.desktop.getConfig()).data.schemes[0].name,
  );
  assert.equal(storedName, disabled.config.schemes[0].name);
  assert.match(
    await page.locator(".script-editor .view-lines").textContent(),
    /草稿/,
  );
  assert.equal(
    await page.evaluate(
      async () => (await window.desktop.getConfig()).data.schemes[0].script,
    ),
    disabled.config.schemes[0].script,
  );
  // 模拟键位被占用，确认保存失败不会把开关误标为已启用。
  await page.getByRole("switch", { name: "启用指令" }).click();
  await page.getByRole("status").filter({ hasText: "指令已禁用" }).waitFor();
  assert.equal(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.register("Command+Shift+1", () => {}),
    ),
    true,
  );
  await page.getByRole("switch", { name: "启用指令" }).click();
  await page
    .locator("footer[role='status']")
    .filter({ hasText: /冲突|占用|注册/ })
    .waitFor();
  assert.equal(
    await page
      .getByRole("switch", { name: "启用指令" })
      .getAttribute("aria-checked"),
    "false",
  );
  assert.equal(
    (
      await page.evaluate(
        async () => (await window.desktop.getConfig()).data.schemes[0],
      )
    ).disabled,
    true,
  );
  assert.equal(await name.inputValue(), "未保存的名称");
  await app.evaluate(({ globalShortcut }) =>
    globalShortcut.unregister("Command+Shift+1"),
  );
  await page.getByRole("switch", { name: "启用指令" }).click();
  await page.getByRole("status").filter({ hasText: "指令已启用" }).waitFor();
  const enabled = await page.evaluate(async () => {
    const config = (await window.desktop.getConfig()).data;
    const scheme = config.schemes[0];
    const run = await window.desktop.run({
      schemeId: scheme.id,
      text: "恢复测试",
    });
    config.schemes.push({
      ...scheme,
      id: "paused-ai",
      kind: "ai",
      disabled: true,
      activeScript: undefined,
    });
    const saved = await window.desktop.saveConfig(config);
    const ai = await window.desktop.runPrompt({
      schemeId: "paused-ai",
      text: "不能发送",
    });
    return { scheme, run, saved, ai };
  });
  assert.equal(enabled.scheme.disabled, false);
  assert.equal(enabled.run.data, "恢复测试");
  assert.deepEqual(
    enabled.scheme.activeScript,
    disabled.config.schemes[0].activeScript,
  );
  assert.equal(enabled.saved.ok, true);
  assert.equal(enabled.ai.ok, false);
  assert.match(enabled.ai.error, /已禁用/);
  assert.equal(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered("Command+Shift+1"),
    ),
    true,
  );
  const persisted = JSON.parse(
    await readFile(path.join(temp, "config.json"), "utf8"),
  );
  assert.equal(
    persisted.schemes.find((s) => s.id === "paused-ai").disabled,
    true,
  );
  await page.getByRole("button", { name: "新增处理", exact: true }).click();
  assert.equal(
    await page.getByRole("switch", { name: "启用指令" }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("switch", { name: "启用指令" }).textContent(),
    "未保存",
  );
  console.log(
    "指令开关验证通过：立即保存、无虚假未保存提示、其他草稿不提交且不丢失、冲突失败保持原状态、重启保留、后台拦截和快捷键恢复。",
  );
} finally {
  await app?.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
