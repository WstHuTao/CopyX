const { execFile, spawn } = require("node:child_process");
const execFileAsync = require("node:util").promisify(execFile);
function validateCapture(result) {
  if (
    !result ||
    !Number.isInteger(result.before) ||
    !Number.isInteger(result.after) ||
    result.before === result.after
  )
    throw new Error("未检测到本次复制更新，请先选中文字后再试");
  if (typeof result.text !== "string" || result.text.length === 0)
    throw new Error("本次复制没有可处理的纯文本");
  if (Buffer.byteLength(result.text, "utf8") > 1024 * 1024)
    throw new Error("选中文字超过 1 MB，请分段处理");
  return result.text;
}
function captureCommand(helper) {
  return process.platform === "win32"
    ? [
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-STA",
          "-File",
          helper,
        ],
      ]
    : [helper, []];
}
function captureSelection(helper) {
  return new Promise((resolve, reject) => {
    const [command, args] = captureCommand(helper);
    execFile(
      command,
      args,
      {
        timeout: 6000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout) => {
        try {
          const result = JSON.parse(stdout);
          if (result.error) throw new Error(result.error);
          if (error) throw new Error("系统复制未完成");
          resolve(validateCapture(result));
        } catch (e) {
          reject(
            new Error(
              stdout
                ? e.message
                : "获取选文失败，请检查系统权限并确认目标应用支持复制",
            ),
          );
        }
      },
    );
  });
}
async function readCaptureFrame(stream, limit) {
  const chunks = [];
  let size = 0;
  // 助手按一问一答发送单行 JSON，下一帧只会在收到写回请求后发送。
  for (;;) {
    const { value, done } = await stream.next();
    if (done) break;
    const end = value.indexOf(10);
    const chunk = end < 0 ? value : value.subarray(0, end);
    size += chunk.length;
    if (size > limit) throw new Error("选中文字超过 1 MB，请分段处理");
    chunks.push(chunk);
    if (end >= 0) break;
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new Error("无法读取取文程序结果");
  }
}
async function captureDirect(helper) {
  const [command, args] = captureCommand(helper);
  const flag = process.platform === "win32" ? "-Direct" : "--direct";
  const child = spawn(command, [...args, flag], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  const stream = child.stdout[Symbol.asyncIterator]();
  let timer = setTimeout(() => child.kill(), 6000);
  const close = () => {
    clearTimeout(timer);
    child.stdin.destroy();
    child.kill();
  };
  try {
    const frame = await readCaptureFrame(stream, 6 * 1024 * 1024 + 4096);
    if (frame?.error) throw new Error(frame.error);
    const text = validateCapture(frame);
    clearTimeout(timer);
    return {
      text,
      close,
      async replace(result) {
        if (frame.direct !== true) return false;
        timer = setTimeout(() => child.kill(), 3000);
        try {
          child.stdin.end(JSON.stringify({ text: result }) + "\n");
          return (await readCaptureFrame(stream, 4096))?.pasted === true;
        } catch {
          return false;
        } finally {
          close();
        }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
async function checkCapturePermission(helper) {
  try {
    const { stdout } = await execFileAsync(helper, ["--check-permission"], {
      timeout: 3000,
      maxBuffer: 1024,
    });
    const { allowed } = JSON.parse(stdout);
    if (typeof allowed === "boolean") return allowed;
  } catch {
    // 检测程序异常不等同于系统拒绝授权。
  }
  throw new Error("无法检查辅助功能权限，请确认 CopyX 已完整安装");
}
module.exports = {
  validateCapture,
  captureSelection,
  captureDirect,
  checkCapturePermission,
};
