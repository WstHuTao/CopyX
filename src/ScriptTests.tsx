import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { DiffView } from "./editors";
import type { TestCase, TestReport } from "./desktop";
export function TestResults({
  cases,
  report,
}: {
  cases: TestCase[];
  report: TestReport;
}) {
  const [selected, setSelected] = useState("");
  const result =
    report.results.find((r) => r.id === selected) ||
    report.results.find((r) => !r.passed) ||
    report.results[0];
  const item = cases.find((c) => c.id === result?.id);
  return (
    <section className="test-results" aria-label="测试结果">
      <p
        className={"test-summary " + (report.passed ? "passed" : "failed")}
        role="status"
      >
        {report.message ||
          (report.passed
            ? `全部通过：${report.total}/${report.total}`
            : `测试未通过：${report.results.filter((r) => r.passed).length}/${report.total}`)}
      </p>
      <div className="test-result-list">
        {report.results.map((r) => (
          <button
            key={r.id}
            className={r.passed ? "passed" : "failed"}
            onClick={() => setSelected(r.id)}
          >
            {r.passed ? "通过" : "失败"} ·{" "}
            {cases.find((c) => c.id === r.id)?.name || "用例"} · {r.elapsedMs}{" "}
            ms
          </button>
        ))}
      </div>
      {result && item && (
        <div className="test-detail">
          <strong>
            {item.name} · {result.passed ? "输出一致" : "请检查差异"}
          </strong>
          {result.error ? (
            <p className="test-summary failed">{result.error}</p>
          ) : (
            <>
              <div className="test-exact">
                <div>
                  <span>预期输出（转义显示）</span>
                  <pre>{JSON.stringify(item.expected)}</pre>
                </div>
                <div>
                  <span>实际输出（转义显示）</span>
                  <pre>{JSON.stringify(result.actual)}</pre>
                </div>
              </div>
              {!result.passed && (
                <div className="test-diff">
                  <DiffView
                    original={item.expected}
                    modified={result.actual || ""}
                    onEdit={() => {}}
                    options={{
                      readOnly: true,
                      originalEditable: false,
                      automaticLayout: true,
                      ignoreTrimWhitespace: false,
                      renderWhitespace: "all",
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      renderSideBySide: true,
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
export function ScriptTests({
  cases,
  onChange,
  busy,
}: {
  cases: TestCase[];
  onChange: (cases: TestCase[]) => void;
  busy: boolean;
}) {
  const [selected, setSelected] = useState(cases[0]?.id || "");
  const item = cases.find((c) => c.id === selected) || cases[0];
  const update = (patch: Partial<TestCase>) =>
    onChange(cases.map((c) => (c.id === item?.id ? { ...c, ...patch } : c)));
  return (
    <section className="script-tests" aria-label="测试集">
      <div className="generated-heading">
        <strong>测试集 · {cases.length}/50</strong>
        <button
          disabled={busy || cases.length >= 50}
          onClick={() => {
            const id = crypto.randomUUID();
            onChange([
              ...cases,
              { id, name: `用例 ${cases.length + 1}`, input: "", expected: "" },
            ]);
            setSelected(id);
          }}
        >
          <Plus size={14} />
          添加测试用例
        </button>
      </div>
      <p className="help">
        输入与预期输出逐字符比较，空格、制表符和换行必须一致。至少 1
        条且全部通过才能生效。主动保存的样例会保存在本机，请使用可留存的测试数据。
      </p>
      {cases.length > 0 ? (
        <>
          <div className="test-tabs">
            {cases.map((c) => (
              <button
                key={c.id}
                disabled={busy}
                className={c.id === item?.id ? "selected" : ""}
                onClick={() => setSelected(c.id)}
              >
                {c.name || "未命名用例"}
              </button>
            ))}
          </div>
          <div className="test-case-editor">
            <div className="test-case-heading">
              <label>
                用例名称
                <input
                  aria-label="用例名称"
                  disabled={busy}
                  maxLength={128}
                  value={item.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </label>
              <button
                className="danger"
                disabled={busy}
                onClick={() => onChange(cases.filter((c) => c.id !== item.id))}
              >
                <Trash2 size={14} />
                删除用例
              </button>
            </div>
            <div className="test-texts">
              <label>
                测试输入
                <textarea
                  aria-label="测试输入"
                  disabled={busy}
                  spellCheck={false}
                  value={item.input}
                  onChange={(e) => update({ input: e.target.value })}
                />
              </label>
              <label>
                预期输出
                <textarea
                  aria-label="预期输出"
                  disabled={busy}
                  spellCheck={false}
                  value={item.expected}
                  onChange={(e) => update({ expected: e.target.value })}
                />
              </label>
            </div>
            <div className="test-exact">
              <pre>{JSON.stringify(item.input)}</pre>
              <pre>{JSON.stringify(item.expected)}</pre>
            </div>
          </div>
        </>
      ) : (
        <p className="help">尚无测试用例。可以保存草稿，但不能让新脚本生效。</p>
      )}
    </section>
  );
}
