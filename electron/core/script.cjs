const { Worker } = require("node:worker_threads");
const path = require("node:path");
function runScript(text, source, { timeout = 2000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("处理已取消"));
    const worker = new Worker(path.join(__dirname, "script-worker.cjs"), {
      workerData: { text, source, timeout },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(new Error("处理已取消"));
    const timer = setTimeout(
      () => finish(new Error("脚本执行超时，请检查循环或输入大小")),
      timeout + 1500,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    worker.on("message", (m) =>
      finish(m.error ? new Error(m.error) : null, m.text),
    );
    worker.on("error", () => finish(new Error("脚本运行环境异常")));
    worker.on("exit", () => {
      if (!settled) finish(new Error("脚本执行意外结束"));
    });
  });
}
module.exports = { runScript };
