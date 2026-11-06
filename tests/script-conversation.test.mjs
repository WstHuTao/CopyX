import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  ScriptConversation,
} = require("../electron/core/script-conversation.cjs");
const { ScriptTests } = require("../electron/core/script-tests.cjs");
const identity = "function transform(text){return text;}";
const code = "function transform(text){return text.toUpperCase();}";
const cases = [{ id: "a", name: "大写", input: "abc", expected: "ABC" }];
const base = {
  schemeId: "s",
  modelId: "m",
  script: identity,
  testCases: cases,
};
const model = {
  baseUrl: "https://example.com",
  model: "test",
  apiKey: "secret",
};
function fixture(reply) {
  const records = new Map();
  return new ScriptConversation({
    tests: new ScriptTests(),
    repository: {
      get: (id) => structuredClone(records.get(id) || null),
      put: async (record) =>
        records.set(record.schemeId, structuredClone(record)),
    },
    request: reply,
  });
}
test("首轮提供已有脚本、完整测试数据和实际失败结果，讨论不生成或执行新代码", async () => {
  const service = fixture(async (messages) => {
    assert(messages[0].content.includes("先讨论"));
    const data = JSON.parse(messages[1].content);
    assert.equal(data.context.script, identity);
    assert.equal(data.context.testCases[0].input, "abc");
    assert.equal(data.context.report.results[0].actual, "abc");
    assert(!data.context.report.passed);
    return "方案：仅转换 ASCII 字母，保持其他文字不变。";
  });
  const view = await service.discuss({ ...base, message: "需要转大写" }, model);
  assert(view.plan.id);
  assert.equal(view.turns.length, 2);
  assert.equal(view.generated, null);
});
test("没有有效方案不能生成，方案只对同一处理、模型、脚本和测试集生效", async () => {
  const service = fixture(async () => "方案：转为大写");
  await assert.rejects(
    service.generate(
      { ...base, conversationId: "fake", planId: "fake" },
      model,
    ),
    /方案|会话/,
  );
  const view = await service.discuss({ ...base, message: "转大写" }, model);
  for (const patch of [
    { schemeId: "other" },
    { modelId: "other" },
    { script: identity + " " },
    { testCases: [{ ...cases[0], expected: "other" }] },
    { planId: "fake" },
  ])
    await assert.rejects(
      service.generate(
        { ...base, conversationId: view.id, planId: view.plan.id, ...patch },
        model,
      ),
      /方案|会话|变更/,
    );
});
test("多轮补充进入真实消息历史，新方案使旧确认失效，生成后测试反馈供下一轮参考", async () => {
  let step = 0;
  const service = fixture(async (messages) => {
    step++;
    if (step === 1) return "第一方案";
    if (step === 2) {
      assert(
        messages.some(
          (m) => m.role === "assistant" && m.content === "第一方案",
        ),
      );
      assert(messages.at(-1).content.includes("保留换行"));
      return "第二方案，保留换行";
    }
    if (step === 3) {
      assert(messages[0].content.includes("function transform"));
      assert(messages.at(-1).content.includes("确认"));
      return code;
    }
    assert(messages.some((m) => m.role === "assistant" && m.content === code));
    assert(messages.at(-1).content.includes("ABC"));
    return "第三方案";
  });
  const first = await service.discuss({ ...base, message: "转大写" }, model);
  const second = await service.discuss(
    { ...base, conversationId: first.id, message: "保留换行" },
    model,
  );
  await assert.rejects(
    service.generate(
      { ...base, conversationId: first.id, planId: first.plan.id },
      model,
    ),
    /方案/,
  );
  const generated = await service.generate(
    { ...base, conversationId: second.id, planId: second.plan.id },
    model,
  );
  assert(generated.report.passed);
  assert.equal(generated.conversation.plan, null);
  const third = await service.discuss(
    { ...base, conversationId: second.id, message: "请参考本次测试继续检查" },
    model,
  );
  assert(third.plan.id);
  assert.equal(step, 4);
});
test("更换编辑上下文重跑测试并更新方案，取消不追加半轮对话", async () => {
  const controller = new AbortController();
  let count = 0;
  const service = fixture(async (_messages, _model, { signal }) => {
    count++;
    if (count === 2) {
      controller.abort();
      signal.throwIfAborted();
    }
    return "已有方案";
  });
  const view = await service.discuss({ ...base, message: "先分析" }, model);
  await assert.rejects(
    service.discuss(
      { ...base, conversationId: view.id, message: "继续" },
      model,
      { signal: controller.signal },
    ),
  );
  assert.equal(service.get("s").turns.length, 2);
});
test("模型或连接设置变化后旧方案不可生成", async () => {
  const service = fixture(async () => "方案");
  const view = await service.discuss({ ...base, message: "分析" }, model);
  await assert.rejects(
    service.generate(
      { ...base, conversationId: view.id, planId: view.plan.id },
      { ...model, apiKey: "other" },
    ),
    /模型|变更/,
  );
});
test("通过仓储恢复会话和生成预览，保存失败仍返回本轮结果与提示", async () => {
  const records = new Map();
  const repository = {
    get: (id) => structuredClone(records.get(id) || null),
    put: async (r) => records.set(r.schemeId, structuredClone(r)),
  };
  const first = new ScriptConversation({
    tests: new ScriptTests(),
    repository,
    request: async () => "已保存的方案",
  });
  const view = await first.discuss({ ...base, message: "分析" }, model);
  const second = new ScriptConversation({
    tests: new ScriptTests(),
    repository,
    request: async () => code,
  });
  assert.equal(second.get("s").plan.id, view.plan.id);
  const result = await second.generate(
    { ...base, conversationId: view.id, planId: view.plan.id },
    model,
  );
  assert(result.report.passed);
  assert.equal(second.get("s").generated.script, code);
  const broken = new ScriptConversation({
    tests: new ScriptTests(),
    repository: {
      get: () => null,
      put: async () => {
        throw new Error("磁盘只读");
      },
    },
    request: async () => "方案未丢失",
  });
  const pending = await broken.discuss({ ...base, message: "分析" }, model);
  assert.equal(pending.plan.text, "方案未丢失");
  assert.match(pending.storageWarning, /未保存/);
});
test("真实兼容接口收到多条 user 和 assistant 消息，并沿用取消和五分钟策略", async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    seen.push(data.messages);
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: seen.length === 3 ? code : "分析方案 " + seen.length,
            },
          },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const service = new ScriptConversation({
    tests: new ScriptTests(),
    repository: { get: () => null, put: async () => {} },
  });
  const live = {
    ...model,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
  const first = await service.discuss({ ...base, message: "转大写" }, live);
  const second = await service.discuss(
    { ...base, conversationId: first.id, message: "请保留格式" },
    live,
  );
  const output = await service.generate(
    { ...base, conversationId: second.id, planId: second.plan.id },
    live,
  );
  assert(output.report.passed);
  assert(seen[1].some((m) => m.role === "assistant"));
  assert(seen[2].length >= 6);
  assert(seen[0][1].content.includes(identity));
});

test("业务结构损坏的历史不会返回给界面或覆盖原记录", () => {
  const broken = {
    version: 1,
    id: "bad",
    schemeId: "s",
    messages: [],
    turns: [],
  };
  const service = new ScriptConversation({
    tests: new ScriptTests(),
    repository: {
      get: () => broken,
      put: async () => {
        throw new Error("不应覆盖");
      },
    },
  });
  assert.throws(() => service.get("s"), /历史对话格式/);
  assert.equal(broken.context, undefined);
});
test("讨论评估与生效凭据隔离，重测原稿失败不清除已生成代码的通过记录", async () => {
  let n = 0;
  const service = fixture(async () => (++n === 2 ? code : "方案"));
  const plan = await service.discuss({ ...base, message: "改为大写" }, model);
  const output = await service.generate(
    { ...base, conversationId: plan.id, planId: plan.plan.id },
    model,
  );
  assert(output.report.passed);
  assert(service.tests.proof("s", code, cases));
  await service.discuss(
    {
      ...base,
      script: identity + " ",
      conversationId: plan.id,
      message: "请继续分析",
    },
    model,
  );
  assert(
    service.tests.proof("s", code, cases),
    "讨论评估不能删除可应用预览的通过凭据",
  );
});

test("编辑内容未变时继续讨论仍附带最新测试报告，不重复发送完整脚本", async () => {
  let calls = 0;
  const service = fixture(async (messages) => {
    if (++calls === 2) {
      const payload = JSON.parse(messages.at(-1).content);
      assert(payload.latestTestReport);
      assert.equal(payload.context, undefined);
      assert.equal(
        payload.latestTestReport.fingerprint,
        require("../electron/core/script-tests.cjs").fingerprint(
          identity,
          cases,
        ),
      );
    }
    return "方案";
  });
  const first = await service.discuss({ ...base, message: "分析" }, model);
  await service.discuss(
    { ...base, conversationId: first.id, message: "复核当前测试" },
    model,
  );
});
