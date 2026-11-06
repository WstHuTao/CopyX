const fs = require("node:fs");
const path = require("node:path");
const textRules = fs
  .readFileSync(path.join(__dirname, "text-transform-rules.txt"), "utf8")
  .trimEnd();

function endpointFor(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("API 地址格式不正确");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("API 地址只允许不含账号、查询参数的 HTTP 或 HTTPS 地址");
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/chat/completions"))
    url.pathname += "/chat/completions";
  return url.toString();
}
async function runAI(text, prompt, model, options = {}) {
  return runMessages(
    [
      { role: "system", content: prompt },
      { role: "user", content: text },
    ],
    model,
    options,
  );
}
async function transformAI(text, prompt, model, options) {
  const reply = await runAI(
    text,
    `${textRules}\n用户处理要求：\n${prompt}`,
    model,
    options,
  );
  const output = reply.trim();
  const fenced = output.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/);
  try {
    const value = JSON.parse(fenced ? fenced[1] : output);
    if (value && typeof value === "object" && Object.keys(value).length === 1) {
      if (typeof value.text === "string") return value.text;
      if (value.unchanged === true) return text;
    }
  } catch {
    // 格式错误统一提示，避免回显模型回复中的用户内容。
  }
  throw new Error("模型未按要求返回处理结果，请重试或换一个模型");
}

async function runMessages(messages, model, { signal, timeout = 60000 } = {}) {
  if (
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > 64 ||
    messages.some(
      (m) =>
        !m ||
        !["system", "user", "assistant"].includes(m.role) ||
        typeof m.content !== "string",
    )
  )
    throw new Error("模型对话消息格式不正确");
  if (Buffer.byteLength(JSON.stringify(messages)) > 4 * 1024 * 1024)
    throw new Error("对话与测试上下文超过 4 MB，请减少样例或重新开始对话");
  const url = endpointFor(model.baseUrl);
  if (!model.apiKey || !model.model)
    throw new Error("请配置 API Key 和模型名称");
  const timer = AbortSignal.timeout(timeout);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timer]) : timer,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.model,
        stream: false,
        messages,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `模型服务返回 HTTP ${response.status}，请检查地址、密钥、模型或额度`,
      );
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024)
        throw new Error("模型响应超过 8 MB，请缩小输入");
      chunks.push(chunk);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("模型服务未返回有效 JSON");
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length")
      throw new Error("模型输出被长度限制截断，请缩小输入后重试");
    if (typeof choice?.message?.content !== "string")
      throw new Error(
        "模型服务未返回文本结果，请确认兼容 Chat Completions 接口",
      );
    return choice.message.content;
  } catch (e) {
    if (signal?.aborted) throw new Error("处理已取消");
    if (timer.aborted) throw new Error("模型请求超时，可手动重试");
    if (e instanceof TypeError)
      throw new Error("模型服务连接失败，请检查 API 地址和网络");
    throw e;
  }
}
module.exports = { runAI, transformAI, runMessages, endpointFor };
