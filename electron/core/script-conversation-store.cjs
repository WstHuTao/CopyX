const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

// 仓储只验证可持久化的 JSON 边界，具体消息、草稿和测试集规则由上层负责。
function assertJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("会话记录必须为有效的 JSON 普通对象");
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    throw new Error("会话记录必须为有效的 JSON 普通对象");
  if (Object.getOwnPropertySymbols(value).length)
    throw new Error("会话记录不能包含非 JSON 字段");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, ancestors);
  } else {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, "value"))
        throw new Error("会话记录不能包含动态属性");
      assertJson(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

function snapshotRecord(record) {
  assertJson(record);
  if (
    !record ||
    Array.isArray(record) ||
    typeof record !== "object" ||
    typeof record.schemeId !== "string" ||
    !record.schemeId.trim() ||
    typeof record.id !== "string" ||
    !record.id.trim()
  ) {
    throw new Error("会话记录必须包含非空的方案编号和会话编号");
  }
  return structuredClone(record);
}

class ScriptConversationStore {
  #records = new Map();
  #loadPromise;
  #writes = Promise.resolve();
  #readOnly = false;

  constructor(file, { maxBytes = 16 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("会话存储大小限制必须为正整数");
    this.file = file;
    this.maxBytes = maxBytes;
    this.loadWarning = "";
  }

  async load() {
    this.#loadPromise ??= this.#read();
    await this.#loadPromise;
  }

  async #read() {
    let handle;
    try {
      handle = await fs.open(this.file, "r");
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > this.maxBytes)
        throw new Error("格式或大小异常");
      const data = await handle.readFile();
      if (data.length > this.maxBytes) throw new Error("大小超限");
      const stored = JSON.parse(data.toString("utf8"));
      if (
        !stored ||
        stored.version !== 1 ||
        !Array.isArray(stored.conversations)
      )
        throw new Error("未知格式");
      const loaded = new Map();
      for (const item of stored.conversations) {
        const record = snapshotRecord(item);
        loaded.set(record.schemeId, record);
      }
      this.#records = loaded;
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.#readOnly = true;
        this.loadWarning =
          "本地脚本会话文件无法读取、已损坏或格式不受支持，已进入只读保护；原文件保持不变，请备份并检查后重试。";
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  get(schemeId) {
    const record = this.#records.get(schemeId);
    return record ? structuredClone(record) : null;
  }

  async put(record) {
    // 在排队前取得快照，调用方后续编辑不会改变待保存内容。
    let snapshot;
    try {
      snapshot = snapshotRecord(record);
    } catch {
      throw new Error(
        "会话记录必须为有效的 JSON 普通对象，并包含非空的方案编号和会话编号",
      );
    }
    const write = this.#writes.then(async () => {
      await this.load();
      if (this.#readOnly)
        throw new Error("本地脚本会话处于只读保护，无法保存；请先检查原文件");
      const next = new Map(this.#records);
      next.set(snapshot.schemeId, snapshot);
      let serialized;
      try {
        serialized = JSON.stringify({
          version: 1,
          conversations: [...next.values()],
        });
      } catch {
        throw new Error("会话记录无法序列化，请检查内容结构和嵌套深度");
      }
      if (Buffer.byteLength(serialized, "utf8") > this.maxBytes)
        throw new Error("本地脚本会话总大小超过存储限制，请精简会话后重试");
      await this.#persist(serialized);
      this.#records = next;
    });
    // 单次失败不能阻断后续保存；每次写入从上一次成功的缓存开始。
    this.#writes = write.catch(() => {});
    await write;
  }

  async #persist(serialized) {
    const temporary = `${this.file}.${randomBytes(12).toString("hex")}.tmp`;
    let handle;
    let owned = false;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      handle = await fs.open(temporary, "wx", 0o600);
      owned = true;
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.file);
    } catch {
      throw new Error("本地脚本会话保存失败，请检查存储空间和目录访问权限");
    } finally {
      await handle?.close().catch(() => {});
      if (owned) await fs.unlink(temporary).catch(() => {});
    }
  }
}

module.exports = { ScriptConversationStore };
