import { useCallback, useEffect, useRef, useState } from "react";
import { DiffView } from "./editors";
import { Select } from "./Select";
import { ShortcutInput } from "./ShortcutInput";
import { SettingsActions } from "./SettingsActions";
import { ScriptSettings } from "./ScriptSettings";
import { PromptHistory, PromptQuickChoices } from "./PromptHistory";
import brandMark from "../assets/copyx-brand.png";
import {
  Code2,
  Layers,
  Settings,
  Play,
  Copy,
  Plus,
  Trash2,
  Square,
  Monitor,
  ShieldCheck,
  ChevronDown,
  FileUp,
  Share2,
} from "lucide-react";
import {
  aiShortcutId,
  confirmAction,
  emptyShortcut,
  unwrap,
  type Config,
  type Scheme,
  type Model,
  type PromptEntry,
} from "./desktop";
const sample = "公司名称\t联系人\t电话\r\n示例公司\t张三\t13800000000\r\n";
const api = window.desktop;
const empty: Config = { schemes: [], models: [] };
export default function App() {
  const [config, setConfig] = useState<Config>(empty),
    [draft, setDraft] = useState<Config>(empty);
  const [page, setPage] = useState<"work" | "schemes" | "models">("work");
  const [selected, setSelected] = useState(""),
    [editing, setEditing] = useState(""),
    [editingModel, setEditingModel] = useState("");
  const [original, setOriginal] = useState(""),
    [result, setResult] = useState(""),
    [hasProcessed, setHasProcessed] = useState(false);
  const [promptDraft, setPromptDraft] = useState<{
    schemeId: string;
    text: string;
  } | null>(null);
  const [promptHistory, setPromptHistory] = useState<PromptEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [basicExpanded, setBasicExpanded] = useState(false);
  const [connection, setConnection] = useState<{
    id: string;
    state: "testing" | "passed" | "failed";
    message: string;
  } | null>(null);
  const manualInput = useRef<HTMLDetailsElement>(null);
  const manualText = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState("就绪"),
    [error, setError] = useState(false),
    [highlight, setHighlight] = useState(true),
    [whitespace, setWhitespace] = useState(false),
    [ready, setReady] = useState(false),
    [unsaved, setUnsaved] = useState(false);
  const dirty = useRef(false),
    resultRef = useRef(""),
    busyRef = useRef(false),
    configRef = useRef(config),
    saveBusy = useRef(false);
  const scheme = config.schemes.find((s) => s.id === selected);
  const editScheme = draft.schemes.find((s) => s.id === editing);
  const editModel = draft.models.find((m) => m.id === editingModel);
  const storedEditScheme = config.schemes.find((s) => s.id === editing);
  const [switchSaving, setSwitchSaving] = useState(false);
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const editingShortcut =
    editScheme?.kind === "ai" ? draft.aiShortcut : editScheme;
  const editingShortcutText = editingShortcut?.enabled
    ? api?.platform === "win32"
      ? editingShortcut.shortcutWin
      : editingShortcut.shortcutMac
    : "";
  const workModel = config.models.find((m) => m.id === scheme?.modelId);
  const prompt =
    promptDraft?.schemeId === selected
      ? promptDraft.text
      : (promptHistory.find((entry) => entry.lastRun.schemeId === selected)
          ?.lastRun.prompt ??
        scheme?.prompt ??
        "");
  const setPrompt = (text: string) =>
    setPromptDraft({ schemeId: selected, text });
  const notify = useCallback((message: string, isError = false) => {
    setStatus(message);
    setError(isError);
  }, []);
  const generationBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  }, []);
  const refresh = (value: Config) => {
    const { promptHistory, startupWarning, ...settings } = value;
    setPromptHistory(promptHistory ?? []);
    setConfig(settings);
    configRef.current = settings;
    setDraft(structuredClone(settings));
    setUnsaved(false);
    if (startupWarning) notify(startupWarning, true);
    setSelected((old) =>
      value.schemes.some((s) => s.id === old)
        ? old
        : value.schemes[0]?.id || "",
    );
    setEditing((old) =>
      value.schemes.some((s) => s.id === old)
        ? old
        : value.schemes[0]?.id || "",
    );
    setEditingModel((old) =>
      value.models.some((m) => m.id === old) ? old : value.models[0]?.id || "",
    );
  };
  useEffect(() => {
    if (!api) {
      notify("请从桌面应用启动；浏览器仅供界面预览", true);
      return;
    }
    void unwrap(api.getConfig())
      .then((value) => {
        refresh(value);
        setReady(true);
      })
      .catch((e) => notify(e.message, true));
    const stopNotice = api.onNotice((message) => notify(message, true));
    const stopUpdateStatus = api.onUpdateStatus?.((message) => notify(message));
    return () => {
      stopNotice();
      stopUpdateStatus?.();
    };
  }, [notify]);
  useEffect(() => {
    const check = api?.availableUpdate;
    if (!check) return;
    let disposed = false;
    const refreshUpdate = async () => {
      try {
        const version = await unwrap(check());
        if (!disposed) setAvailableVersion(version);
      } catch {
        // 后台检查失败时保留上一次状态，避免打断当前工作。
      }
    };
    void refreshUpdate();
    const timer = window.setInterval(refreshUpdate, 6 * 60 * 60 * 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);
  const execute = useCallback(
    async (
      text: string,
      current: Scheme,
      temporaryPrompt?: string,
      latestPromptId?: string,
    ) => {
      if (!api || busyRef.current) return;
      if (current.disabled) {
        notify("此自定义指令已禁用，请在自定义处理中启用并保存", true);
        return;
      }
      busyRef.current = true;
      setBusy(true);
      notify(
        current.kind === "ai"
          ? "正在调用模型，文本将发送到所选服务…"
          : "正在执行脚本…",
      );
      try {
        const input = { text, schemeId: current.id };
        const processed =
          current.kind === "ai"
            ? await unwrap(
                api.runPrompt({
                  ...input,
                  prompt: temporaryPrompt,
                  latestPromptId,
                }),
              )
            : { text: await unwrap(api.run(input)) };
        const output = processed.text;
        resultRef.current = output;
        setResult(output);
        setHasProcessed(true);
        dirty.current = false;
        if ("history" in processed) setPromptHistory(processed.history);
        const warning =
          "historyWarning" in processed ? processed.historyWarning : undefined;
        notify(warning || "处理完成，请对照确认后复制", Boolean(warning));
      } catch (e) {
        notify((e as Error).message, true);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [notify],
  );
  useEffect(
    () =>
      api?.onCapture(
        async ({
          text,
          schemeId,
          prompt,
          latestPromptId,
          promptNotice,
          prepared,
        }) => {
          if (busyRef.current || saveBusy.current) return;
          if (
            dirty.current &&
            !(await confirmAction("右侧有人工修改，是否放弃并处理新内容？"))
          )
            return;
          if (busyRef.current || saveBusy.current) return;
          const current = configRef.current.schemes.find(
            (s) => s.id === schemeId,
          );
          if (!current || current.disabled) return;
          setOriginal(text);
          setResult("");
          setHasProcessed(false);
          resultRef.current = "";
          dirty.current = false;
          setHistoryOpen(false);
          setSelected(schemeId);
          setPromptDraft(
            current.kind === "ai"
              ? { schemeId, text: prompt ?? current.prompt }
              : null,
          );
          setPage("work");
          if (prepared) {
            if ("error" in prepared) {
              notify(prepared.error, true);
            } else {
              resultRef.current = prepared.result;
              setResult(prepared.result);
              setHasProcessed(true);
              notify(prepared.notice);
            }
          } else if (promptNotice) notify(promptNotice);
          else void execute(text, current, prompt, latestPromptId);
        },
      ),
    [execute, notify],
  );
  const cancel = async () => {
    if (api) await api.cancel();
  };
  const run = async () => {
    if (!scheme) return;
    if (
      dirty.current &&
      !(await confirmAction("重新执行会覆盖右侧人工修改，是否继续？"))
    )
      return;
    void execute(original, scheme, prompt);
  };
  const copy = async (text: string, label: string) => {
    if (!api) return;
    try {
      await unwrap(api.copy(text));
      notify(label + "已复制");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const save = async (value = draft) => {
    if (!api || saveBusy.current) return;
    saveBusy.current = true;
    setSaving(true);
    try {
      const saved = await unwrap(api.saveConfig(value));
      refresh(saved);
      notify("配置已保存");
      return saved;
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      saveBusy.current = false;
      setSaving(false);
    }
  };
  const toggleInstruction = async () => {
    if (!api || !storedEditScheme || saveBusy.current || busyRef.current)
      return;
    const id = storedEditScheme.id;
    const disabled = !storedEditScheme.disabled;
    saveBusy.current = true;
    setSaving(true);
    setSwitchSaving(true);
    try {
      // 开关只保存已落盘配置的状态，不提交或覆盖编辑中的草稿。
      const persisted = await unwrap(api.getConfig());
      if (!persisted.schemes.some((item) => item.id === id))
        throw new Error("此指令已不存在，请重新打开设置");
      const saved = await unwrap(
        api.saveConfig({
          ...persisted,
          schemes: persisted.schemes.map((item) =>
            item.id === id ? { ...item, disabled } : item,
          ),
        }),
      );
      const { promptHistory, startupWarning, ...settings } = saved;
      setConfig(settings);
      configRef.current = settings;
      setPromptHistory(promptHistory ?? []);
      setDraft((value) => ({
        ...value,
        schemes: value.schemes.map((item) =>
          item.id === id ? { ...item, disabled } : item,
        ),
      }));
      notify(disabled ? "指令已禁用" : "指令已启用");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      saveBusy.current = false;
      setSaving(false);
      setSwitchSaving(false);
    }
  };
  const updateScheme = (patch: Partial<Scheme>) => {
    setDraft((value) => ({
      ...value,
      schemes: value.schemes.map((s) =>
        s.id === editing ? { ...s, ...patch } : s,
      ),
    }));
    setUnsaved(true);
  };
  const updateModel = (patch: Partial<Model>) => {
    setConnection(null);
    setDraft((value) => ({
      ...value,
      models: value.models.map((m) =>
        m.id === editingModel ? { ...m, ...patch } : m,
      ),
    }));
    setUnsaved(true);
  };
  const navigate = async (next: typeof page) => {
    if (busy || saveBusy.current || next === page) return;
    if (unsaved) {
      if (
        !(await confirmAction("切换页面会放弃尚未保存的配置修改，是否继续？"))
      )
        return;
      setDraft(structuredClone(config));
      setUnsaved(false);
    }
    setPage(next);
    setStatus("就绪");
    setError(false);
  };
  const addScheme = () => {
    const item: Scheme = {
      id: crypto.randomUUID(),
      name: "新处理",
      kind: "script",
      script: "function transform(text) {\n  return text;\n}",
      prompt: "只输出转换后的文本，保留原始信息，不补充缺失内容。",
      enabled: false,
      shortcutMac: "",
      shortcutWin: "",
    };
    setDraft({ ...draft, schemes: [...draft.schemes, item] });
    setEditing(item.id);
    setBasicExpanded(true);
    setUnsaved(true);
  };
  async function transferScheme(direction: "import" | "export") {
    if (!api || busyRef.current || saveBusy.current) return;
    if (direction === "import" && draft.schemes.length >= 100) {
      notify("自定义处理最多保留 100 条，请先删除不再使用的处理", true);
      return;
    }
    generationBusy(true);
    notify(direction === "export" ? "正在准备分享文件…" : "正在导入处理…");
    try {
      if (direction === "export") {
        if (!editScheme) return;
        const { name, kind, script, prompt, testCases } = editScheme;
        const exported = await unwrap(
          api.exportScheme({ name, kind, script, prompt, testCases }),
        );
        notify(
          exported ? "分享文件已保存，可以发送给其他 CopyX 用户" : "已取消分享",
        );
      } else {
        const imported = await unwrap(api.importScheme());
        if (!imported) {
          notify("已取消导入");
          return;
        }
        setDraft((current) => {
          const names = new Set(current.schemes.map((item) => item.name));
          let name = imported.name;
          for (let i = 1; names.has(name); i++)
            name = `${imported.name}（导入${i === 1 ? "" : ` ${i}`}）`;
          return {
            ...current,
            schemes: [...current.schemes, { ...imported, name }],
          };
        });
        setEditing(imported.id);
        setBasicExpanded(true);
        setUnsaved(true);
        notify(
          imported.kind === "script"
            ? "已导入脚本草稿，测试通过后可启用此版本"
            : "已导入 AI 处理草稿，请选择本机模型并保存配置",
        );
      }
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      generationBusy(false);
    }
  }
  const addModel = () => {
    const item: Model = {
      id: crypto.randomUUID(),
      name: "新模型配置",
      baseUrl: "",
      model: "",
    };
    setDraft({ ...draft, models: [...draft.models, item] });
    setEditingModel(item.id);
    setUnsaved(true);
  };
  const testModel = async () => {
    if (!api || !editModel) return;
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    busyRef.current = true;
    try {
      setConnection({
        id: editModel.id,
        state: "testing",
        message: "正在测试连接…",
      });
      notify("正在测试连接…");
      const message = await unwrap(api.testModel(editModel.id));
      setConnection({ id: editModel.id, state: "passed", message });
      notify(message);
    } catch (e) {
      setConnection({
        id: editModel.id,
        state: "failed",
        message: (e as Error).message,
      });
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };
  const loadSample = async () => {
    if (dirty.current && !(await confirmAction("是否放弃人工修改并载入样例？")))
      return;
    setOriginal(sample);
    setResult("");
    setHasProcessed(false);
    resultRef.current = "";
    dirty.current = false;
    notify("样例已载入，可以执行处理");
  };
  const openManualInput = () => {
    if (manualInput.current) manualInput.current.open = true;
    manualText.current?.focus();
  };
  return (
    <div className="app">
      <aside>
        <div className="sidebar-brand" aria-label="CopyX">
          <img src={brandMark} alt="" width="36" height="36" />
          <span>CopyX</span>
          {availableVersion && api?.openUpdate && (
            <button
              className="update-badge"
              aria-label={`查看 CopyX ${availableVersion} 更新`}
              title={`CopyX ${availableVersion} 可更新`}
              onClick={() => {
                if (api.openUpdate)
                  void unwrap(api.openUpdate()).catch((error) =>
                    notify((error as Error).message, true),
                  );
              }}
            >
              NEW
            </button>
          )}
        </div>
        <nav aria-label="主导航">
          {(
            [
              ["work", Code2, "处理工作台"],
              ["schemes", Layers, "自定义处理"],
              ["models", Settings, "模型设置"],
            ] as const
          ).map(([id, Icon, title]) => (
            <button
              key={id}
              className={page === id ? "nav active" : "nav"}
              aria-current={page === id ? "page" : undefined}
              onClick={() => navigate(id)}
              disabled={busy || saving}
            >
              <Icon size={19} />
              {title}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <div className="runtime">
            <Monitor size={17} />
            {api?.platform === "win32" ? "Windows" : "macOS"} · 本地运行
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <h1>
              {page === "work"
                ? "处理工作台"
                : page === "schemes"
                  ? "自定义处理"
                  : "模型设置"}
            </h1>
            {page !== "schemes" && (
              <p>
                {page === "work"
                  ? "对照原文，确认每一处变化。"
                  : "配置模型服务，密钥在本机加密保存。"}
              </p>
            )}
          </div>
          {page !== "work" && (
            <span className={"save-state " + (unsaved ? "pending" : "")}>
              {saving ? "正在保存…" : unsaved ? "有未保存修改" : "设置已保存"}
            </span>
          )}
        </header>
        {page === "work" ? (
          <div className="workspace">
            <div className="toolbar">
              <Select
                aria-label="自定义处理"
                value={selected}
                disabled={busy || saving}
                onChange={async (e) => {
                  const next = e.currentTarget.value;
                  if (
                    dirty.current &&
                    !(await confirmAction(
                      "切换方案会保留当前结果，执行后才覆盖，是否继续？",
                    ))
                  )
                    return;
                  setSelected(next);
                  setPromptDraft(null);
                }}
              >
                {config.schemes.length === 0 && (
                  <option value="">请先添加自定义处理</option>
                )}
                {config.schemes.map((s) => (
                  <option value={s.id} key={s.id} disabled={s.disabled}>
                    {s.name}
                    {s.disabled
                      ? " · 已禁用"
                      : s.kind === "ai"
                        ? " · AI 命令"
                        : ""}
                  </option>
                ))}
              </Select>
              <button
                className={hasProcessed ? "" : "primary"}
                disabled={
                  !scheme ||
                  scheme.disabled ||
                  busy ||
                  !ready ||
                  !original ||
                  (scheme.kind === "ai" && (!workModel || !prompt.trim())) ||
                  (scheme.kind === "script" && !scheme.activeScript)
                }
                onClick={run}
              >
                <Play size={16} />
                执行处理
              </button>
              {busy && (
                <button onClick={() => void cancel()}>
                  <Square size={14} />
                  取消处理
                </button>
              )}
              <button
                className="quiet"
                disabled={busy || saving}
                onClick={async () => {
                  if (!api) return;
                  try {
                    const allowed = await unwrap(api.permission());
                    notify(
                      allowed
                        ? "辅助功能权限已就绪"
                        : "macOS 未授权当前 CopyX。请在系统设置 → 隐私与安全性 → 辅助功能中开启 CopyX；若已开启，请移除旧条目并重新添加当前安装的 CopyX。",
                      !allowed,
                    );
                  } catch (error) {
                    notify((error as Error).message, true);
                  }
                }}
              >
                权限检查
              </button>
              <span className="spacer" />
              {original && (
                <button
                  disabled={busy || saving}
                  onClick={() => void loadSample()}
                >
                  载入样例
                </button>
              )}
            </div>
            {scheme?.disabled && (
              <div className="paused-notice" role="status">
                此指令已禁用，请启用或选择其他指令。
              </div>
            )}
            {scheme?.kind === "ai" ? (
              <section className="instruction">
                <div className="instruction-title">
                  <ChevronDown size={16} />
                  本次提示词
                  <span>
                    {workModel
                      ? `文本将发送到 ${workModel.name}`
                      : "请在自定义处理中选择模型配置"}
                  </span>
                </div>
                <textarea
                  aria-label="本次提示词"
                  placeholder="输入处理要求，或从历史中选择提示词"
                  value={prompt}
                  disabled={busy || saving}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <div className="prompt-quick-actions">
                  <PromptQuickChoices
                    entries={promptHistory}
                    value={prompt}
                    disabled={busy || saving}
                    onUse={setPrompt}
                  />
                  <button
                    className="small"
                    aria-haspopup="dialog"
                    disabled={busy || saving}
                    onClick={() => setHistoryOpen(true)}
                  >
                    提示词历史
                  </button>
                </div>
                <PromptHistory
                  open={historyOpen}
                  entries={promptHistory}
                  disabled={busy || saving}
                  onClose={() => setHistoryOpen(false)}
                  onUse={(text) => {
                    setPrompt(text);
                    setHistoryOpen(false);
                  }}
                  onUpdate={async (action) => {
                    if (api)
                      setPromptHistory(
                        await unwrap(api.updatePromptHistory(action)),
                      );
                  }}
                />
              </section>
            ) : (
              <div className="instruction compact">
                <ShieldCheck size={17} />
                <span>
                  {!scheme?.activeScript
                    ? "此草稿尚未生效，请先到自定义处理运行测试并生效"
                    : scheme.activeScript.status === "legacy"
                      ? "本地脚本处理 · 当前使用尚未验证的旧脚本"
                      : "本地脚本处理 · 当前使用测试通过的生效版本"}
                </span>
                <span className="shortcut">
                  {scheme?.enabled &&
                    (api?.platform === "win32"
                      ? scheme.shortcutWin
                      : scheme.shortcutMac)}
                </span>
              </div>
            )}
            <div className="view-options">
              <span>
                {original.length.toLocaleString()} 字符 ·{" "}
                {scheme?.kind === "ai" ? "AI 命令" : "本地脚本"}
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={highlight}
                  onChange={(e) => setHighlight(e.target.checked)}
                />
                差异高亮
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={whitespace}
                  onChange={(e) => setWhitespace(e.target.checked)}
                />
                显示空白
              </label>
            </div>
            <div className={"diff-shell " + (!highlight ? "no-diff" : "")}>
              <div className="diff-headers">
                <div>
                  <strong>原始内容</strong>
                  <span>只读</span>
                  <button
                    onClick={() => void copy(original, "原文")}
                    disabled={!original}
                  >
                    <Copy size={15} />
                    复制原文
                  </button>
                </div>
                <div>
                  <strong>处理结果</strong>
                  <span>可编辑</span>
                  <button
                    className={hasProcessed ? "primary" : ""}
                    onClick={() => void copy(resultRef.current, "结果")}
                    disabled={busy || !hasProcessed}
                  >
                    <Copy size={15} />
                    复制结果
                  </button>
                </div>
              </div>
              <div className="editor-area">
                <DiffView
                  original={original}
                  modified={result}
                  options={{
                    originalEditable: false,
                    readOnly: busy,
                    renderSideBySide: true,
                    enableSplitViewResizing: false,
                    renderSideBySideInlineBreakpoint: 0,
                    ignoreTrimWhitespace: false,
                    renderIndicators: highlight,
                    renderWhitespace: whitespace ? "all" : "none",
                    minimap: { enabled: false },
                    fontSize: 14,
                    lineHeight: 25,
                    fontFamily: "SFMono-Regular, Consolas, monospace",
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: "off",
                    padding: { top: 18 },
                    diffWordWrap: "off",
                    unicodeHighlight: { ambiguousCharacters: false },
                    renderOverviewRuler: false,
                    hideUnchangedRegions: { enabled: false },
                  }}
                  onEdit={(value) => {
                    dirty.current = true;
                    resultRef.current = value;
                    setResult(value);
                    setHasProcessed(true);
                  }}
                />
                {!original && (
                  <div className="empty-hint">
                    <strong>从一段文本开始</strong>
                    <p>
                      在其他应用选中文字，按专用快捷键打开；也可以直接输入。
                    </p>
                    <div className="empty-actions">
                      <button
                        className="primary"
                        disabled={busy || saving}
                        onClick={openManualInput}
                      >
                        输入文本
                      </button>
                      <button
                        disabled={busy || saving}
                        onClick={() => void loadSample()}
                      >
                        载入样例
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <details className="manual-input" ref={manualInput}>
              <summary>手动输入原文</summary>
              <textarea
                ref={manualText}
                aria-label="手动输入原文"
                disabled={busy || saving}
                value={original}
                onChange={async (e) => {
                  const next = e.currentTarget.value;
                  if (
                    dirty.current &&
                    !(await confirmAction("修改原文将清空人工结果，是否继续？"))
                  )
                    return;
                  setOriginal(next);
                  setResult("");
                  setHasProcessed(false);
                  resultRef.current = "";
                  dirty.current = false;
                }}
              />
            </details>
          </div>
        ) : (
          <div className="management">
            <section className="item-list">
              <div className="item-list-actions">
                <button
                  className="add"
                  disabled={busy || saving}
                  onClick={page === "schemes" ? addScheme : addModel}
                >
                  <Plus size={16} />
                  {page === "schemes" ? "新增处理" : "新增模型"}
                </button>
                {page === "schemes" && (
                  <button
                    disabled={busy || saving || !ready}
                    onClick={() => void transferScheme("import")}
                  >
                    <FileUp size={15} />
                    导入处理
                  </button>
                )}
              </div>
              {(page === "schemes" ? draft.schemes : draft.models).map(
                (item) => (
                  <button
                    key={item.id}
                    disabled={busy || saving}
                    className={
                      "item " +
                      ((page === "schemes" ? editing : editingModel) === item.id
                        ? "selected"
                        : "")
                    }
                    onClick={() => {
                      if (page === "schemes") {
                        setEditing(item.id);
                        setBasicExpanded(false);
                      } else setEditingModel(item.id);
                      notify("就绪");
                    }}
                  >
                    <strong>{item.name}</strong>
                    {"kind" in item && item.disabled && (
                      <span className="item-state">已禁用</span>
                    )}
                    <small>
                      {"kind" in item
                        ? item.kind === "script"
                          ? "JavaScript 脚本"
                          : "AI 提示词命令"
                        : (item as Model).model || "待配置"}
                    </small>
                  </button>
                ),
              )}
            </section>
            <section
              className={
                "form-panel " +
                (page === "schemes" && editScheme?.kind === "script"
                  ? "script-form"
                  : "standard-form")
              }
            >
              {page === "schemes" && editScheme ? (
                <>
                  <div className="form-heading">
                    <div className="processing-heading">
                      <h2>{editScheme.name || "未命名处理"}</h2>
                      <span>
                        {editScheme.kind === "script"
                          ? "JavaScript 脚本"
                          : "AI 提示词命令"}
                      </span>
                    </div>
                    <div className="form-heading-actions">
                      <button
                        className="instruction-switch"
                        role="switch"
                        aria-label="启用指令"
                        aria-checked={!editScheme.disabled}
                        disabled={busy || saving || !ready || !storedEditScheme}
                        title={storedEditScheme ? "立即生效" : "请先保存此指令"}
                        onClick={() => void toggleInstruction()}
                      >
                        <span className="switch-track" aria-hidden="true" />
                        {switchSaving
                          ? "保存中…"
                          : !storedEditScheme
                            ? "未保存"
                            : editScheme.disabled
                              ? "已禁用"
                              : "已启用"}
                      </button>
                      <button
                        className="quiet"
                        aria-expanded={basicExpanded}
                        aria-controls="processing-basics"
                        onClick={() => setBasicExpanded(!basicExpanded)}
                      >
                        {basicExpanded ? "收起设置" : "编辑设置"}
                      </button>
                      <button
                        disabled={busy || saving || !ready}
                        onClick={() => void transferScheme("export")}
                      >
                        <Share2 size={15} />
                        分享
                      </button>
                      <button
                        className="danger"
                        disabled={busy || saving}
                        onClick={async () => {
                          if (
                            await confirmAction(
                              "确定删除此处理？保存设置后生效。",
                            )
                          ) {
                            setDraft({
                              ...draft,
                              schemes: draft.schemes.filter(
                                (s) => s.id !== editing,
                              ),
                            });
                            setEditing("");
                            setUnsaved(true);
                          }
                        }}
                      >
                        <Trash2 size={15} />
                        删除
                      </button>
                    </div>
                  </div>
                  <fieldset
                    className="scheme-basics"
                    id="processing-basics"
                    hidden={!basicExpanded}
                    disabled={busy || saving}
                  >
                    <label>
                      处理名称
                      <input
                        value={editScheme.name}
                        onChange={(e) => updateScheme({ name: e.target.value })}
                      />
                    </label>
                    <label>
                      处理类型
                      <Select
                        aria-label="处理类型"
                        disabled={busy || saving}
                        value={editScheme.kind}
                        onChange={(e) =>
                          updateScheme({
                            kind: e.target.value as Scheme["kind"],
                            modelId: editScheme.modelId || draft.models[0]?.id,
                          })
                        }
                      >
                        <option value="script">JavaScript 脚本</option>
                        <option value="ai">AI 提示词命令</option>
                      </Select>
                    </label>
                    <ShortcutInput
                      key={
                        editScheme.kind === "ai"
                          ? aiShortcutId
                          : "shortcut-" + editScheme.id
                      }
                      scheme={
                        editScheme.kind === "ai"
                          ? {
                              ...(draft.aiShortcut ?? emptyShortcut),
                              id: aiShortcutId,
                            }
                          : editScheme
                      }
                      schemes={draft.schemes}
                      aiShortcut={draft.aiShortcut}
                      sharedAI={editScheme.kind === "ai"}
                      disabled={busy || saving}
                      onChange={(patch) => {
                        if (editScheme.kind === "script") updateScheme(patch);
                        else {
                          setDraft((value) => ({
                            ...value,
                            aiShortcut: {
                              ...(value.aiShortcut ?? emptyShortcut),
                              ...patch,
                            },
                          }));
                          setUnsaved(true);
                        }
                      }}
                      notify={notify}
                    />
                    {editScheme.kind === "script" && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={editScheme.directPaste === true}
                          disabled={
                            storedEditScheme?.activeScript?.status !==
                            "verified"
                          }
                          onChange={(e) =>
                            updateScheme({ directPaste: e.target.checked })
                          }
                        />
                        处理后直接复制
                        {storedEditScheme?.activeScript?.status !==
                          "verified" && (
                          <small>测试通过并启用脚本后可设置</small>
                        )}
                      </label>
                    )}
                  </fieldset>
                  {!basicExpanded && !editScheme.disabled && (
                    <div className="processing-shortcut-summary">
                      {editingShortcutText ? (
                        <>
                          专用快捷键 <kbd>{editingShortcutText}</kbd>
                        </>
                      ) : (
                        "未设置快捷键"
                      )}
                    </div>
                  )}
                  {editScheme.kind === "script" ? (
                    <ScriptSettings
                      key={"script-" + editScheme.id}
                      scheme={editScheme}
                      saving={saving}
                      onSave={() => void save()}
                      models={config.models}
                      busy={busy}
                      onChange={updateScheme}
                      onBusyChange={generationBusy}
                      notify={notify}
                      onActivate={async (fingerprint) => {
                        const saved = await save();
                        if (!saved || !api) return;
                        try {
                          refresh(
                            await unwrap(
                              api.activateScript({
                                schemeId: editScheme.id,
                                fingerprint,
                              }),
                            ),
                          );
                          notify(
                            saved.schemes.find((s) => s.id === editScheme.id)
                              ?.disabled
                              ? "脚本版本已更新；此指令仍处于禁用状态"
                              : "脚本已通过测试并生效，后续处理将使用此版本",
                          );
                        } catch (e) {
                          notify((e as Error).message, true);
                        }
                      }}
                    />
                  ) : (
                    <div className="ai-settings">
                      <label>
                        模型配置
                        <Select
                          aria-label="模型配置"
                          disabled={busy || saving}
                          value={editScheme.modelId || ""}
                          onChange={(e) =>
                            updateScheme({ modelId: e.target.value })
                          }
                        >
                          <option value="">请选择模型配置</option>
                          {draft.models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </Select>
                      </label>
                      {!draft.models.length && (
                        <p className="help">
                          可以先保存处理，再到模型设置添加模型。
                        </p>
                      )}
                      <label>
                        初始提示词
                        <textarea
                          className="prompt-editor"
                          disabled={busy || saving}
                          placeholder="例如：整理为公司、联系人、电话三列，以制表符分隔。缺失留空，只输出结果。"
                          value={editScheme.prompt}
                          onChange={(e) =>
                            updateScheme({ prompt: e.target.value })
                          }
                        />
                      </label>
                      <p className="help">
                        可在工作台输入或从历史选择提示词。成功执行后自动保存到历史。
                      </p>
                    </div>
                  )}
                  {editScheme.kind === "ai" && (
                    <SettingsActions
                      onSave={() => void save()}
                      disabled={busy || saving || !ready}
                      saveLabel="保存自定义处理"
                      status="保存全部设置，提示词执行成功后自动记录历史"
                    />
                  )}
                </>
              ) : page === "models" && editModel ? (
                <>
                  <fieldset
                    className="settings-scroll"
                    disabled={busy || saving}
                  >
                    <div className="form-heading">
                      <h2>模型连接</h2>
                      <button
                        className="danger"
                        onClick={async () => {
                          if (
                            draft.schemes.some(
                              (s) =>
                                s.kind === "ai" && s.modelId === editingModel,
                            )
                          ) {
                            notify(
                              "该模型被自定义处理引用，请先修改或删除对应方案",
                              true,
                            );
                            return;
                          }
                          if (
                            await confirmAction(
                              "确定删除此模型配置？保存后生效。",
                            )
                          ) {
                            setDraft({
                              ...draft,
                              models: draft.models.filter(
                                (m) => m.id !== editingModel,
                              ),
                            });
                            setEditingModel("");
                            setUnsaved(true);
                          }
                        }}
                      >
                        <Trash2 size={15} />
                        删除
                      </button>
                    </div>
                    <label>
                      配置名称
                      <input
                        value={editModel.name}
                        onChange={(e) => updateModel({ name: e.target.value })}
                      />
                    </label>
                    <label>
                      API 地址
                      <input
                        placeholder="https://你的服务地址/v1"
                        value={editModel.baseUrl}
                        onChange={(e) =>
                          updateModel({ baseUrl: e.target.value })
                        }
                      />
                    </label>
                    <p className="help">
                      支持服务基础路径或完整 /chat/completions
                      地址。请保留服务要求的版本路径。
                    </p>
                    {editModel.needsKeyUpdate && (
                      <p className="help legacy-key-note">
                        旧版密钥使用系统加密，请重新填写一次 API
                        Key。保存后将改用本地文件加密，其他配置保留。
                      </p>
                    )}
                    <div className="key-heading">
                      <strong>API Key</strong>
                      <span className="key-state">
                        {editModel.clearKey
                          ? "保存后移除"
                          : editModel.apiKey
                            ? "新密钥待保存"
                            : editModel.needsKeyUpdate
                              ? "需要更新"
                              : editModel.hasKey
                                ? "已配置 · 本机加密"
                                : "尚未配置"}
                      </span>
                    </div>
                    <label className="key-input">
                      <span className="sr-only">API Key</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        placeholder={
                          editModel.needsKeyUpdate
                            ? "旧版密钥，请重新填写一次"
                            : editModel.hasKey
                              ? "已保存密钥；留空则保留"
                              : "输入 API Key"
                        }
                        value={editModel.apiKey || ""}
                        onChange={(e) =>
                          updateModel({
                            apiKey: e.target.value,
                            clearKey: false,
                          })
                        }
                      />
                    </label>
                    {editModel.hasKey && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={Boolean(editModel.clearKey)}
                          onChange={(e) =>
                            updateModel({
                              clearKey: e.target.checked,
                              apiKey: "",
                            })
                          }
                        />
                        清除已保存密钥
                      </label>
                    )}
                    <label>
                      模型名称
                      <input
                        placeholder="填写服务商提供的准确模型名称"
                        value={editModel.model}
                        onChange={(e) => updateModel({ model: e.target.value })}
                      />
                    </label>
                    <p className="help">
                      优先支持 OpenAI 兼容 Chat Completions
                      接口。连接测试会发送简短测试文本，可能产生少量费用。
                    </p>
                  </fieldset>
                  <SettingsActions
                    onSave={() => void save()}
                    disabled={busy || saving || !ready}
                    status={
                      <span
                        className={
                          connection?.id === editModel.id
                            ? connection.state
                            : ""
                        }
                        role="status"
                      >
                        {connection?.id === editModel.id
                          ? connection.message
                          : "连接尚未测试"}
                      </span>
                    }
                  >
                    <button
                      className="primary"
                      disabled={busy || saving || !ready}
                      onClick={() => void testModel()}
                    >
                      保存并测试连接
                    </button>
                    {busy && (
                      <button onClick={() => void cancel()}>取消测试</button>
                    )}
                  </SettingsActions>
                </>
              ) : (
                <>
                  <div className="management-empty">
                    从左侧选择配置，或点击新增。
                  </div>
                  <SettingsActions
                    onSave={() => void save()}
                    disabled={busy || saving || !ready || !unsaved}
                    status={unsaved ? "有待保存的配置变更" : "还没有选中的配置"}
                  />
                </>
              )}
            </section>
          </div>
        )}
        <footer role="status" className={error ? "error" : ""}>
          <span className={"status-dot " + (busy ? "busy" : "")} />
          <span>{status}</span>
          <span className="spacer" />
          <small>
            {page === "work" ? "文本仅在本次窗口保留" : "配置与对话保存在本机"}
          </small>
        </footer>
      </main>
    </div>
  );
}
