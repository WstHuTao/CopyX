import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  mkdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { LocalKeyVault } = require("../electron/core/local-vault.cjs");
const { ConfigStore } = require("../electron/core/config.cjs");
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "copyx-vault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, keyFile: path.join(dir, "master.key") };
}
const model = {
  id: "m",
  name: "模型",
  baseUrl: "https://example.com/v1",
  model: "model",
  apiKey: "test-not-real-本地密钥",
};

test("密钥本地加密保存，重启后可以解密且每次加密随机化", async (t) => {
  const { keyFile } = await fixture(t);
  const vault = new LocalKeyVault(keyFile);
  const first = await vault.encrypt(model.apiKey, "m"),
    second = await vault.encrypt(model.apiKey, "m");
  assert.notEqual(first, second);
  assert(!first.includes(model.apiKey));
  assert.equal(
    await new LocalKeyVault(keyFile).decrypt(first, "m"),
    model.apiKey,
  );
  assert.equal((await readFile(keyFile)).length, 32);
});
test("不同安装生成独立主密钥，密文不能跨主密钥或模型解密", async (t) => {
  const { dir, keyFile } = await fixture(t);
  const a = new LocalKeyVault(keyFile),
    b = new LocalKeyVault(path.join(dir, "other.key"));
  const text = await a.encrypt(model.apiKey, "m");
  await b.encrypt("x", "m");
  assert.notDeepEqual(
    await readFile(keyFile),
    await readFile(path.join(dir, "other.key")),
  );
  await assert.rejects(b.decrypt(text, "m"), /解密/);
  await assert.rejects(a.decrypt(text, "other"), /解密/);
});
test("密文被篡改时拒绝解密，不泄露原始密钥", async (t) => {
  const { keyFile } = await fixture(t),
    vault = new LocalKeyVault(keyFile);
  const value = await vault.encrypt(model.apiKey, "m");
  const payload = Buffer.from(value.slice("copyx:v1:".length), "base64");
  payload[payload.length - 1] ^= 1;
  await assert.rejects(
    vault.decrypt("copyx:v1:" + payload.toString("base64"), "m"),
    (e) => /解密/.test(e.message) && !e.message.includes(model.apiKey),
  );
});
test("主密钥缺失时不自动重建，不覆盖密文", async (t) => {
  const { keyFile } = await fixture(t),
    vault = new LocalKeyVault(keyFile);
  const value = await vault.encrypt(model.apiKey, "m");
  await rm(keyFile);
  await assert.rejects(
    new LocalKeyVault(keyFile).decrypt(value, "m"),
    /主密钥.*缺失/,
  );
  await assert.rejects(stat(keyFile), (e) => e.code === "ENOENT");
});
test("主密钥损坏时不自动替换或降级成明文", async (t) => {
  const { keyFile } = await fixture(t);
  await writeFile(keyFile, "broken");
  await assert.rejects(
    new LocalKeyVault(keyFile).encrypt(model.apiKey, "m"),
    /主密钥.*损坏/,
  );
  assert.equal(await readFile(keyFile, "utf8"), "broken");
});
test("并发首次保存使用同一个完整主密钥，并限制文件权限", async (t) => {
  const { keyFile } = await fixture(t);
  const a = new LocalKeyVault(keyFile),
    b = new LocalKeyVault(keyFile);
  const [one, two] = await Promise.all([
    a.encrypt("one", "m"),
    b.encrypt("two", "m"),
  ]);
  assert.equal(await a.decrypt(two, "m"), "two");
  assert.equal(await b.decrypt(one, "m"), "one");
  if (process.platform !== "win32")
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
});
test("配置重载可以直接调用已保存密钥，界面和磁盘不出现明文", async (t) => {
  const { dir, keyFile } = await fixture(t),
    configFile = path.join(dir, "config.json");
  const store = new ConfigStore(configFile, new LocalKeyVault(keyFile));
  await store.load();
  const view = await store.persist(
    await store.prepare({ schemes: [], models: [model] }),
  );
  assert(view.models[0].hasKey);
  assert.equal(view.models[0].needsKeyUpdate, false);
  assert(!JSON.stringify(view).includes(model.apiKey));
  assert(!JSON.stringify(view).includes("encryptedKey"));
  assert(!(await readFile(configFile, "utf8")).includes(model.apiKey));
  const restarted = new ConfigStore(configFile, new LocalKeyVault(keyFile));
  await restarted.load();
  assert.equal((await restarted.getModel("m")).apiKey, model.apiKey);
});
test("旧版系统加密密文保持原样，仅重新填写密钥时替换", async (t) => {
  const { dir, keyFile } = await fixture(t),
    configFile = path.join(dir, "config.json");
  const original = {
    schemes: [],
    models: [
      { ...model, apiKey: undefined, encryptedKey: "legacy-system-ciphertext" },
    ],
  };
  await writeFile(configFile, JSON.stringify(original));
  const store = new ConfigStore(configFile, new LocalKeyVault(keyFile));
  const visible = await store.load();
  assert.equal(visible.models[0].needsKeyUpdate, true);
  await assert.rejects(store.getModel("m"), /旧版.*重新填写/);
  await store.persist(await store.prepare(visible));
  assert.equal(
    JSON.parse(await readFile(configFile, "utf8")).models[0].encryptedKey,
    "legacy-system-ciphertext",
  );
  await store.persist(
    await store.prepare({
      ...visible,
      models: [{ ...visible.models[0], apiKey: model.apiKey }],
    }),
  );
  assert.equal((await store.getModel("m")).apiKey, model.apiKey);
});
test("主密钥路径不是普通文件时明确拒绝写入", async (t) => {
  const { keyFile } = await fixture(t);
  await mkdir(keyFile);
  await assert.rejects(
    new LocalKeyVault(keyFile).encrypt(model.apiKey, "m"),
    /主密钥/,
  );
  assert((await stat(keyFile)).isDirectory());
});
