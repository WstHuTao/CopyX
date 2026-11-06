const { execFile } = require("node:child_process");
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
function captureSelection(helper) {
  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    execFile(
      win ? "powershell.exe" : helper,
      win
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-STA",
            "-File",
            helper,
          ]
        : [],
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
module.exports = { validateCapture, captureSelection, checkCapturePermission };
