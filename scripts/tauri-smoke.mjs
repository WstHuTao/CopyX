import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalKeyVault } from "../electron/core/local-vault.cjs";

const [executable] = process.argv.slice(2);
if (!executable)
  throw new Error("请传入启用 smoke-test 的 CopyX 可执行文件路径");

const temp = await mkdtemp(join(tmpdir(), "copyx-tauri-smoke-"));
const requests = [];
const key = "copyx-smoke-key";
const expected = "function transform(text) { return text + '！'; }";
let conversions = 0;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer " + key);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, "copyx-test");
    requests.push(body);
    const user = body.messages.at(-1).content;
    const system = body.messages[0].content;
    const content = system.includes("脚本方案讨论助手")
      ? "**方案** 保留原文空格，并加上全角感叹号。"
      : system.includes("脚本生成助手")
        ? expected
        : system.includes("CopyX 文本转换器")
          ? ++conversions === 1
            ? "原文无需更改。"
            : JSON.stringify({ unchanged: true })
          : user;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content } }],
      }),
    );
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});

async function run() {
  const child = spawn(resolve(executable), [], {
    env: { ...process.env, TEXT_WORKBENCH_TEST_DIR: temp },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    const exitCode = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    assert.equal(exitCode, 0, stderr || stdout);
    const output = stdout
      .split("\n")
      .find((line) => line.startsWith("COPYX_SMOKE_RESULT "));
    assert.ok(output, stderr || stdout || "未收到测试窗口报告");
    const result = JSON.parse(output.slice("COPYX_SMOKE_RESULT ".length));
    assert.ok(result.ok, JSON.stringify(result));
    console.log(result.checks.join("\n"));
    return result.checks;
  } finally {
    clearTimeout(timer);
  }
}

try {
  await new Promise((done, reject) =>
    server.listen(0, "127.0.0.1", done).once("error", reject),
  );
  const vault = new LocalKeyVault(join(temp, "master.key"));
  const encryptedKey = await vault.encrypt(key, "smoke-model");
  const shortcut = { enabled: false, shortcutMac: "", shortcutWin: "" };
  const script = "function transform(text) { return text; }";
  const config = {
    schemaVersion: 2,
    aiShortcut: shortcut,
    schemes: [
      {
        id: "smoke-js",
        name: "脚本测试",
        kind: "script",
        ...shortcut,
        script,
        prompt: "",
        testCases: [
          {
            id: "case-1",
            name: "保留换行",
            input: "保留\r\n",
            expected: "保留\r\n！",
          },
          { id: "case-2", name: "空文本", input: "", expected: "！" },
        ],
        activeScript: { status: "legacy", script, testCases: [] },
      },
      {
        id: "smoke-ai",
        name: "提示词测试",
        kind: "ai",
        ...shortcut,
        script: "",
        prompt: "",
        modelId: "smoke-model",
        testCases: [],
      },
    ],
    models: [
      {
        id: "smoke-model",
        name: "本机测试模型",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: "copyx-test",
        encryptedKey,
      },
    ],
    promptHistory: [],
  };
  const configPath = join(temp, "config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await run();
  await run();
  assert.equal(requests.length, 6);
  const [firstConversion, retry] = requests.filter(({ messages }) =>
    messages[0].content.includes("CopyX 文本转换器"),
  );
  assert.match(retry.messages[0].content, /上次回复不符合返回格式/);
  assert.deepEqual(firstConversion.messages[1], retry.messages[1]);
  const context = JSON.parse(requests[0].messages.at(-1).content);
  assert.ok(JSON.stringify(context).includes(script), "模型首轮应收到已有脚本");
  assert.ok(
    JSON.stringify(context).includes('"actual"'),
    "模型首轮应收到已有脚本的实际测试结果",
  );
  assert.ok(requests[1].messages.some(({ role }) => role === "assistant"));
  assert.match(
    requests[2].messages.at(-1).content,
    /用户已在软件中确认当前方案/,
  );
  const saved = await readFile(configPath, "utf8");
  assert.ok(
    saved.includes(encryptedKey) && !saved.includes(key),
    "API Key 仍使用旧版本地加密格式",
  );
  assert.ok(!saved.includes("结尾"), "工作台原文未落盘");
  const conflict = JSON.parse(saved);
  Object.assign(conflict.schemes[0], {
    enabled: true,
    shortcutMac: "Command+C",
    shortcutWin: "Control+C",
  });
  await writeFile(configPath, JSON.stringify(conflict));
  const checks = await run();
  assert.ok(checks.includes("系统快捷键注册失败在启动时可见"));
  console.log("模型上下文、方案确认、密钥加密与工作台隐私校验通过");
} finally {
  server.close();
  await rm(temp, { recursive: true, force: true });
}
