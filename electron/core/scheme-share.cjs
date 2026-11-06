const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  validateSource,
  validateTestCases,
  copyCases,
} = require("./script-tests.cjs");

const FORMAT = "copyx.custom-processing";
const MAX_BYTES = 8 * 1024 * 1024;

function portableScheme(value, includeTests) {
  if (typeof value?.name !== "string" || !value.name.trim())
    throw new Error("请填写处理名称");
  if (value.kind === "script") {
    validateSource(value.script);
    const testCases = includeTests ? (value.testCases ?? []) : [];
    validateTestCases(testCases);
    return {
      name: value.name,
      kind: "script",
      script: value.script,
      testCases: copyCases(testCases),
    };
  }
  if (value.kind === "ai" && typeof value.prompt === "string")
    return { name: value.name, kind: "ai", prompt: value.prompt };
  throw new Error("自定义处理类型或内容不正确");
}

function encodeSharedScheme(value, includeTests = false) {
  const text =
    JSON.stringify(
      {
        format: FORMAT,
        version: 1,
        scheme: portableScheme(value, includeTests),
      },
      null,
      2,
    ) + "\n";
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new Error("分享文件超过 8 MB，请缩短内容后再试");
  return text;
}

function decodeSharedScheme(buffer) {
  if (buffer.length > MAX_BYTES) throw new Error("分享文件超过 8 MB");
  let document;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    );
  } catch {
    throw new Error("无法读取分享文件，请选择有效的 CopyX 文件");
  }
  if (document?.format !== FORMAT)
    throw new Error("这不是 CopyX 自定义处理文件");
  if (document.version !== 1)
    throw new Error("当前版本不支持此分享文件，请更新 CopyX 后再试");
  const scheme = portableScheme(document.scheme, true);
  return {
    id: randomUUID(),
    name: scheme.name,
    kind: scheme.kind,
    script: scheme.script ?? "",
    prompt: scheme.prompt ?? "",
    testCases: scheme.testCases ?? [],
    enabled: false,
    shortcutMac: "",
    shortcutWin: "",
  };
}

function shareFileName(name) {
  const safe = Array.from(name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_"))
    .slice(0, 40)
    .join("");
  return `CopyX-${safe}.copyx.json`;
}

async function readSharedScheme(file) {
  let contents;
  try {
    const input = await fs.open(file, "r");
    try {
      const info = await input.stat();
      if (!info.isFile()) throw new Error("请选择普通的 CopyX 分享文件");
      const { size } = info;
      if (size > MAX_BYTES) throw new Error("分享文件超过 8 MB");
      // 多读一个字节，用于发现读取期间增长的文件。
      const buffer = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await input.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== size) throw new Error("读取期间文件发生变化，请重新导入");
      contents = buffer.subarray(0, offset);
    } finally {
      await input.close();
    }
  } catch (error) {
    if (error.code) throw new Error("无法读取所选文件，请检查文件位置与权限");
    throw error;
  }
  return decodeSharedScheme(contents);
}

async function writeSharedScheme(file, text) {
  const temp = path.join(
    path.dirname(file),
    `.copyx-share-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temp, text, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } catch {
    await fs.unlink(temp).catch(() => {});
    throw new Error("无法保存分享文件，请检查目标目录权限和可用空间");
  }
}

module.exports = {
  encodeSharedScheme,
  decodeSharedScheme,
  shareFileName,
  readSharedScheme,
  writeSharedScheme,
};
