// 仅在专用测试构建中执行，使用隔离配置和本地模型服务。
(async () => {
  const report = (input) =>
    window.__TAURI_INTERNALS__.invoke("desktop", {
      command: "smoke:finish",
      input,
    });
  const checks = [];
  const expect = (condition, name) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const call = async (name, input) => {
    const result = await window.desktop[name](input);
    if (!result.ok) throw new Error(name + "：" + result.error);
    return result.data;
  };
  const button = (label) =>
    [...document.querySelectorAll("button")].find(
      (item) => item.textContent.trim() === label,
    );
  const wait = async (predicate, name) => {
    for (let retry = 0; retry < 120; retry++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(name);
  };
  try {
    for (let retry = 0; retry < 100 && !window.desktop; retry++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(
      window.desktop && document.title === "CopyX",
      "真实窗口加载前端桥接",
    );
    const config = await call("getConfig");
    if (config.startupWarning) {
      await wait(
        () => document.body.textContent.includes(config.startupWarning),
        "启动注册失败提示未显示",
      );
      expect(
        config.startupWarning.includes("常用系统快捷键"),
        "系统快捷键注册失败在启动时可见",
      );
      await report({ ok: true, checks });
      return;
    }
    const scheme = config.schemes.find(({ id }) => id === "smoke-js");
    const model = config.models[0];
    expect(
      model.hasKey && !("encryptedKey" in model) && !("apiKey" in model),
      "桥接隐藏已迁移的模型密钥",
    );
    await wait(
      () =>
        document.querySelector('select[aria-label="自定义处理"]')?.value ===
        scheme.id,
      "工作台未载入初始指令",
    );
    const pausedConfig = structuredClone(config);
    pausedConfig.schemes.forEach((item) => {
      item.disabled = true;
    });
    await call("saveConfig", pausedConfig);
    for (const item of pausedConfig.schemes) {
      const reply = await window.desktop[
        item.kind === "ai" ? "runPrompt" : "run"
      ]({
        schemeId: item.id,
        text: "禁用时不可执行",
        prompt: "不能发送",
      });
      expect(
        !reply.ok && reply.error.includes("已禁用"),
        "后台拒绝禁用指令：" + item.id,
      );
    }
    await call("saveConfig", config);
    const context = {
      schemeId: scheme.id,
      modelId: model.id,
      script: scheme.script,
      testCases: scheme.testCases,
    };
    const raw = "  文本\r\n\t结尾  ";
    if (scheme.activeScript?.status === "verified") {
      expect(
        (await call("run", { schemeId: scheme.id, text: raw })) === raw + "！",
        "重启后执行已验证快照",
      );
      const restored = await call("getScriptConversation", scheme.id);
      expect(
        restored.conversation.generated.report.passed,
        "重启后恢复模型会话及测试报告",
      );
      expect(config.promptHistory[0].favorite, "重启后恢复提示词收藏");
      const replay = await call("runPrompt", {
        schemeId: "smoke-ai",
        latestPromptId: config.promptHistory[0].id,
        text: raw,
      });
      expect(replay.text === raw, "重启后复用最近成功的提示词");
      await wait(
        () =>
          button("载入样例") && document.querySelector(".monaco-diff-editor"),
        "工作台未加载",
      );
      button("载入样例").click();
      await wait(
        () => button("执行处理") && !button("执行处理").disabled,
        "样例执行按钮未启用",
      );
      button("执行处理").click();
      await wait(
        () =>
          document
            .querySelector(".monaco-diff-editor .modified .view-lines")
            ?.textContent.includes("！"),
        "Monaco 未渲染处理后的改动",
      );
      expect(
        !button("复制原文").disabled && !button("复制结果").disabled,
        "Monaco 对照和两侧复制按钮可用",
      );
      button("自定义处理").click();
      await wait(
        () => button("删除") && button("使用模型生成脚本"),
        "自定义处理页面未打开",
      );
      let resolveConfirm;
      const confirm = window.desktop.confirm;
      window.desktop.confirm = () =>
        new Promise((resolve) => {
          resolveConfirm = resolve;
        });
      button("删除").click();
      await wait(() => resolveConfirm, "删除操作未等待确认");
      expect(button("使用模型生成脚本"), "确认完成前保留自定义处理");
      resolveConfirm({ ok: true, data: false });
      await new Promise((resolve) => setTimeout(resolve, 100));
      window.desktop.confirm = confirm;
      expect(button("使用模型生成脚本"), "取消确认保留自定义处理");
      button("使用模型生成脚本").click();
      await wait(
        () =>
          [
            ...document.querySelectorAll(
              "dialog[open] .chat-turn .markdown-body strong",
            ),
          ].some((item) => item.textContent === "方案"),
        "右侧抽屉未恢复 Markdown 方案",
      );
      expect(
        document.querySelector("dialog[open]"),
        "重启后可在右侧抽屉阅读 Markdown 方案",
      );
    } else {
      expect(
        (await call("run", { schemeId: scheme.id, text: raw })) === raw,
        "旧快照保留空格、制表符和换行",
      );
      expect(
        !(
          await window.desktop.activateScript({
            schemeId: scheme.id,
            fingerprint: "伪造",
          })
        ).ok,
        "拒绝伪造生效凭据",
      );
      expect(
        !(
          await call("checkShortcut", {
            schemeId: scheme.id,
            key:
              window.desktop.platform === "darwin" ? "Command+C" : "Control+C",
            schemes: config.schemes,
          })
        ).available,
        "拒绝覆盖系统复制键",
      );
      const probe = await call("checkShortcut", {
        schemeId: scheme.id,
        key: "Control+Alt+Shift+F12",
        schemes: config.schemes,
      });
      expect(probe.available, "系统实际注册探测成功");
      const first = await call("discussScript", {
        ...context,
        requestId: "plan-1",
        message: "请加上全角感叹号",
      });
      expect(first.plan.text.includes("**方案**"), "模型第一轮返回方案");
      const second = await call("discussScript", {
        ...context,
        requestId: "plan-2",
        conversationId: first.id,
        message: "保留原文的空格",
      });
      expect(
        second.id === first.id && second.plan.id !== first.plan.id,
        "多轮补充更新方案",
      );
      const generate = {
        ...context,
        requestId: "generate-1",
        conversationId: first.id,
      };
      expect(
        !(
          await window.desktop.generateScript({
            ...generate,
            planId: first.plan.id,
          })
        ).ok,
        "拒绝使用过时方案生成脚本",
      );
      const generated = await call("generateScript", {
        ...generate,
        planId: second.plan.id,
      });
      expect(
        generated.report.passed && generated.report.total === 2,
        "确认方案后生成并在子进程通过测试",
      );
      expect(
        (await call("run", { schemeId: scheme.id, text: raw })) === raw,
        "生成预览期间仍执行旧快照",
      );
      scheme.script = generated.script;
      await call("saveConfig", config);
      await call("activateScript", {
        schemeId: scheme.id,
        fingerprint: generated.report.fingerprint,
      });
      expect(
        (await call("run", { schemeId: scheme.id, text: raw })) === raw + "！",
        "已通过测试的快照生效",
      );
      const invalid = await call("testScript", {
        ...context,
        requestId: "test-fail",
        script: "function transform(text) { return text; }",
      });
      expect(!invalid.passed, "测试失败不发放生效凭据");
      await call("cancelScriptTests", "test-cancel-before-start");
      const early = await window.desktop.testScript({
        ...context,
        requestId: "test-cancel-before-start",
      });
      expect(!early.ok && early.error.includes("取消"), "取消可先于请求到达");
      const test = window.desktop.testScript({
        ...context,
        requestId: "test-cancel",
        script: "function transform(text) { while (true) {} }",
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await call("cancelScriptTests", "test-cancel");
      const canceled = await test;
      expect(
        !canceled.ok && canceled.error.includes("取消"),
        "取消脚本任务中断独立子进程",
      );
      const result = await call("runPrompt", {
        schemeId: "smoke-ai",
        prompt: "原样返回",
        text: raw,
      });
      expect(
        result.text === raw && result.history[0].prompt === "原样返回",
        "模型请求和成功历史接通",
      );
      const updated = await call("updatePromptHistory", {
        id: result.history[0].id,
        action: "favorite",
        favorite: true,
      });
      expect(updated[0].favorite, "维护提示词收藏");
    }
    await report({ ok: true, checks });
  } catch (error) {
    await report({ ok: false, error: String(error), checks });
  }
})();
