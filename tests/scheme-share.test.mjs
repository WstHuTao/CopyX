import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  encodeSharedScheme,
  decodeSharedScheme,
  shareFileName,
} = require("../electron/core/scheme-share.cjs");
const input = "甲\t乙\r\n\n";
const code = "function transform(text) {\r\n  return text;\r\n}";
const testCases = [{ id: "t", name: "空白保留", input, expected: input }];
const script = {
  id: "old",
  kind: "script",
  name: "文本清理",
  script: code,
  testCases,
  activeScript: { status: "verified", script: code },
  enabled: true,
  shortcutMac: "Command+Shift+C",
  apiKey: "fixture-key",
  modelId: "fixture-model",
  history: "会话内容",
};

test("分享只写入可移植字段，按选择精确保留测试用例", () => {
  const withoutTests = JSON.parse(encodeSharedScheme(script));
  const withTests = JSON.parse(encodeSharedScheme(script, true));
  assert.deepEqual(withoutTests.scheme, {
    name: script.name,
    kind: "script",
    script: code,
    testCases: [],
  });
  assert.deepEqual(withTests.scheme, {
    name: script.name,
    kind: "script",
    script: code,
    testCases,
  });
  assert.equal(
    shareFileName("表格/清理:版本1"),
    "CopyX-表格_清理_版本1.copyx.json",
  );
});

test("导入为新草稿，忽略文件内的身份、键位、模型及生效状态", () => {
  const document = JSON.parse(encodeSharedScheme(script, true));
  document.scheme = { ...script, ...document.scheme };
  const bytes = Buffer.from(JSON.stringify(document));
  const first = decodeSharedScheme(bytes);
  const second = decodeSharedScheme(bytes);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, script.id);
  assert.deepEqual(first, {
    id: first.id,
    name: script.name,
    kind: "script",
    script: code,
    prompt: "",
    testCases,
    enabled: false,
    shortcutMac: "",
    shortcutWin: "",
  });
  const ai = JSON.parse(
    encodeSharedScheme({ ...script, kind: "ai", prompt: "转成表格\r\n" }, true),
  );
  assert.deepEqual(ai.scheme, {
    name: script.name,
    kind: "ai",
    prompt: "转成表格\r\n",
  });
  ai.scheme.modelId = "foreign";
  const imported = decodeSharedScheme(Buffer.from(JSON.stringify(ai)));
  assert.equal(imported.prompt, "转成表格\r\n");
  assert.equal(imported.modelId, undefined);
});

test("拒绝不支持的格式、版本、非法编码和超限内容", () => {
  assert.throws(() => decodeSharedScheme(Buffer.from("{}")), /不是 CopyX/);
  assert.throws(() => decodeSharedScheme(Buffer.from([0xff])), /无法读取/);
  assert.throws(
    () => decodeSharedScheme(Buffer.alloc(8 * 1024 * 1024 + 1)),
    /8 MB/,
  );
  const document = JSON.parse(encodeSharedScheme(script, true));
  assert.throws(
    () =>
      decodeSharedScheme(
        Buffer.from(JSON.stringify({ ...document, version: 2 })),
      ),
    /当前版本不支持/,
  );
  document.scheme.testCases.push(testCases[0]);
  assert.throws(
    () => decodeSharedScheme(Buffer.from(JSON.stringify(document))),
    /重复/,
  );
});
