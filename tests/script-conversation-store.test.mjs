import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ScriptConversationStore,
} = require("../electron/core/script-conversation-store.cjs");

async function fixture(t, options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "copyx-conversations-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "private", "conversations.json");
  const store = new ScriptConversationStore(file, options);
  return { dir, file, store };
}

function record(schemeId = "方案一", id = "会话一") {
  return {
    schemeId,
    id,
    messages: [{ content: "用户主动保存的要求" }],
    testCases: [{ input: "样例", expected: "预期" }],
  };
}

test("缺失文件加载不创建目录，首次保存后重启恢复且权限受限", async (t) => {
  const { file, store } = await fixture(t);
  await store.load();
  assert.equal(store.get("方案一"), null);
  assert.equal(store.loadWarning, "");
  await assert.rejects(fs.stat(path.dirname(file)), { code: "ENOENT" });
  await store.put(record());
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
    version: 1,
    conversations: [record()],
  });
  const restarted = new ScriptConversationStore(file);
  await restarted.load();
  assert.deepEqual(restarted.get("方案一"), record());
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
});

test("不同方案隔离，同方案仅保留最后保存的会话", async (t) => {
  const { file, store } = await fixture(t);
  await store.load();
  await store.put(record());
  await store.put(record("方案二", "另一个会话"));
  await store.put(record("方案一", "最新会话"));
  assert.deepEqual(store.get("方案二"), record("方案二", "另一个会话"));
  assert.equal(store.get("方案一").id, "最新会话");
  assert.equal(
    JSON.parse(await fs.readFile(file, "utf8")).conversations.length,
    2,
  );
});

test("保存入参和读取结果均隔离引用，包括排队期间修改入参", async (t) => {
  const { store } = await fixture(t);
  await store.load();
  const input = record();
  const pending = store.put(input);
  input.messages[0].content = "外部修改";
  await pending;
  const view = store.get("方案一");
  view.messages[0].content = "读取后修改";
  assert.deepEqual(store.get("方案一"), record());
});

test("完整临时文件原子替换后才发布缓存，失败清理临时文件并可重试", async (t) => {
  const { file, store } = await fixture(t);
  await store.load();
  await store.put(record());
  const before = await fs.readFile(file, "utf8");
  const rename = fs.rename;
  let tempFile;
  const mocked = t.mock.method(fs, "rename", async (source, destination) => {
    tempFile = source;
    assert.equal(destination, file);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual(store.get("方案一"), record());
    assert.equal(
      JSON.parse(await fs.readFile(source, "utf8")).conversations[0].id,
      "新会话",
    );
    if (process.platform !== "win32")
      assert.equal((await fs.stat(source)).mode & 0o777, 0o600);
    throw new Error("模拟磁盘错误");
  });
  await assert.rejects(
    store.put(record("方案一", "新会话")),
    /保存.*失败|无法保存/,
  );
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(store.get("方案一"), record());
  await assert.rejects(fs.stat(tempFile), { code: "ENOENT" });
  mocked.mock.restore();
  assert.equal(fs.rename, rename);
  await store.put(record("方案一", "重试成功"));
  assert.equal(store.get("方案一").id, "重试成功");
});

test("总体 UTF-8 字节超限不覆盖文件或缓存", async (t) => {
  const { file, store } = await fixture(t, { maxBytes: 300 });
  await store.load();
  await store.put(record());
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(
    store.put({ ...record(), messages: [{ content: "中".repeat(100) }] }),
    /超出|超过/,
  );
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(store.get("方案一"), record());
});

test("临时文件写入中途失败不损伤原文件，并清理未完成文件", async (t) => {
  const { file, store } = await fixture(t);
  await store.put(record());
  const before = await fs.readFile(file, "utf8");
  const open = fs.open;
  let temporary;
  t.mock.method(fs, "open", async (target, ...args) => {
    const handle = await open(target, ...args);
    if (args[0] === "wx") {
      temporary = target;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async () => {
        await write("未完成的内容");
        throw new Error("模拟写入中断");
      };
    }
    return handle;
  });
  await assert.rejects(store.put(record("方案二")), /保存.*失败/);
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(store.get("方案一"), record());
  assert.equal(store.get("方案二"), null);
  await assert.rejects(fs.stat(temporary), { code: "ENOENT" });
});

test("损坏和未知格式只读保护，保留原文件", async (t) => {
  for (const text of [
    "{损坏",
    '{"version":2,"conversations":[]}',
    '{"version":1,"conversations":[{"id":"无方案"}]}',
    '{"version":1,"conversations":{}}',
  ]) {
    const { file, store } = await fixture(t);
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, text);
    await store.load();
    assert.match(store.loadWarning, /只读/);
    assert.equal(store.get("方案一"), null);
    await assert.rejects(store.put(record()), /只读/);
    assert.equal(await fs.readFile(file, "utf8"), text);
  }
});

test("超限历史文件保留原文件并进入只读保护", async (t) => {
  const { file, store } = await fixture(t, { maxBytes: 10 });
  await fs.mkdir(path.dirname(file));
  const text = JSON.stringify({ version: 1, conversations: [record()] });
  await fs.writeFile(file, text);
  await store.load();
  assert.match(store.loadWarning, /只读/);
  await assert.rejects(store.put(record()), /只读/);
  assert.equal(await fs.readFile(file, "utf8"), text);
});

test("并发保存保留两个方案，重复加载不丢失已保存记录", async (t) => {
  const { file, store } = await fixture(t);
  await Promise.all([
    store.put(record()),
    store.put(record("方案二", "会话二")),
  ]);
  await store.load();
  const restarted = new ScriptConversationStore(file);
  await restarted.load();
  assert.deepEqual(restarted.get("方案一"), record());
  assert.deepEqual(restarted.get("方案二"), record("方案二", "会话二"));
});

test("加载历史重复方案时以文件中最后一条为准", async (t) => {
  const { file, store } = await fixture(t);
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      conversations: [record(), record("方案一", "最新会话")],
    }),
  );
  await store.load();
  assert.equal(store.get("方案一").id, "最新会话");
});

test("拒绝非 JSON 对象和空标识，但不判断内部业务结构", async (t) => {
  const { store } = await fixture(t);
  await store.load();
  const cyclic = record();
  cyclic.self = cyclic;
  for (const value of [
    null,
    [],
    {},
    { ...record(), schemeId: " " },
    { ...record(), id: "" },
    { ...record(), date: new Date() },
    { ...record(), missing: undefined },
    cyclic,
  ]) {
    await assert.rejects(store.put(value), /会话记录/);
  }
  const arbitrary = {
    schemeId: "__proto__",
    id: "任意结构",
    content: { nullable: null, number: 1 },
  };
  await store.put(arbitrary);
  assert.deepEqual(store.get("__proto__"), arbitrary);
});
