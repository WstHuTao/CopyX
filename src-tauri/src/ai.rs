use crate::{contract::*, script::sha256};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub fn endpoint(base: &str) -> Result<Url> {
    let mut url = Url::parse(base).map_err(|_| "API 地址格式不正确")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return Err("API 地址只允许不含账号、查询参数的 HTTP 或 HTTPS 地址".into());
    }
    let path = url.path().trim_end_matches('/');
    let joined = if path.ends_with("/chat/completions") {
        path.to_owned()
    } else {
        format!("{path}/chat/completions")
    };
    url.set_path(&joined);
    Ok(url)
}

pub fn signature(model: &Model) -> String {
    sha256(
        serde_json::to_string(&json!([model.base_url, model.model, model.api_key]))
            .expect("无法序列化模型状态")
            .as_bytes(),
    )
}

pub struct Ai(Client);
impl Ai {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法初始化模型请求")?;
        Ok(Self(client))
    }

    pub async fn request(
        &self,
        messages: Vec<Value>,
        model: &Model,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<String> {
        if messages.is_empty()
            || messages.len() > 64
            || messages.iter().any(|m| {
                !matches!(m["role"].as_str(), Some("user" | "assistant" | "system"))
                    || !m["content"].is_string()
            })
        {
            return Err("模型对话消息格式不正确".into());
        }
        if serde_json::to_vec(&messages)
            .map_err(|_| "模型对话消息格式不正确")?
            .len()
            > 4 * MB
        {
            return Err("对话与测试上下文超过 4 MB，请减少样例或重新开始对话".into());
        }
        let url = endpoint(&model.base_url)?;
        let key = model
            .api_key
            .as_deref()
            .filter(|k| !k.is_empty())
            .ok_or("请先为模型保存 API Key")?;
        let work = async {
            let mut response = self
                .0
                .post(url)
                .bearer_auth(key)
                .json(&json!({"model":model.model,"stream":false,"messages":messages}))
                .send()
                .await
                .map_err(|_| "模型服务连接失败，请检查 API 地址和网络")?;
            if !response.status().is_success() {
                return Err(format!(
                    "模型服务返回 HTTP {}，请检查地址、密钥、模型或额度",
                    response.status().as_u16()
                ));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "模型响应读取失败")?
            {
                if bytes.len() + chunk.len() > 8 * MB {
                    return Err("模型响应超过 8 MB，请缩小输入".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "模型服务未返回有效 JSON")?;
            let choice = &value["choices"][0];
            if choice["finish_reason"] == "length" {
                return Err("模型输出被长度限制截断，请缩小输入后重试".into());
            }
            choice["message"]["content"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "模型服务未返回文本结果，请确认兼容 Chat Completions 接口".into())
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("处理已取消".into()),
            result = tokio::time::timeout(timeout, work) => result.map_err(|_| "模型请求超时，可手动重试")?,
        }
    }

    pub async fn complete(
        &self,
        text: &str,
        prompt: &str,
        model: &Model,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<String> {
        self.request(
            vec![
                json!({"role":"system","content":prompt}),
                json!({"role":"user","content":text}),
            ],
            model,
            timeout,
            cancel,
        )
        .await
    }
    pub async fn transform(
        &self,
        text: &str,
        prompt: &str,
        model: &Model,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let rules = include_str!("../../electron/core/text-transform-rules.txt").trim_end();
        let retry = "\n上次回复不符合返回格式。请重新处理，只返回约定的 JSON 对象。";
        let start = Instant::now();
        for correction in ["", retry] {
            if cancel.is_cancelled() {
                return Err("处理已取消".into());
            }
            let remaining = timeout.saturating_sub(start.elapsed());
            if remaining.is_zero() {
                return Err("模型请求超时，可手动重试".into());
            }
            let system = format!("{rules}{correction}\n用户处理要求：\n{prompt}");
            let reply = self
                .complete(text, &system, model, remaining, cancel)
                .await?;
            if let Some(result) = transform_result(&reply, text) {
                return Ok(result);
            }
        }
        Err("模型未按要求返回处理结果，已自动重试一次，请检查提示词或换一个模型".into())
    }
}

fn transform_result(reply: &str, original: &str) -> Option<String> {
    let output = reply.trim();
    let json = output
        .split_once('\n')
        .filter(|(header, _)| matches!(header.trim_end(), "```json" | "```"))
        .and_then(|(_, body)| body.strip_suffix("\n```"))
        .unwrap_or(output);
    if let Ok(Value::Object(value)) = serde_json::from_str::<Value>(json) {
        if value.len() == 1 {
            if let Some(text) = value.get("text").and_then(Value::as_str) {
                return Some(text.to_owned());
            }
            if value.get("unchanged").and_then(Value::as_bool) == Some(true) {
                return Some(original.to_owned());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::transform_result;

    #[test]
    fn 文本转换仅提取结果且保留原始字符() {
        let original = "  飒飒\r\n\t";
        assert_eq!(
            transform_result(r#"{"unchanged":true}"#, original).unwrap(),
            original
        );
        assert_eq!(transform_result(r#"{"text":""}"#, original).unwrap(), "");
        let fenced = "```json\r\n{\"text\":\"  **飒飒**\\r\\n\\t\"}\r\n```";
        assert_eq!(
            transform_result(fenced, original).unwrap(),
            "  **飒飒**\r\n\t"
        );
        assert!(transform_result("无需去除，结果为 **飒飒**", original).is_none());
        assert!(transform_result(r#"说明：{"text":"飒飒"}"#, original).is_none());
    }
}
