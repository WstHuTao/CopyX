const { parentPort, workerData } = require("node:worker_threads");
const { newQuickJSWASMModuleFromVariant } = require("quickjs-emscripten-core");
const { default: releaseSync } = require("@jitl/quickjs-wasmfile-release-sync");
(async () => {
  const engine = await newQuickJSWASMModuleFromVariant(releaseSync);
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + workerData.timeout;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const code =
      '"use strict";\n' +
      workerData.source +
      "\n;transform(" +
      JSON.stringify(workerData.text) +
      ")";
    const result = context.evalCode(code, "用户脚本.js");
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw new Error(
        Date.now() > deadline ? "脚本执行超时" : String(error.message || error),
      );
    }
    try {
      if (context.typeof(result.value) !== "string")
        throw new Error("脚本必须返回字符串");
      parentPort.postMessage({ text: context.getString(result.value) });
    } finally {
      result.value.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
})().catch((e) => parentPort.postMessage({ error: e.message }));
