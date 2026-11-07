import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [directory, notesPath] = process.argv.slice(2);
if (!directory || process.argv.length > 4) {
  throw new Error(
    "用法：node scripts/prepare-update.mjs <发布目录> [更新说明文件]",
  );
}
const { version } = JSON.parse(
  await readFile(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
);
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("更新清单只支持正式版版本号");
}

const release = `https://github.com/WstHuTao/CopyX/releases/download/v${version}`;
const platforms = {};
for (const [target, file] of [
  ["darwin-aarch64", `CopyX-${version}-macos-arm64.app.tar.gz`],
  ["windows-x86_64", `CopyX-${version}-windows-x64-setup.exe`],
]) {
  const info = await stat(join(directory, file));
  if (!info.isFile() || info.size === 0) throw new Error(`更新包无效：${file}`);
  const signature = (
    await readFile(join(directory, file + ".sig"), "utf8")
  ).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new Error(`更新包签名无效：${file}`);
  }
  const comment = Buffer.from(signature, "base64")
    .toString("utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith("trusted comment: "));
  if (!comment?.split("\t").includes(`version:${version}`)) {
    throw new Error(`更新包签名与当前版本不匹配：${file}`);
  }
  platforms[target] = { url: `${release}/${file}`, signature };
}

const notes = notesPath ? (await readFile(notesPath, "utf8")).trim() : "";
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};
await writeFile(
  join(directory, "latest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`已生成 CopyX ${version} 更新清单`);
