const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const {
  randomBytes,
  createCipheriv,
  createDecipheriv,
} = require("node:crypto");
const PREFIX = "copyx:v1:";
function isLocalCiphertext(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}
class LocalKeyVault {
  constructor(file) {
    this.file = file;
  }
  async readMasterKey() {
    let handle;
    try {
      handle = await fs.open(
        this.file,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
      );
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== 32)
        throw new Error("本地主密钥文件损坏，请恢复备份后重试");
      const key = await handle.readFile();
      if (key.length !== 32)
        throw new Error("本地主密钥文件损坏，请恢复备份后重试");
      return key;
    } catch (error) {
      if (error.code === "ENOENT" || error.message.startsWith("本地主密钥"))
        throw error;
      throw new Error("无法读取本地主密钥文件，请检查文件和访问权限");
    } finally {
      await handle?.close();
    }
  }
  async createMasterKey() {
    const temp = this.file + "." + randomBytes(12).toString("hex") + ".tmp";
    let handle,
      owned = false;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      handle = await fs.open(temp, "wx", 0o600);
      owned = true;
      await handle.writeFile(randomBytes(32));
      await handle.sync();
      await handle.close();
      handle = null;
      // 完整写入后才发布主密钥；已有文件绝不覆盖，并发创建共用先发布的文件。
      try {
        await fs.link(temp, this.file);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } catch {
      throw new Error("无法创建本地主密钥文件，请检查本地存储目录权限");
    } finally {
      await handle?.close().catch(() => {});
      if (owned) await fs.unlink(temp).catch(() => {});
    }
  }
  async masterKey(create) {
    try {
      return await this.readMasterKey();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create)
        throw new Error(
          "本地主密钥文件缺失，请恢复备份，或在模型设置中重新填写 API Key",
        );
      await this.createMasterKey();
      return this.readMasterKey();
    }
  }
  async encrypt(value, modelId) {
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > 16384)
      throw new Error("API Key 必须为 16 KB 以内的非空文本");
    const key = await this.masterKey(true),
      nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.from("CopyX/APIKey/v1/" + modelId, "utf8"));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return (
      PREFIX +
      Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64")
    );
  }
  async decrypt(value, modelId) {
    if (!isLocalCiphertext(value))
      throw new Error(
        "此 API Key 使用旧版系统加密，请在模型设置中重新填写一次；其他配置已保留",
      );
    const encoded = value.slice(PREFIX.length);
    if (encoded.length > 24000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new Error("API Key 密文格式损坏，请重新填写");
    const payload = Buffer.from(encoded, "base64");
    if (payload.length < 29 || payload.toString("base64") !== encoded)
      throw new Error("API Key 密文格式损坏，请重新填写");
    const key = await this.masterKey(false);
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        payload.subarray(0, 12),
        { authTagLength: 16 },
      );
      decipher.setAAD(Buffer.from("CopyX/APIKey/v1/" + modelId, "utf8"));
      decipher.setAuthTag(payload.subarray(12, 28));
      return Buffer.concat([
        decipher.update(payload.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error(
        "无法解密 API Key，密文或主密钥不匹配，请恢复备份或重新填写",
      );
    }
  }
}
module.exports = { LocalKeyVault, isLocalCiphertext };
