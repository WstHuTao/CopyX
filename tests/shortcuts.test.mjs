import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const {
  normalizeShortcut,
  ShortcutManager,
  legacyAIShortcut,
  shortcutBindings,
} = createRequire(import.meta.url)("../electron/core/shortcuts.cjs");
function registry() {
  const own = new Map(),
    external = new Set();
  return {
    own,
    external,
    isRegistered: (key) => own.has(key),
    register(key, fn) {
      if (own.has(key) || external.has(key)) return false;
      own.set(key, fn);
      return true;
    },
    unregister: (key) => own.delete(key),
  };
}
const scheme = (id, key, enabled = true) => ({
  id,
  name: id,
  shortcutMac: key,
  shortcutWin: key,
  enabled,
});
test("Windows 上多条 AI 命令只注册一个共享键位，仍检测脚本冲突", () => {
  const config = {
    schemes: [
      { ...scheme("已关闭的 AI", "Control+Alt+3", false), kind: "ai" },
      { ...scheme("第一个 AI", "Control+Alt+4"), kind: "ai" },
      { ...scheme("第二个 AI", "Control+Alt+5"), kind: "ai" },
      { ...scheme("本地脚本", "Control+Alt+6"), kind: "script" },
    ],
  };
  config.aiShortcut = legacyAIShortcut(config.schemes);
  const api = registry(),
    calls = [];
  const manager = new ShortcutManager(api, "win32", (id, sharedAI) =>
    calls.push([id, sharedAI]),
  );
  const bindings = shortcutBindings(config);
  manager.apply(bindings);
  assert.deepEqual([...api.own.keys()], ["Control+Alt+6", "Control+Alt+4"]);
  api.own.get("Control+Alt+4")();
  assert.deepEqual(calls, [["ai-prompt-shortcut", true]]);
  assert.equal(
    manager.check({
      schemeId: "ai-prompt-shortcut",
      sharedAI: true,
      key: "Control+Alt+6",
      schemes: bindings,
    }).available,
    false,
  );
});
test("修饰键顺序、别名和大小写代表同一快捷键", () => {
  assert.equal(normalizeShortcut("shift+cmd+k", "darwin"), "Command+Shift+K");
  assert.equal(
    normalizeShortcut("CmdOrCtrl+Shift+k", "win32"),
    "Control+Shift+K",
  );
  assert.throws(() => normalizeShortcut("Shift+K", "darwin"), /需要搭配/);
});
test("重复快捷键在变更旧绑定之前拒绝", () => {
  const api = registry(),
    manager = new ShortcutManager(api, "darwin", () => {});
  manager.apply([scheme("原处理", "Command+Shift+1")]);
  assert.throws(
    () =>
      manager.apply([
        scheme("甲", "Cmd+Shift+K"),
        scheme("乙", "Shift+Command+K"),
      ]),
    /甲.*乙/,
  );
  assert(api.own.has("Command+Shift+1"));
});
test("预检查检测软件外部占用且不删除任何既有绑定", () => {
  const api = registry(),
    manager = new ShortcutManager(api, "darwin", () => {});
  manager.apply([scheme("原处理", "Command+Shift+1")]);
  api.external.add("Command+Shift+K");
  assert.equal(
    manager.check({ schemeId: "新处理", key: "Command+Shift+K", schemes: [] })
      .available,
    false,
  );
  assert.equal(
    manager.check({ schemeId: "原处理", key: "Command+Shift+1", schemes: [] })
      .available,
    true,
  );
  assert.deepEqual([...api.own.keys()], ["Command+Shift+1"]);
});
test("可用性探测只释放自己临时注册的快捷键", () => {
  const api = registry(),
    manager = new ShortcutManager(api, "darwin", () => {});
  assert.equal(
    manager.check({ schemeId: "甲", key: "Command+Shift+K", schemes: [] })
      .available,
    true,
  );
  assert.equal(api.own.size, 0);
});
test("录制时释放自身快捷键，恢复后仍触发原处理", () => {
  const api = registry(),
    calls = [],
    manager = new ShortcutManager(api, "darwin", (id) => calls.push(id));
  manager.apply([scheme("原处理", "Command+Shift+1")]);
  manager.suspend();
  assert.equal(api.own.size, 0);
  assert.equal(
    manager.check({
      schemeId: "新处理",
      key: "Command+Shift+1",
      schemes: [scheme("原处理", "Command+Shift+1")],
    }).available,
    false,
  );
  manager.resume();
  api.own.get("Command+Shift+1")();
  assert.deepEqual(calls, ["原处理"]);
});
test("保存注册失败会撤回新增项并保留旧绑定", () => {
  const api = registry(),
    manager = new ShortcutManager(api, "win32", () => {});
  manager.apply([scheme("旧", "Control+Alt+1")]);
  api.external.add("Control+Alt+3");
  assert.throws(
    () =>
      manager.apply([
        scheme("新甲", "Control+Alt+2"),
        scheme("新乙", "Control+Alt+3"),
      ]),
    /无法注册/,
  );
  assert.deepEqual([...api.own.keys()], ["Control+Alt+1"]);
});
test("关闭的处理不占用快捷键，常用复制粘贴组合不允许绑定", () => {
  const api = registry(),
    manager = new ShortcutManager(api, "darwin", () => {});
  manager.apply([
    scheme("甲", "Command+Shift+1"),
    scheme("乙", "Command+Shift+1", false),
  ]);
  assert.equal(
    manager.check({ schemeId: "甲", key: "Cmd+C", schemes: [] }).available,
    false,
  );
  assert.throws(() => manager.apply([scheme("甲", "Cmd+V")]), /常用系统/);
});
test("未保存的不同处理间重复能即时检测，其他系统字段不参与", () => {
  const api = registry(),
    manager = new ShortcutManager(api, "win32", () => {});
  assert.equal(
    manager.check({
      schemeId: "甲",
      key: "Ctrl+Alt+K",
      schemes: [scheme("乙", "Control+Alt+K")],
    }).available,
    false,
  );
  manager.apply([
    { ...scheme("甲", "Command+Shift+K"), shortcutWin: "Control+Alt+1" },
    { ...scheme("乙", "Command+Shift+K"), shortcutWin: "Control+Alt+2" },
  ]);
  assert.equal(api.own.size, 2);
});

test("停用旧处理后复用同一键位会触发新处理", () => {
  const api = registry(),
    calls = [];
  const manager = new ShortcutManager(api, "darwin", (id) => calls.push(id));
  manager.apply([scheme("旧处理", "Command+Shift+1")]);
  manager.apply([
    scheme("旧处理", "Command+Shift+1", false),
    scheme("新处理", "Shift+Cmd+1"),
  ]);
  api.own.get("Command+Shift+1")();
  assert.deepEqual(calls, ["新处理"]);
});

test("暂停指令释放独立及共享键位，重新启用仍检查冲突", () => {
  const config = {
    schemes: [
      { ...scheme("脚本", "Command+Shift+F9"), kind: "script", disabled: true },
      { ...scheme("AI", ""), kind: "ai", disabled: true, modelId: "model" },
    ],
    aiShortcut: scheme("共享", "Command+Shift+F9"),
  };
  assert.deepEqual(shortcutBindings(config), []);
  config.schemes[1].disabled = false;
  assert.equal(shortcutBindings(config).length, 1);
  config.schemes[0].disabled = false;
  const manager = new ShortcutManager(registry(), "darwin", () => {});
  assert.throws(() => manager.apply(shortcutBindings(config)), /冲突/);
});

test("最近提示词绑定的指令禁用后不会自动重放，恢复后仍保留原绑定", () => {
  const { latestPromptTarget } = createRequire(import.meta.url)(
    "../electron/core/prompt-history.cjs",
  );
  const config = {
    schemes: [{ id: "ai", kind: "ai", modelId: "model", disabled: true }],
    promptHistory: [
      {
        id: "history",
        lastRun: { schemeId: "ai", modelId: "model", prompt: "保留原文" },
      },
    ],
  };
  assert.equal(latestPromptTarget(config).scheme, undefined);
  assert.equal(latestPromptTarget(config).entry.id, "history");
  config.schemes[0].disabled = false;
  assert.equal(latestPromptTarget(config).scheme.id, "ai");
});
