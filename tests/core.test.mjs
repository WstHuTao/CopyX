import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { runScript } = require("../electron/core/script.cjs");
const { runAI, endpointFor } = require("../electron/core/ai.cjs");
const { validateConfig, publicConfig } = require("../electron/core/config.cjs");
const {
  checkCapturePermission,
  validateCapture,
} = require("../electron/core/capture.cjs");

test(
  "权限检查只调用取文程序的检测模式，并区分拒绝与检测失败",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "copyx-permission-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const helper = join(dir, "capture-mac");
    for (const allowed of [false, true]) {
      await writeFile(
        helper,
        `#!/bin/sh\n[ "$1" = "--check-permission" ] || exit 1\nprintf '{"allowed":${allowed}}'\n`,
        { mode: 0o700 },
      );
      assert.equal(await checkCapturePermission(helper), allowed);
    }
    await writeFile(helper, "#!/bin/sh\nprintf '{}'\n");
    await assert.rejects(
      checkCapturePermission(helper),
      /无法检查辅助功能权限/,
    );
  },
);

test("脚本保留引号、空格、制表符、换行与中文字符", async () => {
  const input = '  "客户"\t金额\r\n😀  ';
  assert.equal(
    await runScript(input, "function transform(text) { return text; }"),
    input,
  );
  assert.equal(
    await runScript(
      "a",
      "function transform(text) { return text.toUpperCase(); }",
    ),
    "A",
  );
});
test("脚本死循环可以超时终止且后续任务继续执行", async () => {
  await assert.rejects(
    runScript("a", "function transform(text) { while(true) {} }", {
      timeout: 100,
    }),
    /超时/,
  );
  assert.equal(
    await runScript("a", "function transform(text) { return text; }"),
    "a",
  );
});
test("脚本不能读取系统环境或返回非文本", async () => {
  await assert.rejects(
    runScript("", "function transform(text) { return process.env.HOME; }"),
    /process/,
  );
  await assert.rejects(
    runScript("", "function transform(text) { return 1; }"),
    /字符串/,
  );
  await assert.rejects(
    runScript(
      "",
      'function transform(text) { return typeof fetch === "function" ? "泄漏" : 1; }',
    ),
    /字符串/,
  );
});
test("接口地址接受服务根目录与完整请求路径", () => {
  assert.equal(
    endpointFor("https://example.com/v1/"),
    "https://example.com/v1/chat/completions",
  );
  assert.equal(
    endpointFor("https://example.com/v1/chat/completions"),
    "https://example.com/v1/chat/completions",
  );
  assert.throws(() => endpointFor("file:///tmp/key"), /地址/);
  assert.throws(
    () => endpointFor("https://user:password@example.com/v1"),
    /地址/,
  );
});
test("AI 调用向本地真实服务传递提示词并精确保留输出", async (t) => {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    const data = JSON.parse(body);
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(data.messages[0].content, "转成表格");
    assert.equal(data.messages[1].content, "原文");
    assert.equal(
      req.headers.authorization,
      "Bearer 测试密钥".replace("测试密钥", "test-key"),
    );
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ choices: [{ message: { content: " A\tB\r\n " } }] }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  assert.equal(
    await runAI("原文", "转成表格", {
      baseUrl,
      model: "test",
      apiKey: "test-key",
    }),
    " A\tB\r\n ",
  );
});
test("AI 请求可以取消且错误不泄露密钥", async (t) => {
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(401);
      res.end("secret-value");
    }, 500);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const model = {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: "x",
    apiKey: "secret-value",
  };
  const controller = new AbortController();
  const promise = runAI("a", "b", model, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, /取消/);
  await assert.rejects(
    runAI("a", "b", model),
    (e) => /401/.test(e.message) && !e.message.includes("secret-value"),
  );
});
test("配置拒绝重复标识、失效模型引用并隐藏密钥", () => {
  const config = {
    schemes: [
      {
        id: "s",
        name: "清理",
        kind: "script",
        script: "",
        prompt: "",
        enabled: true,
        shortcutMac: "",
        shortcutWin: "",
      },
    ],
    models: [],
  };
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(
    () =>
      validateConfig({
        ...config,
        schemes: [...config.schemes, ...config.schemes],
      }),
    /重复/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        schemes: [{ ...config.schemes[0], kind: "ai", modelId: "missing" }],
      }),
    /模型/,
  );
  const visible = publicConfig({
    ...config,
    models: [
      {
        id: "m",
        name: "模型",
        baseUrl: "https://example.com",
        model: "x",
        encryptedKey: "secret",
      },
    ],
  });
  assert.equal(visible.models[0].encryptedKey, undefined);
  assert.equal(visible.models[0].hasKey, true);
});
test("取文不能接受旧剪贴板；空白文本合法", () => {
  assert.throws(
    () => validateCapture({ before: 1, after: 1, text: "旧数据" }),
    /更新/,
  );
  assert.equal(
    validateCapture({ before: 1, after: 2, text: " \r\n\t" }),
    " \r\n\t",
  );
  assert.throws(
    () => validateCapture({ before: 1, after: 2, text: null }),
    /纯文本/,
  );
});

test("脚本语法错误、空结果及提前取消均有确定行为", async () => {
  await assert.rejects(runScript("a", "function transform("));
  assert.equal(
    await runScript("a", 'function transform(text) { return ""; }'),
    "",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runScript("a", "function transform(text) { return text; }", {
      signal: controller.signal,
    }),
    /取消/,
  );
});
test("未经脚本修改的混合换行及组合字符不会归一化", async () => {
  const text = "a\r\nb\nc\r\n e\u0301 👨‍👩‍👧‍👦";
  assert.equal(
    await runScript(text, "function transform(text) { return text; }"),
    text,
  );
});
test("AI 输出被截断时不得当作完整转换结果", async (t) => {
  const server = http.createServer((req, res) =>
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "不完整" }, finish_reason: "length" }],
      }),
    ),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  await assert.rejects(
    runAI("a", "b", {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      model: "x",
      apiKey: "test",
    }),
    /截断/,
  );
});
