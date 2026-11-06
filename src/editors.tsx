import { useLayoutEffect, useRef } from "react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import type { editor } from "monaco-editor";
import "monaco-editor/languages/definitions/javascript/register.js";

type DiffProps = {
  original: string;
  modified: string;
  options: editor.IDiffEditorConstructionOptions;
  onEdit: (value: string) => void;
};
export function DiffView({ original, modified, options, onEdit }: DiffProps) {
  const host = useRef<HTMLDivElement>(null),
    instance = useRef<editor.IStandaloneDiffEditor | null>(null),
    updating = useRef(false),
    onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  useLayoutEffect(() => {
    const before = monaco.editor.createModel(original, "plaintext");
    const after = monaco.editor.createModel(modified, "plaintext");
    const view = monaco.editor.createDiffEditor(host.current!, {
      ...options,
      theme: "workbench",
      originalAriaLabel: "原始内容，只读",
      modifiedAriaLabel: "处理结果",
    });
    instance.current = view;
    view.setModel({ original: before, modified: after });
    const listener = after.onDidChangeContent(() => {
      if (!updating.current) onEditRef.current(after.getValue());
    });
    return () => {
      listener.dispose();
      view.setModel(null);
      view.dispose();
      before.dispose();
      after.dispose();
      instance.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const view = instance.current;
    if (!view) return;
    updating.current = true;
    try {
      view.getModel()!.original.setValue(original);
    } finally {
      updating.current = false;
    }
  }, [original]);
  useLayoutEffect(() => {
    const view = instance.current;
    if (!view) return;
    updating.current = true;
    try {
      if (view.getModel()!.modified.getValue() !== modified) {
        view.getModel()!.modified.setValue(modified);
      }
    } finally {
      updating.current = false;
    }
  }, [modified]);
  useLayoutEffect(() => {
    const view = instance.current;
    view?.updateOptions(options);
    view?.getOriginalEditor().updateOptions({ ariaLabel: "原始内容，只读" });
    view?.getModifiedEditor().updateOptions({ ariaLabel: "处理结果" });
  }, [options]);
  return <div className="monaco-host" ref={host} />;
}
export function ScriptEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    instance = useRef<editor.IStandaloneCodeEditor | null>(null),
    updating = useRef(false),
    callback = useRef(onChange);
  callback.current = onChange;
  useLayoutEffect(() => {
    const model = monaco.editor.createModel(value, "javascript");
    const view = monaco.editor.create(host.current!, {
      model,
      ariaLabel: "处理脚本编辑器",
      readOnly,
      theme: "workbench",
      minimap: { enabled: false },
      fontSize: 14,
      automaticLayout: true,
      scrollBeyondLastLine: false,
    });
    instance.current = view;
    const listener = model.onDidChangeContent(() => {
      if (!updating.current) callback.current?.(model.getValue());
    });
    return () => {
      listener.dispose();
      view.setModel(null);
      view.dispose();
      model.dispose();
      instance.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const model = instance.current?.getModel();
    if (model && model.getValue() !== value) {
      updating.current = true;
      try {
        model.setValue(value);
      } finally {
        updating.current = false;
      }
    }
  }, [value]);
  useLayoutEffect(() => {
    instance.current?.updateOptions({ readOnly });
  }, [readOnly]);
  return <div className="monaco-host" ref={host} />;
}
