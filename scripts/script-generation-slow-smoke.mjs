import { _electron as electron } from "playwright";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { LocalKeyVault } = require("../electron/core/local-vault.cjs");
const expectedTimeout = process.argv.includes("--expect-timeout");
const delay = 61200;
const timers = new Set();
let requests = 0;
const code = "function transform(text) { return text; }";
const temp = await mkdtemp(path.join(os.tmpdir(), "copyx-slow-generation-"));
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests++;
  if (JSON.parse(body).messages[0].content.includes("CopyX 脚本方案讨论助手")) {
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "方案：保持所有字符和换行原样。" } }],
      }),
    );
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    res.end(
      JSON.stringify({
        choices: [{ message: { content: code }, finish_reason: "stop" }],
      }),
    );
  }, delay);
  timers.add(timer);
  res.on("close", () => {
    clearTimeout(timer);
    timers.delete(timer);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const encryptedKey = await new LocalKeyVault(
  path.join(temp, "master.key"),
).encrypt("synthetic-key", "local");
await writeFile(
  path.join(temp, "config.json"),
  JSON.stringify({
    schemes: [],
    models: [
      {
        id: "local",
        name: "本地慢响应测试",
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        model: "fixture",
        encryptedKey,
      },
    ],
  }),
);
let app;
try {
  app = await electron.launch({
    executablePath:
      process.env.TEXT_WORKBENCH_EXECUTABLE || require("electron"),
    args: process.env.TEXT_WORKBENCH_EXECUTABLE ? [] : ["."],
    env: { ...process.env, TEXT_WORKBENCH_TEST_DIR: temp },
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "载入样例", exact: true }).waitFor();
  const version = await app.evaluate(({ app }) => app.getVersion());
  let input = {
    requestId: "slow-first",
    schemeId: "draft",
    modelId: "local",
    instructions: "保持原样",
    script: code,
    testCases: [
      {
        id: "identity",
        name: "保持原样",
        input: "甲\t乙\r\n",
        expected: "甲\t乙\r\n",
      },
    ],
    includeTestCases: false,
  };
  async function prepare(input, conversationId) {
    return page.evaluate(
      async ({ input, conversationId }) => {
        if (typeof window.desktop.discussScript !== "function") return input;
        const plan = await window.desktop.discussScript({
          ...input,
          requestId: crypto.randomUUID(),
          conversationId,
          message: "保持原样",
        });
        if (!plan.ok) throw new Error(plan.error);
        return {
          ...input,
          conversationId: plan.data.id,
          planId: plan.data.plan.id,
        };
      },
      { input, conversationId },
    );
  }
  input = await prepare(input);
  const started = Date.now();
  const response = await page.evaluate(
    (input) => window.desktop.generateScript(input),
    input,
  );
  const elapsedMs = Date.now() - started;
  if (expectedTimeout) {
    assert(!response.ok);
    assert.match(response.error, /模型请求超时/);
    assert(elapsedMs >= 59000 && elapsedMs < 61000);
  } else {
    assert(response.ok, response.error);
    assert.equal(response.data.script, code);
    assert(response.data.report.passed);
    assert(elapsedMs >= delay);
    input = await prepare(input, response.data.conversation?.id);
    const cancelStart = Date.now();
    const cancelled = await page.evaluate(async (input) => {
      const pending = window.desktop.generateScript({
        ...input,
        requestId: "slow-cancel",
      });
      setTimeout(
        () => window.desktop.cancelScriptGeneration("slow-cancel"),
        150,
      );
      return pending;
    }, input);
    assert(!cancelled.ok && /取消/.test(cancelled.error));
    assert(Date.now() - cancelStart < 3000);
  }
  const report = {
    version,
    serverDelayMs: delay,
    elapsedMs,
    expectedTimeout,
    cancelVerified: !expectedTimeout,
    requests,
    passed: true,
  };
  if (process.env.COPYX_SLOW_REPORT)
    await writeFile(
      process.env.COPYX_SLOW_REPORT,
      JSON.stringify(report, null, 2) + "\n",
    );
  console.log("慢模型请求实测通过：" + JSON.stringify(report));
} finally {
  if (app) await app.close();
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
