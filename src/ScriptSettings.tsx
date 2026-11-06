import { useEffect, useRef, useState } from "react";
import { Play, Save, ShieldCheck, Square } from "lucide-react";
import { SettingsActions } from "./SettingsActions";
import { ScriptEditor } from "./editors";
import { ScriptGenerator } from "./ScriptGenerator";
import { ScriptTests, TestResults } from "./ScriptTests";
import { unwrap, type Model, type Scheme, type TestReport } from "./desktop";
const api = window.desktop;
export function ScriptSettings({
  scheme,
  models,
  busy,
  onChange,
  onBusyChange,
  notify,
  onActivate,
  onSave,
  saving,
}: {
  onSave: () => void;
  saving: boolean;
  scheme: Scheme;
  models: Model[];
  busy: boolean;
  onChange: (patch: Partial<Scheme>) => void;
  onBusyChange: (value: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
  onActivate: (fingerprint: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<"script" | "tests">("script");
  const cases = scheme.testCases || [];
  const key = JSON.stringify([scheme.script, cases]);
  const [last, setLast] = useState<{ key: string; report: TestReport } | null>(
    null,
  );
  const active = useRef<string | null>(null),
    busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(
    () => () => {
      if (active.current) {
        void api?.cancelScriptTests(active.current);
        active.current = null;
        busyCallback.current(false);
      }
    },
    [],
  );
  const report = last?.key === key ? last.report : null;
  const currentActive =
    scheme.activeScript?.script === scheme.script &&
    JSON.stringify(scheme.activeScript.testCases) === JSON.stringify(cases);
  async function test() {
    if (!api || active.current) return;
    const requestId = crypto.randomUUID();
    active.current = requestId;
    onBusyChange(true);
    setLast(null);
    setTab("tests");
    notify("正在本地运行测试集…");
    try {
      const report = await unwrap(
        api.testScript({
          requestId,
          schemeId: scheme.id,
          script: scheme.script,
          testCases: cases,
        }),
      );
      if (active.current !== requestId) return;
      setLast({ key, report });
      notify(
        report.passed
          ? "测试全部通过，可以启用此版本"
          : report.message || "测试未通过，请查看差异",
        !report.passed,
      );
    } catch (e) {
      if (active.current === requestId) notify((e as Error).message, true);
    } finally {
      if (active.current === requestId) {
        active.current = null;
        onBusyChange(false);
      }
    }
  }
  return (
    <section className="script-settings">
      {(!currentActive || scheme.activeScript?.status === "legacy") && (
        <div className="script-state">
          <ShieldCheck size={16} />
          <span>
            {!scheme.activeScript
              ? "草稿尚未启用"
              : scheme.activeScript.status === "legacy"
                ? "旧版脚本 · 未验证"
                : "草稿有更新 · 尚未启用"}
          </span>
        </div>
      )}
      <div className="script-toolbar">
        <div className="section-tabs" role="tablist" aria-label="处理编辑区域">
          {(
            [
              ["script", "处理脚本"],
              ["tests", `测试集 · ${cases.length}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              id={`script-tab-${id}`}
              role="tab"
              aria-selected={tab === id}
              aria-controls={`script-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "script"
                    : event.key === "End"
                      ? "tests"
                      : tab === "script"
                        ? "tests"
                        : "script";
                setTab(next);
                document.getElementById(`script-tab-${next}`)?.focus();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <ScriptGenerator
          disabled={busy || saving}
          models={models}
          schemeId={scheme.id}
          script={scheme.script}
          testCases={cases}
          onSetupTests={() => {
            setTab("tests");
            document.getElementById("script-tab-tests")?.focus();
          }}
          onRestoreContext={(context) =>
            onChange({ script: context.script, testCases: context.testCases })
          }
          onApply={(script, report) => {
            onChange({ script });
            setLast(
              report ? { key: JSON.stringify([script, cases]), report } : null,
            );
          }}
          onBusyChange={onBusyChange}
          notify={notify}
        />
      </div>
      <div
        className="script-pane"
        id="script-panel-script"
        role="tabpanel"
        aria-labelledby="script-tab-script"
        hidden={tab !== "script"}
      >
        <div className="script-editor">
          <ScriptEditor
            value={scheme.script}
            readOnly={busy || saving}
            onChange={(script) => onChange({ script })}
          />
        </div>
      </div>
      <div
        className="script-pane tests-pane"
        id="script-panel-tests"
        role="tabpanel"
        aria-labelledby="script-tab-tests"
        hidden={tab !== "tests"}
      >
        <ScriptTests
          cases={cases}
          busy={busy || saving}
          onChange={(testCases) => onChange({ testCases })}
        />
        {last && !report && (
          <p className="test-summary failed" role="status">
            脚本或用例已修改，请重新运行测试。
          </p>
        )}
        {report && <TestResults cases={cases} report={report} />}
        <p className="help">
          每例限时 2 秒，整套最多 15 秒。脚本不能访问文件或网络。
        </p>
      </div>
      <SettingsActions
        onSave={onSave}
        disabled={busy || saving}
        saveLabel="保存草稿"
        status={
          <>
            <strong
              className={
                report && !report.passed
                  ? "failed"
                  : report?.passed
                    ? "passed"
                    : ""
              }
            >
              {saving
                ? "正在保存…"
                : currentActive && scheme.activeScript?.status === "verified"
                  ? "已生效"
                  : report?.passed
                    ? `测试通过 · ${report.total}/${report.total}`
                    : report
                      ? "测试未通过"
                      : last
                        ? "修改后需重新测试"
                        : cases.length
                          ? "待测试"
                          : "请先添加测试用例"}
            </strong>
          </>
        }
      >
        <button
          disabled={busy || saving || !cases.length}
          onClick={() => void test()}
        >
          <Play size={15} />
          运行全部测试
        </button>
        {active.current && (
          <button onClick={() => void api?.cancelScriptTests(active.current!)}>
            <Square size={14} />
            取消测试
          </button>
        )}
        <button
          className="primary"
          disabled={
            busy ||
            saving ||
            !report?.passed ||
            !report.total ||
            (currentActive && scheme.activeScript?.status === "verified")
          }
          onClick={async () => {
            if (!report) return;
            onBusyChange(true);
            try {
              await onActivate(report.fingerprint);
            } finally {
              onBusyChange(false);
            }
          }}
        >
          <Save size={15} />
          启用此版本
        </button>
      </SettingsActions>
    </section>
  );
}
