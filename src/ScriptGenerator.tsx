import { useEffect, useRef, useState } from "react";
import {
  WandSparkles,
  Square,
  MessageSquare,
  RotateCcw,
  Check,
} from "lucide-react";
import { Select } from "./Select";
import { RightDrawer } from "./RightDrawer";
import { MarkdownMessage } from "./MarkdownMessage";
import { ScriptEditor } from "./editors";
import { TestResults } from "./ScriptTests";
import {
  confirmAction,
  unwrap,
  type Model,
  type TestCase,
  type TestReport,
  type ScriptConversationView,
} from "./desktop";
const api = window.desktop;
const casesKey = (cases: TestCase[]) =>
  JSON.stringify(
    cases.map(({ id, name, input, expected }) => ({
      id,
      name,
      input,
      expected,
    })),
  );
export function ScriptGenerator({
  models,
  script,
  schemeId,
  testCases,
  disabled = false,
  onSetupTests,
  onApply,
  onRestoreContext,
  onBusyChange,
  notify,
}: {
  models: Model[];
  script: string;
  schemeId: string;
  testCases: TestCase[];
  disabled?: boolean;
  onSetupTests: () => void;
  onApply: (script: string, report?: TestReport) => void;
  onRestoreContext: (context: {
    script: string;
    testCases: TestCase[];
  }) => void;
  onBusyChange: (busy: boolean) => void;
  notify: (message: string, isError?: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [modelId, setModelId] = useState(""),
    [instructions, setInstructions] = useState(""),
    [conversation, setConversation] = useState<ScriptConversationView | null>(
      null,
    ),
    [generated, setGenerated] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [cancelling, setCancelling] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(false);
  const [historyBroken, setHistoryBroken] = useState(false);
  const chatHost = useRef<HTMLDivElement>(null);
  const [testResult, setTestResult] = useState<{
    cases: string;
    report: TestReport;
    fresh: boolean;
  } | null>(null);
  const active = useRef<string | null>(null),
    baseScript = useRef(""),
    busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => {
    setModelId((old) =>
      models.some((m) => m.id === old && m.hasKey && !m.needsKeyUpdate)
        ? old
        : models.find((m) => m.hasKey && !m.needsKeyUpdate)?.id || "",
    );
  }, [models]);
  useEffect(() => {
    let mounted = true;
    if (!api) {
      setLoading(false);
      return;
    }
    void unwrap(api.getScriptConversation(schemeId))
      .then(({ conversation, storageWarning }) => {
        if (!mounted) return;
        setConversation(conversation);
        if (conversation) {
          if (
            models.some(
              (m) =>
                m.id === conversation.modelId && m.hasKey && !m.needsKeyUpdate,
            )
          )
            setModelId(conversation.modelId);
          if (conversation.generated) {
            setGenerated(conversation.generated.script);
            setTestResult({
              cases: casesKey(conversation.generated.testCases),
              report: conversation.generated.report,
              fresh: false,
            });
            baseScript.current = conversation.context.script;
          }
          setMessage("已恢复本机对话，可继续讨论或确认仍适用的方案。");
        }
        if (storageWarning) {
          setError(true);
          setMessage(storageWarning);
        }
      })
      .catch((e) => {
        if (mounted) {
          setHistoryBroken(true);
          setError(true);
          setMessage(e.message);
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      const id = active.current;
      if (id) {
        active.current = null;
        void api.cancelScriptGeneration(id);
        busyCallback.current(false);
      }
    };
  }, [schemeId]);
  useEffect(() => {
    if (disabled && !busy)
      setTestResult((old) => (old?.fresh ? { ...old, fresh: false } : old));
  }, [disabled, busy]);
  useEffect(() => {
    if (chatHost.current)
      chatHost.current.scrollTop = chatHost.current.scrollHeight;
  }, [conversation?.turns.length, open]);
  const matches = Boolean(
    conversation &&
    conversation.modelId === modelId &&
    conversation.context.script === script &&
    casesKey(conversation.context.testCases) === casesKey(testCases),
  );
  const plan = matches ? conversation?.plan : null;
  const locked = busy || disabled || loading;
  const needsTests = testCases.length === 0;
  async function startNew() {
    if (
      (conversation || historyBroken) &&
      !(await confirmAction(
        "开始新对话会在首轮成功后替换当前历史对话，是否继续？",
      ))
    )
      return;
    setHistoryBroken(false);
    setConversation(null);
    setGenerated("");
    setTestResult(null);
    setInstructions("");
    setMessage("请输入新的要求，首轮成功后将保存新对话。");
    setError(false);
  }
  async function request(mode: "discuss" | "generate") {
    if (!api || active.current || disabled || loading || historyBroken) return;
    if (mode === "generate" && (!plan || !conversation)) return;
    if (mode === "discuss")
      setTestResult((old) => (old?.fresh ? { ...old, fresh: false } : old));
    if (mode === "generate") {
      setGenerated("");
      setTestResult(null);
    }
    const id = crypto.randomUUID();
    active.current = id;
    setBusy(true);
    setCancelling(false);
    onBusyChange(true);
    setError(false);
    setMessage(
      mode === "discuss"
        ? "正在测试当前脚本并讨论方案，模型最多等待 5 分钟，可随时取消…"
        : "正在按已确认方案生成脚本，最多等待 5 分钟，可随时取消…",
    );
    notify(
      mode === "discuss"
        ? "正在结合已有脚本和测试结果讨论方案…"
        : "正在按已确认方案生成脚本…",
    );
    try {
      const context = { schemeId, modelId, script, testCases, requestId: id };
      if (mode === "discuss") {
        const next = await unwrap(
          api.discussScript({
            ...context,
            conversationId: conversation?.id,
            message: instructions,
          }),
        );
        if (active.current !== id) return;
        setConversation(next);
        setInstructions("");
        setMessage(
          next.storageWarning ||
            "方案已输出。可以继续补充意见，确认后才生成脚本。",
        );
        setError(Boolean(next.storageWarning));
        notify("方案已更新，等待你确认或继续补充");
      } else {
        const output = await unwrap(
          api.generateScript({
            ...context,
            conversationId: conversation!.id,
            planId: plan!.id,
          }),
        );
        if (active.current !== id) return;
        baseScript.current = script;
        setConversation(output.conversation);
        setGenerated(output.script);
        setTestResult({
          cases: casesKey(testCases),
          report: output.report,
          fresh: true,
        });
        setInstructions(
          output.report.passed
            ? ""
            : "请结合本次失败的测试结果完善方案，先说明准备如何调整。",
        );
        setMessage(
          output.conversation.storageWarning ||
            (output.report.passed
              ? "脚本已生成且测试全部通过，可应用到草稿后保存生效。"
              : "脚本已生成，测试未全部通过。可继续讨论，模型会参考本次代码和结果。"),
        );
        setError(Boolean(output.conversation.storageWarning));
        notify(
          output.report.passed
            ? "脚本已生成并通过测试，等待应用"
            : "脚本已生成，测试未通过或尚无用例",
          !output.report.passed,
        );
      }
    } catch (e) {
      if (active.current !== id) return;
      setError(true);
      setMessage((e as Error).message);
      notify((e as Error).message, true);
      // 生成阶段的静态检查失败也会保留后台反馈，下一轮可以继续讨论。
      if (mode === "generate") {
        setGenerated("");
        setTestResult(null);
        try {
          const next = await unwrap(api.getScriptConversation(schemeId));
          if (active.current === id) setConversation(next.conversation);
        } catch {}
      }
    } finally {
      if (active.current === id) {
        active.current = null;
        setBusy(false);
        setCancelling(false);
        onBusyChange(false);
      }
    }
  }
  async function cancel() {
    const id = active.current;
    if (!id || !api) return;
    setCancelling(true);
    setMessage("正在取消请求…");
    try {
      await unwrap(api.cancelScriptGeneration(id));
    } catch (e) {
      setError(true);
      setMessage((e as Error).message);
      setCancelling(false);
    }
  }
  async function apply() {
    if (!generated || locked) return;
    if (
      script !== baseScript.current &&
      script !== generated &&
      !(await confirmAction(
        "当前脚本在生成后已有修改，是否用预览中的代码覆盖？",
      ))
    )
      return;
    onApply(
      generated,
      testResult?.fresh && testResult.cases === casesKey(testCases)
        ? testResult.report
        : undefined,
    );
    setGenerated("");
    setOpen(false);
    setMessage(
      "已填入脚本草稿；历史测试结果需重新测试，当前通过结果可启用此版本。",
    );
    notify("生成的脚本已应用到编辑器草稿，尚未替换生效版本");
  }
  return (
    <section className="script-generator">
      <button
        className="generator-toggle"
        aria-expanded={open}
        aria-haspopup={needsTests ? undefined : "dialog"}
        aria-describedby={
          needsTests ? "script-generation-prerequisite" : undefined
        }
        onClick={() => {
          if (needsTests) onSetupTests();
          else setOpen(!open);
        }}
        disabled={loading || (disabled && !busy)}
      >
        <WandSparkles size={16} />
        使用模型生成脚本
      </button>
      {needsTests && (
        <small
          className="generator-prerequisite"
          id="script-generation-prerequisite"
        >
          请先在测试集中添加至少 1 条用例
        </small>
      )}
      <RightDrawer
        open={open}
        onClose={() => setOpen(false)}
        title="模型对话"
        contentClassName="conversation-drawer"
      >
        <div className="generator-body">
          <ol className="conversation-steps" aria-label="脚本生成进度">
            {["讨论方案", "确认生成", "验证脚本"].map((step, index) => (
              <li
                key={step}
                aria-current={
                  index === (generated ? 2 : plan ? 1 : 0) ? "step" : undefined
                }
              >
                <span>{index + 1}</span>
                {step}
              </li>
            ))}
          </ol>
          <details className="conversation-context">
            <summary>
              已带入当前脚本 · {testCases.length} 条测试用例{" "}
              <span>查看上下文</span>
            </summary>
            <p className="help">
              讨论时会运行当前测试，将脚本、测试输入、预期和实际输出及对话发送到所选模型。不会读取工作台正文。对话保存在本机。
            </p>
            <pre>{script || "尚未编写脚本"}</pre>
            {testCases.length > 0 && (
              <ul>
                {testCases.map((item) => (
                  <li key={item.id}>{item.name || "未命名用例"}</li>
                ))}
              </ul>
            )}
          </details>
          {!models.some((m) => m.hasKey && !m.needsKeyUpdate) && (
            <p className="generator-message">
              请先到“模型设置”保存可用的 API 配置和密钥。
            </p>
          )}
          <label>
            生成脚本使用的模型
            <Select
              aria-label="生成脚本使用的模型"
              value={modelId}
              disabled={locked}
              onChange={async (e) => {
                const next = e.currentTarget.value;
                if (conversation && next !== conversation.modelId) {
                  if (
                    !(await confirmAction(
                      "更换模型将开始新对话，旧对话不会发送到新服务，是否继续？",
                    ))
                  )
                    return;
                  setConversation(null);
                  setGenerated("");
                  setTestResult(null);
                }
                setModelId(next);
              }}
            >
              <option value="">请选择已保存的模型</option>
              {models.map((m) => (
                <option
                  key={m.id}
                  value={m.id}
                  disabled={!m.hasKey || m.needsKeyUpdate}
                >
                  {m.name}
                  {!m.hasKey
                    ? "（未配置密钥）"
                    : m.needsKeyUpdate
                      ? "（请更新密钥）"
                      : ""}
                </option>
              ))}
            </Select>
          </label>
          <div className="conversation-timeline" ref={chatHost}>
            {!conversation && (
              <div className="conversation-empty">
                <MessageSquare size={28} />
                <strong>先把处理方式讨论清楚</strong>
                <p>
                  描述想要的结果，模型会结合已有脚本和测试提出方案。确认后才会生成代码。
                </p>
              </div>
            )}
            {conversation && (
              <div className="script-chat" role="log" aria-label="脚本方案对话">
                {conversation.turns.map((turn, index) => (
                  <div key={index} className={"chat-turn " + turn.role}>
                    <strong>
                      {turn.role === "user"
                        ? "你"
                        : turn.kind === "plan"
                          ? "处理方案"
                          : "模型反馈"}
                    </strong>
                    <MarkdownMessage text={turn.content} />
                  </div>
                ))}
              </div>
            )}
            {conversation && !matches && (
              <div className="test-summary failed">
                <p>
                  脚本、测试集或模型已变更，旧方案不能直接生成，请发送补充意见更新方案。
                </p>
                {conversation.modelId === modelId && (
                  <button
                    disabled={locked}
                    onClick={async () => {
                      if (
                        await confirmAction(
                          "恢复会话中的脚本和测试集会替换当前草稿，生效版本不变，是否继续？",
                        )
                      ) {
                        onRestoreContext(conversation.context);
                        if (!conversation.context.testCases.length) {
                          setOpen(false);
                          onSetupTests();
                        }
                      }
                    }}
                  >
                    恢复会话草稿
                  </button>
                )}
              </div>
            )}
            {conversation?.plan && (
              <div className="plan-confirmation">
                <strong>{plan ? "方案已就绪" : "方案需要更新"}</strong>
                <p>确认当前方案后生成脚本，测试通过才能启用。</p>{" "}
                <button
                  disabled={
                    locked || !plan || !modelId || Boolean(instructions.trim())
                  }
                  onClick={() => void request("generate")}
                >
                  <Check size={15} />
                  确认方案并生成脚本
                </button>
              </div>
            )}
            {plan && (
              <p className="help">
                当前方案待确认。填写补充意见后请先发送，不能跳过未发送的修改直接生成。
              </p>
            )}
            {generated && (
              <div className="generated-preview">
                <div className="generated-heading">
                  <strong>生成脚本预览</strong>
                  <button disabled={locked} onClick={apply}>
                    应用到脚本编辑器
                  </button>
                </div>
                <div className="generated-code">
                  <ScriptEditor value={generated} readOnly />
                </div>
                <p className="help">
                  应用只替换草稿。至少 1 条用例且全部通过后才能生效。
                  {testResult && !testResult.fresh
                    ? "这份报告仅供参考，应用后需重新运行全部测试。"
                    : ""}
                </p>
                {testResult?.cases === casesKey(testCases) && (
                  <TestResults cases={testCases} report={testResult.report} />
                )}{" "}
                {testResult && testResult.cases !== casesKey(testCases) && (
                  <p className="test-summary failed">
                    测试集已修改，应用后请重新运行全部测试。
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="conversation-composer">
            {message && (
              <p
                className={"generator-message " + (error ? "error" : "")}
                role="status"
              >
                {message}
              </p>
            )}
            {conversation?.storageWarning &&
              conversation.storageWarning !== message && (
                <p className="generator-message error">
                  {conversation.storageWarning}
                </p>
              )}

            <label>
              处理要求
              <textarea
                aria-label="处理要求"
                disabled={locked}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={
                  conversation
                    ? "补充意见，或说明测试结果哪里不符合预期…"
                    : "描述你想怎样处理文本，模型会先给出方案…"
                }
              />
            </label>
            <div className="generator-actions">
              <button
                className="primary"
                disabled={
                  locked || historyBroken || !modelId || !instructions.trim()
                }
                onClick={() => void request("discuss")}
              >
                <MessageSquare size={15} />
                {conversation ? "发送补充意见" : "讨论处理方案"}
              </button>
              {busy && (
                <button disabled={cancelling} onClick={() => void cancel()}>
                  <Square size={14} />
                  {cancelling ? "正在取消…" : "取消请求"}
                </button>
              )}
              {(conversation || historyBroken) && (
                <button disabled={locked} onClick={startNew}>
                  <RotateCcw size={14} />
                  重新开始对话
                </button>
              )}
            </div>
            <small>对话保存在本机 · 可在重启后继续</small>
          </div>
        </div>
      </RightDrawer>
    </section>
  );
}
