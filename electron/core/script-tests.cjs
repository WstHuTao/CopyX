const { createHash } = require("node:crypto");
const { runScript } = require("./script.cjs");
function validateTestCases(cases) {
  if (!Array.isArray(cases) || cases.length > 50)
    throw new Error("测试集最多支持 50 条用例");
  const ids = new Set();
  let size = 0;
  for (const c of cases) {
    if (
      !c ||
      typeof c.id !== "string" ||
      !c.id ||
      c.id.length > 80 ||
      ids.has(c.id)
    )
      throw new Error("测试用例标识为空、过长或重复");
    ids.add(c.id);
    if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 128)
      throw new Error("请填写 128 字以内的用例名称");
    for (const key of ["input", "expected"]) {
      if (typeof c[key] !== "string" || Buffer.byteLength(c[key]) > 65536)
        throw new Error("每个测试输入或预期结果必须是 64 KB 以内的文本");
      size += Buffer.byteLength(c[key]);
    }
  }
  if (size > 512 * 1024) throw new Error("测试集文本总量不能超过 512 KB");
}
function validateSource(script) {
  if (typeof script !== "string" || Buffer.byteLength(script) > 65536)
    throw new Error("脚本必须是 64 KB 以内的文本");
}
function copyCases(cases) {
  return cases.map(({ id, name, input, expected }) => ({
    id,
    name,
    input,
    expected,
  }));
}
function fingerprint(script, cases) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, script, cases: copyCases(cases) }))
    .digest("hex");
}
function activeScriptSource(scheme) {
  const active = scheme.activeScript;
  if (!active || !["legacy", "verified"].includes(active.status))
    throw new Error("此处理尚未生效，请在自定义处理中添加测试并全部通过后生效");
  if (
    active.status === "verified" &&
    (!Array.isArray(active.testCases) ||
      active.testCases.length < 1 ||
      fingerprint(active.script, active.testCases || []) !== active.fingerprint)
  )
    throw new Error("生效脚本的测试记录不一致，请重新测试并生效");
  return active.script;
}
class ScriptTests {
  constructor() {
    this.passed = new Map();
  }
  proof(schemeId, script, cases) {
    const record = this.passed.get(schemeId);
    return record?.fingerprint === fingerprint(script, cases) ? record : null;
  }
  async run(
    schemeId,
    script,
    cases,
    { signal, caseTimeout = 2000, totalTimeout = 15000 } = {},
  ) {
    if (typeof schemeId !== "string" || !schemeId || schemeId.length > 80)
      throw new Error("处理标识不正确");
    validateSource(script);
    validateTestCases(cases);
    this.passed.delete(schemeId);
    if (signal?.aborted) throw new Error("测试已取消");
    const report = {
      fingerprint: fingerprint(script, cases),
      passed: false,
      total: cases.length,
      results: [],
    };
    if (!cases.length)
      return {
        ...report,
        message: "至少添加 1 条测试用例，全部通过后才能生效",
      };
    const deadline = AbortSignal.timeout(totalTimeout);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      for (const c of cases) {
        if (combined.aborted)
          throw new Error(
            signal?.aborted
              ? "测试已取消"
              : "测试集执行超时，请减少用例或优化脚本",
          );
        const started = Date.now();
        const result = { id: c.id, passed: false };
        try {
          result.actual = await runScript(c.input, script, {
            signal: combined,
            timeout: caseTimeout,
          });
          if (Buffer.byteLength(result.actual) > 65536)
            throw new Error("测试输出超过 64 KB，未返回过长内容");
          result.passed = result.actual === c.expected;
        } catch (e) {
          if (combined.aborted)
            throw new Error(
              signal?.aborted
                ? "测试已取消"
                : "测试集执行超时，请减少用例或优化脚本",
            );
          result.error = String(e.message).slice(0, 4096);
          delete result.actual;
        }
        result.elapsedMs = Date.now() - started;
        report.results.push(result);
      }
      if (combined.aborted)
        throw new Error(signal?.aborted ? "测试已取消" : "测试集执行超时");
      report.passed = report.results.every((r) => r.passed);
      if (report.passed) {
        const proof = {
          fingerprint: report.fingerprint,
          testedAt: new Date().toISOString(),
          count: cases.length,
        };
        this.passed.set(schemeId, proof);
        // 通过凭据只在当前进程内保留，避免无限积累未保存的处理标识。
        if (this.passed.size > 200)
          this.passed.delete(this.passed.keys().next().value);
      }
      return report;
    } catch (error) {
      if (deadline.aborted && !signal?.aborted)
        return {
          ...report,
          passed: false,
          message:
            "测试集执行超时，生成或编辑的脚本可保留为草稿，请优化后重新测试",
        };
      throw error;
    }
  }
}
module.exports = {
  ScriptTests,
  fingerprint,
  validateTestCases,
  validateSource,
  copyCases,
  activeScriptSource,
};
