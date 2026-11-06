const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  checkShortcut: (value) => ipcRenderer.invoke("shortcut:check", value),
  beginShortcutRecording: () => ipcRenderer.invoke("shortcut:record-start"),
  endShortcutRecording: () => ipcRenderer.invoke("shortcut:record-end"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (value) => ipcRenderer.invoke("config:save", value),
  exportScheme: (value) => ipcRenderer.invoke("scheme:export", value),
  importScheme: () => ipcRenderer.invoke("scheme:import"),
  getScriptConversation: (schemeId) =>
    ipcRenderer.invoke("script:conversation-get", schemeId),
  discussScript: (value) => ipcRenderer.invoke("script:discuss", value),
  generateScript: (value) => ipcRenderer.invoke("script:generate", value),
  cancelScriptGeneration: (requestId) =>
    ipcRenderer.invoke("script:generate-cancel", requestId),
  testScript: (value) => ipcRenderer.invoke("script:test", value),
  cancelScriptTests: (requestId) =>
    ipcRenderer.invoke("script:test-cancel", requestId),
  activateScript: (value) => ipcRenderer.invoke("script:activate", value),
  run: (value) => ipcRenderer.invoke("process:run", value),
  runPrompt: (value) => ipcRenderer.invoke("process:run-prompt", value),
  updatePromptHistory: (value) =>
    ipcRenderer.invoke("prompt-history:update", value),
  cancel: () => ipcRenderer.invoke("process:cancel"),
  copy: (text) => ipcRenderer.invoke("clipboard:write", text),
  testModel: (id) => ipcRenderer.invoke("model:test", id),
  permission: () => ipcRenderer.invoke("permission:request"),
  onCapture: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on("capture", listener);
    return () => ipcRenderer.removeListener("capture", listener);
  },
  onNotice: (callback) => {
    const listener = (_, value) => callback(value);
    ipcRenderer.on("notice", listener);
    return () => ipcRenderer.removeListener("notice", listener);
  },
});
