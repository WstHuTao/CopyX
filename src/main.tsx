import "./tauri-desktop";
import "../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import React from "react";
import { createRoot } from "react-dom/client";
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import App from "./App";
import "./style.css";
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
monaco.editor.defineTheme("workbench", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#202124",
    "editorLineNumber.foreground": "#686b74",
    "diffEditor.insertedTextBackground": "#b8efce80",
    "diffEditor.removedTextBackground": "#ffd0d080",
    "diffEditor.insertedLineBackground": "#eefbf240",
    "diffEditor.removedLineBackground": "#fff2f240",
  },
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
