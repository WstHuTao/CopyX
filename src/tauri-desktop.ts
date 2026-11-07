import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Desktop } from "./desktop";

function subscribe<T>(event: string, callback: (value: T) => void) {
  let disposed = false;
  const remove = listen<T>(event, ({ payload }) => {
    if (!disposed) callback(payload);
  });
  void remove.catch(() => {});
  return () => {
    disposed = true;
    void remove.then(
      (unlisten) => unlisten(),
      () => {},
    );
  };
}

function command<T>(name: string) {
  return async (
    input?: unknown,
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> => {
    try {
      const data = await invoke<T>("desktop", {
        command: name,
        input: input ?? null,
      });
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: typeof error === "string" ? error : "桌面请求失败，请重试",
      };
    }
  };
}

let activeProcess: string | null = null;

function runProcess<T>(name: string) {
  const invokeProcess = command<T>(name);
  return async (input: object) => {
    if (activeProcess)
      return {
        ok: false as const,
        error: "已有任务正在执行，请完成或取消后再试",
      };
    const requestId = crypto.randomUUID();
    activeProcess = requestId;
    try {
      return await invokeProcess({ ...input, requestId });
    } finally {
      activeProcess = null;
    }
  };
}

if (!window.desktop && isTauri()) {
  window.desktop = {
    platform: /Windows/.test(navigator.userAgent) ? "win32" : "darwin",
    checkShortcut: command("shortcut:check"),
    beginShortcutRecording: command("shortcut:record-start"),
    endShortcutRecording: command("shortcut:record-end"),
    getConfig: command("config:get"),
    saveConfig: command("config:save"),
    exportScheme: command("scheme:export"),
    importScheme: command("scheme:import"),
    run: runProcess("process:run"),
    runPrompt: runProcess("process:run-prompt"),
    updatePromptHistory: command("prompt-history:update"),
    getScriptConversation: command("script:conversation-get"),
    discussScript: command("script:discuss"),
    generateScript: command("script:generate"),
    cancelScriptGeneration: command("script:generate-cancel"),
    testScript: command("script:test"),
    cancelScriptTests: command("script:test-cancel"),
    activateScript: command("script:activate"),
    cancel: () => command<void>("process:cancel")(activeProcess),
    copy: command("clipboard:write"),
    testModel: command("model:test"),
    permission: command("permission:request"),
    confirm: command("dialog:confirm"),
    onCapture: (callback) => subscribe("copyx-capture", callback),
    onNotice: (callback) => subscribe("copyx-notice", callback),
    onUpdateStatus: (callback) => subscribe("copyx-update-status", callback),
  } satisfies Desktop;
}
