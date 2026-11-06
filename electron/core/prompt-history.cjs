const { randomUUID } = require("node:crypto");

function validatePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim())
    throw new Error("请填写提示词");
  if (Buffer.byteLength(prompt) > 4 * 1024 * 1024)
    throw new Error("提示词超过 4 MB，请缩短后再试");
}

function validatePromptHistory(entries) {
  if (!Array.isArray(entries) || entries.length > 500)
    throw new Error("提示词历史最多保留 500 条，请删除不再使用的记录");
  const ids = new Set(),
    prompts = new Set();
  for (const entry of entries) {
    if (
      typeof entry?.id !== "string" ||
      !entry.id ||
      ids.has(entry.id) ||
      typeof entry.favorite !== "boolean" ||
      prompts.has(entry.prompt) ||
      typeof entry.lastRun?.schemeId !== "string" ||
      !entry.lastRun.schemeId ||
      typeof entry.lastRun.modelId !== "string" ||
      !entry.lastRun.modelId
    )
      throw new Error("提示词历史格式不正确");
    validatePrompt(entry.prompt);
    validatePrompt(entry.lastRun.prompt);
    ids.add(entry.id);
    prompts.add(entry.prompt);
  }
  if (Buffer.byteLength(JSON.stringify(entries)) > 8 * 1024 * 1024)
    throw new Error("提示词历史超过 8 MB，请删除不再使用的记录");
}

function recordPromptUse(entries, { prompt, schemeId, modelId }, replayId) {
  const old = entries.find((entry) =>
    replayId ? entry.id === replayId : entry.prompt === prompt,
  );
  const entry = {
    id: old?.id || randomUUID(),
    prompt: old?.prompt ?? prompt,
    favorite: old?.favorite ?? false,
    lastRun: { prompt, schemeId, modelId },
  };
  return [entry, ...entries.filter((item) => item.id !== entry.id)];
}

function updatePromptHistory(entries, input) {
  const entry = entries.find((item) => item.id === input?.id);
  if (!entry) throw new Error("该提示词已不存在，请刷新历史后再试");
  if (input.action === "delete")
    return entries.filter((item) => item !== entry);
  if (input.action === "edit") {
    validatePrompt(input.prompt);
    if (entries.some((item) => item !== entry && item.prompt === input.prompt))
      throw new Error("历史中已存在相同的提示词");
    return entries.map((item) =>
      item === entry ? { ...entry, prompt: input.prompt } : item,
    );
  }
  if (input.action === "favorite" && typeof input.favorite === "boolean")
    return entries.map((item) =>
      item === entry ? { ...entry, favorite: input.favorite } : item,
    );
  throw new Error("提示词历史操作不正确");
}

function latestPromptTarget(config) {
  const entry = config.promptHistory[0];
  const scheme =
    entry &&
    config.schemes.find(
      (item) =>
        !item.disabled &&
        item.kind === "ai" &&
        item.id === entry.lastRun.schemeId &&
        item.modelId === entry.lastRun.modelId,
    );
  return { entry, scheme };
}

module.exports = {
  validatePrompt,
  validatePromptHistory,
  recordPromptUse,
  updatePromptHistory,
  latestPromptTarget,
};
