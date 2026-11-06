import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  normalizeGeneratedScript,
  generateScript,
} = require("../electron/core/script-generation.cjs");
const { runScript } = require("../electron/core/script.cjs");
const code = 'function transform(text) { return text.replace(/,/g, "\\t"); }';
test("生成结果支持纯代码和完整 JavaScript 代码围栏", () => {
  assert.equal(normalizeGeneratedScript(code), code);
  assert.equal(
    normalizeGeneratedScript("```javascript\n" + code + "\n```"),
    code,
  );
  assert.throws(
    () => normalizeGeneratedScript("解释\n```js\n" + code + "\n```"),
    /脚本/,
  );
});
test("缺少同步单参数 transform 入口或语法错误时拒绝应用", () => {
  for (const value of [
    "",
    "function transform(",
    "function another(text) {return text;}",
    "async function transform(text) {return text;}",
    "function* transform(text) {yield text;}",
    'function transform() {return "";}',
  ])
    assert.throws(() => normalizeGeneratedScript(value));
});
test("代码检查不执行模型返回的脚本", () => {
  const value = "while (true) {}\nfunction transform(text) {return text;}";
  assert.equal(normalizeGeneratedScript(value), value);
});
test("过大的代码和说明不完整的围栏会拒绝", () => {
  assert.throws(() => normalizeGeneratedScript(" ".repeat(65537)), /过长/);
  assert.throws(() => normalizeGeneratedScript("```js\n" + code), /围栏/);
});
async function service(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: "test",
    apiKey: "test-key",
  };
}
test("真实兼容接口生成脚本，随后可在既有沙箱中处理文本", async (t) => {
  const model = await service(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    assert.match(data.messages[0].content, /function transform\(text\)/);
    assert.match(data.messages[0].content, /网络/);
    assert.equal(data.messages[1].content, "逗号换成制表符");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { content: "```js\n" + code + "\n```" },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  const output = await generateScript("逗号换成制表符", model);
  assert.equal(output, code);
  assert.equal(await runScript("甲,乙\r\n1,,3", output), "甲\t乙\r\n1\t\t3");
});
test("生成请求可取消，不返回迟到的脚本", async (t) => {
  const model = await service(t, (req, res) =>
    setTimeout(
      () =>
        res.end(JSON.stringify({ choices: [{ message: { content: code } }] })),
      200,
    ),
  );
  const controller = new AbortController();
  const request = generateScript("生成转换脚本", model, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(request, /取消/);
});
test("空需求和超长需求不发送模型请求", async () => {
  await assert.rejects(generateScript("  ", {}), /处理要求/);
  await assert.rejects(generateScript("字".repeat(9000), {}), /处理要求/);
});

test("测试数据默认仅留在本地，主动勾选时才作为生成示例发送", async (t) => {
  const cases = [
    {
      id: "private",
      name: "本地样例",
      input: "不得默认上传的输入",
      expected: "不得默认上传的输出",
    },
  ];
  let count = 0;
  const model = await service(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const content = JSON.parse(body).messages[1].content;
    if (count++ === 0) assert.equal(content, "保持原样");
    else {
      assert(content.includes(cases[0].input));
      assert(content.includes(cases[0].expected));
    }
    res.end(JSON.stringify({ choices: [{ message: { content: code } }] }));
  });
  await generateScript("保持原样", model, { testCases: cases });
  await generateScript("保持原样", model, {
    testCases: cases,
    includeTestCases: true,
  });
  assert.equal(count, 2);
});

test("脚本生成仍遵守调用方显式设置的超时，不泄露请求数据", async (t) => {
  const model = await service(t, (req, res) =>
    setTimeout(
      () =>
        res.end(JSON.stringify({ choices: [{ message: { content: code } }] })),
      120,
    ),
  );
  await assert.rejects(
    generateScript("短超时验证", model, { timeout: 30 }),
    (e) => /模型请求超时/.test(e.message) && !e.message.includes(model.apiKey),
  );
});
