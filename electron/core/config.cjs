const fs = require("node:fs/promises");
const { endpointFor } = require("./ai.cjs");
const { isLocalCiphertext } = require("./local-vault.cjs");
const { legacyAIShortcut } = require("./shortcuts.cjs");
const { validatePromptHistory } = require("./prompt-history.cjs");
const {
  validateTestCases,
  validateSource,
  copyCases,
  activeScriptSource,
} = require("./script-tests.cjs");
function validateConfig(value, { allowLargeScript = () => false } = {}) {
  if (!value || !Array.isArray(value.schemes) || !Array.isArray(value.models))
    throw new Error("配置格式不正确");
  if (value.schemes.length > 100 || value.models.length > 50)
    throw new Error("方案或模型配置数量超过限制");
  if (
    value.aiShortcut !== undefined &&
    (typeof value.aiShortcut?.enabled !== "boolean" ||
      typeof value.aiShortcut.shortcutMac !== "string" ||
      typeof value.aiShortcut.shortcutWin !== "string")
  )
    throw new Error("AI 快捷键设置格式不正确");
  for (const list of [value.schemes, value.models]) {
    const ids = new Set();
    for (const item of list) {
      if (typeof item.id !== "string" || !item.id || ids.has(item.id))
        throw new Error("配置标识为空或重复");
      ids.add(item.id);
      if (typeof item.name !== "string" || !item.name.trim())
        throw new Error("请填写配置名称");
    }
  }
  for (const model of value.models) {
    endpointFor(model.baseUrl);
    if (typeof model.model !== "string" || !model.model.trim())
      throw new Error("请填写模型名称");
  }
  for (const scheme of value.schemes) {
    if (!allowLargeScript(scheme)) validateSource(scheme.script);
    validateTestCases(scheme.testCases || []);
    if (!["script", "ai"].includes(scheme.kind))
      throw new Error("自定义处理类型不正确");
    for (const key of ["script", "prompt", "shortcutMac", "shortcutWin"])
      if (typeof scheme[key] !== "string")
        throw new Error("方案字段格式不正确");
    if (scheme.disabled !== undefined && typeof scheme.disabled !== "boolean")
      throw new Error("指令禁用状态不正确");
    if (
      scheme.directPaste !== undefined &&
      typeof scheme.directPaste !== "boolean"
    )
      throw new Error("直接粘贴设置格式不正确");
    if (typeof scheme.enabled !== "boolean")
      throw new Error("方案启用状态不正确");
    if (
      scheme.kind === "ai" &&
      scheme.modelId !== undefined &&
      scheme.modelId !== "" &&
      !value.models.some((m) => m.id === scheme.modelId)
    )
      throw new Error("AI 方案引用的模型不存在，请先添加模型");
  }
}
function publicConfig(config) {
  return {
    ...config,
    models: config.models.map(({ encryptedKey, ...model }) => ({
      ...model,
      hasKey: Boolean(encryptedKey),
      needsKeyUpdate: Boolean(encryptedKey) && !isLocalCiphertext(encryptedKey),
    })),
  };
}
class ConfigStore {
  constructor(file, vault) {
    this.file = file;
    this.vault = vault;
    this.value = null;
  }
  async load() {
    try {
      this.value = JSON.parse(await fs.readFile(this.file, "utf8"));
      validateConfig(this.value, {
        allowLargeScript: (s) =>
          this.value.schemaVersion !== 2 ||
          (s.activeScript?.status === "legacy" &&
            s.script === s.activeScript.script),
      });
      if (this.value.schemaVersion !== 2) {
        this.value.schemaVersion = 2;
        this.value.schemes = this.value.schemes.map((s) => ({
          ...s,
          testCases: [],
          activeScript:
            s.kind === "script"
              ? { script: s.script, testCases: [], status: "legacy" }
              : undefined,
        }));
      }
      for (const s of this.value.schemes) {
        if (s.activeScript) {
          if (s.activeScript.status === "legacy") {
            if (typeof s.activeScript.script !== "string")
              throw new Error("旧脚本格式不正确");
          } else validateSource(s.activeScript.script);
          validateTestCases(s.activeScript.testCases || []);
          activeScriptSource(s);
        }
      }
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error("配置读取失败，请备份配置文件后检查，未覆盖原配置");
      this.value = {
        schemaVersion: 2,
        schemes: [
          {
            id: "clean",
            name: "文本清理",
            kind: "script",
            script: "function transform(text) {\n  return text;\n}",
            prompt: "",
            enabled: true,
            shortcutMac: "Command+Shift+1",
            shortcutWin: "Control+Alt+1",
            testCases: [],
            activeScript: {
              script: "function transform(text) {\n  return text;\n}",
              testCases: [],
              status: "legacy",
            },
          },
        ],
        models: [],
      };
    }
    this.value.aiShortcut ??= legacyAIShortcut(this.value.schemes);
    if (this.value.promptHistory === undefined) this.value.promptHistory = [];
    try {
      validatePromptHistory(this.value.promptHistory);
    } catch {
      throw new Error("提示词历史读取失败，请备份配置文件后检查，未覆盖原配置");
    }
    return publicConfig(this.value);
  }
  async prepare(input) {
    validateConfig(input, {
      allowLargeScript: (s) => {
        const old = this.value.schemes.find((item) => item.id === s.id);
        return (
          old?.activeScript?.status === "legacy" &&
          old.activeScript.script === s.script
        );
      },
    });
    const { enabled, shortcutMac, shortcutWin } =
      input.aiShortcut ?? this.value.aiShortcut;
    return {
      schemaVersion: 2,
      aiShortcut: { enabled, shortcutMac, shortcutWin },
      // 历史由后台执行结果和维护操作更新，普通配置保存不接收界面副本。
      promptHistory: this.value.promptHistory,
      schemes: input.schemes.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        script: s.script,
        prompt: s.prompt,
        enabled: s.enabled,
        disabled: s.disabled ?? false,
        directPaste:
          s.directPaste === true &&
          s.kind === "script" &&
          this.value.schemes.some(
            (old) => old.id === s.id && old.activeScript?.status === "verified",
          ),
        shortcutMac: s.shortcutMac,
        shortcutWin: s.shortcutWin,
        modelId: s.modelId,
        testCases: copyCases(s.testCases || []),
        // 生效版本只由后台激活流程维护，不接受界面传入的状态。
        activeScript: this.value.schemes.find((old) => old.id === s.id)
          ?.activeScript,
      })),
      models: await Promise.all(
        input.models.map(async (m) => {
          let encryptedKey = this.value.models.find(
            (old) => old.id === m.id,
          )?.encryptedKey;
          if (m.apiKey) encryptedKey = await this.vault.encrypt(m.apiKey, m.id);
          if (m.clearKey) encryptedKey = undefined;
          return {
            id: m.id,
            name: m.name,
            baseUrl: m.baseUrl,
            model: m.model,
            encryptedKey,
          };
        }),
      ),
    };
  }
  activateScript(id, expectedFingerprint, tests) {
    const scheme = this.value.schemes.find((s) => s.id === id);
    if (!scheme || scheme.kind !== "script")
      throw new Error("请先保存 JavaScript 处理草稿");
    const proof = tests.proof(id, scheme.script, scheme.testCases || []);
    if (!proof || proof.fingerprint !== expectedFingerprint)
      throw new Error("当前脚本和测试集尚未全部通过测试，请重新测试");
    return {
      ...this.value,
      schemes: this.value.schemes.map((s) =>
        s.id === id
          ? {
              ...s,
              activeScript: {
                script: s.script,
                testCases: copyCases(s.testCases || []),
                status: "verified",
                ...proof,
              },
            }
          : s,
      ),
    };
  }
  async persist(value) {
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
    this.value = value;
    return publicConfig(value);
  }
  async persistPromptHistory(promptHistory) {
    validatePromptHistory(promptHistory);
    await this.persist({ ...this.value, promptHistory });
    return promptHistory;
  }
  async getModel(id) {
    const m = this.value.models.find((m) => m.id === id);
    if (!m?.encryptedKey) throw new Error("请先为模型保存 API Key");
    return { ...m, apiKey: await this.vault.decrypt(m.encryptedKey, m.id) };
  }
}
module.exports = {
  validateConfig,
  publicConfig,
  ConfigStore,
};
