import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const {
  ScriptTests,
  fingerprint,
  validateTestCases,
  activeScriptSource,
} = require("../electron/core/script-tests.cjs");
const { ConfigStore } = require("../electron/core/config.cjs");
const identity = "function transform(text) { return text; }";
const upper = "function transform(text) { return text.toUpperCase(); }";
const cases = [
  { id: "one", name: "保留空白", input: " a\tB\r\n ", expected: " a\tB\r\n " },
  { id: "empty", name: "空文本", input: "", expected: "" },
];
async function fixture(t, legacy = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "copyx-test-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  const scheme = {
    id: "s",
    name: "测试",
    kind: "script",
    script: identity,
    prompt: "",
    enabled: false,
    shortcutMac: "",
    shortcutWin: "",
  };
  if (legacy)
    await writeFile(file, JSON.stringify({ schemes: [scheme], models: [] }));
  const store = new ConfigStore(file, {});
  await store.load();
  return { store, scheme, file };
}
test("用例支持空字符串并严格校验大小和重复标识", () => {
  assert.doesNotThrow(() => validateTestCases(cases));
  for (const bad of [
    [{ ...cases[0], input: null }],
    [cases[0], cases[0]],
    Array.from({ length: 51 }, (_, i) => ({ ...cases[0], id: String(i) })),
    [{ ...cases[0], expected: "x".repeat(65537) }],
  ])
    assert.throws(() => validateTestCases(bad));
});
test("全部样例在真实沙箱通过，指纹包含代码及测试集的全部内容", async () => {
  const service = new ScriptTests();
  const report = await service.run("s", identity, cases);
  assert(report.passed);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].actual, cases[0].expected);
  assert.equal(report.fingerprint, fingerprint(identity, cases));
  assert.notEqual(
    fingerprint(identity, cases),
    fingerprint(identity + " ", cases),
  );
  assert.notEqual(
    fingerprint(identity, cases),
    fingerprint(identity, [{ ...cases[0], expected: "A" }, cases[1]]),
  );
  assert(service.proof("s", identity, cases));
  assert.equal(service.proof("other", identity, cases), null);
});
test("没有用例或任意字符不一致都不产生通过记录", async () => {
  const service = new ScriptTests();
  assert(!(await service.run("s", identity, [])).passed);
  const report = await service.run("s", identity, [
    { ...cases[0], expected: " a\tB\n " },
  ]);
  assert(!report.passed);
  assert.equal(report.results[0].actual, cases[0].input);
  assert.equal(service.proof("s", identity, cases), null);
});
test("脚本异常、非文本、死循环和取消都无法通过", async () => {
  const service = new ScriptTests();
  for (const source of [
    'function transform(text){throw new Error("测试异常");}',
    "function transform(text){return 1;}",
    "function transform(text){while(true){}}",
  ]) {
    const report = await service.run("s", source, [cases[1]], {
      caseTimeout: 50,
    });
    assert(!report.passed);
    assert(report.results[0].error);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.run("s", identity, cases, { signal: controller.signal }),
    /取消/,
  );
  assert.equal(service.proof("s", identity, cases), null);
});
test("整套测试超时可终止且不产生通过记录", async () => {
  const service = new ScriptTests();
  const report = await service.run(
    "s",
    "function transform(text){while(true){}}",
    cases,
    { totalTimeout: 30 },
  );
  assert(!report.passed);
  assert.match(report.message, /超时/);
  assert.equal(service.proof("s", identity, cases), null);
});
test("后台通过记录绑定内容，修改用例或代码后不能复用", async () => {
  const service = new ScriptTests();
  await service.run("s", identity, cases);
  assert.equal(service.proof("s", upper, cases), null);
  assert.equal(
    service.proof("s", identity, [{ ...cases[0], name: "已改名" }, cases[1]]),
    null,
  );
});
test("旧配置迁移保留生效代码，编辑保存只改草稿且无法伪造生效状态", async (t) => {
  const { store } = await fixture(t, true);
  assert.equal(activeScriptSource(store.value.schemes[0]), identity);
  assert.equal(store.value.schemes[0].activeScript.status, "legacy");
  const input = structuredClone(store.value);
  input.schemes[0].script = upper;
  input.schemes[0].testCases = cases;
  input.schemes[0].activeScript = { script: upper, status: "verified" };
  await store.persist(await store.prepare(input));
  assert.equal(store.value.schemaVersion, 2);
  assert.equal(store.value.schemes[0].script, upper);
  assert.equal(activeScriptSource(store.value.schemes[0]), identity);
  const reloaded = new ConfigStore(store.file, {});
  await reloaded.load();
  assert.equal(activeScriptSource(reloaded.value.schemes[0]), identity);
});
test("新建脚本可以保存草稿，但未经后台测试不得激活或运行", async (t) => {
  const { store, scheme } = await fixture(t);
  await store.persist(await store.prepare({ schemes: [scheme], models: [] }));
  assert.throws(() => activeScriptSource(store.value.schemes[0]), /测试/);
  assert.throws(
    () => store.activateScript("s", "forged", new ScriptTests()),
    /测试/,
  );
});
test("通过后才生效，失败草稿和测试集修改不影响之前生效版本", async (t) => {
  const { store, scheme } = await fixture(t);
  const service = new ScriptTests();
  scheme.testCases = cases;
  await store.persist(await store.prepare({ schemes: [scheme], models: [] }));
  const passed = await service.run("s", identity, cases);
  await store.persist(store.activateScript("s", passed.fingerprint, service));
  assert.equal(activeScriptSource(store.value.schemes[0]), identity);
  assert.equal(store.value.schemes[0].activeScript.status, "verified");
  const draft = structuredClone(store.value);
  draft.schemes[0].script = upper;
  await store.persist(await store.prepare(draft));
  assert.throws(
    () => store.activateScript("s", passed.fingerprint, service),
    /测试/,
  );
  const failed = await service.run("s", upper, cases);
  assert(!failed.passed);
  assert.throws(
    () => store.activateScript("s", failed.fingerprint, service),
    /测试/,
  );
  assert.equal(activeScriptSource(store.value.schemes[0]), identity);
  const reloaded = new ConfigStore(store.file, {});
  await reloaded.load();
  assert.equal(activeScriptSource(reloaded.value.schemes[0]), identity);
});
test("同一代码在另一处理的通过记录不能用于激活", async (t) => {
  const { store, scheme } = await fixture(t);
  scheme.testCases = cases;
  await store.persist(await store.prepare({ schemes: [scheme], models: [] }));
  const service = new ScriptTests();
  const report = await service.run("other", identity, cases);
  assert.throws(
    () => store.activateScript("s", report.fingerprint, service),
    /测试/,
  );
});

test("超过旧版脚本长度上限的新限制不会阻断旧配置启动和原样保存", async (t) => {
  const { store, file } = await fixture(t, true);
  const original = identity + "\n" + " ".repeat(65536);
  await writeFile(
    file,
    JSON.stringify({
      schemes: [{ ...store.value.schemes[0], script: original }],
      models: [],
    }),
  );
  const migrated = new ConfigStore(file, {});
  await migrated.load();
  assert.equal(activeScriptSource(migrated.value.schemes[0]), original);
  await migrated.persist(await migrated.prepare(migrated.value));
  const reload = new ConfigStore(file, {});
  await reload.load();
  assert.equal(activeScriptSource(reload.value.schemes[0]), original);
  const changed = structuredClone(reload.value);
  changed.schemes[0].script += " ";
  await assert.rejects(reload.prepare(changed), /64 KB/);
});
test("超时返回未通过的部分报告，便于保留生成脚本，不产生通过凭据", async () => {
  const service = new ScriptTests();
  const source = "function transform(text){while(true){}}";
  const report = await service.run("timeout", source, [cases[0]], {
    totalTimeout: 30,
  });
  assert(!report.passed);
  assert.match(report.message, /超时/);
  assert.equal(service.proof("timeout", source, [cases[0]]), null);
});
test("无测试集的伪造生效快照不允许执行，测试输出过大时不返回巨量文本", async () => {
  assert.throws(
    () =>
      activeScriptSource({
        activeScript: {
          status: "verified",
          script: identity,
          fingerprint: fingerprint(identity, []),
        },
      }),
    /测试记录/,
  );
  const service = new ScriptTests();
  const report = await service.run(
    "large",
    'function transform(text){return "x".repeat(65537);}',
    [cases[1]],
  );
  assert(!report.passed);
  assert.match(report.results[0].error, /64 KB/);
  assert.equal(report.results[0].actual, undefined);
});
