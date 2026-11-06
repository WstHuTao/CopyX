use crate::{
    contract::*,
    script,
    store::{atomic_write, read_limited},
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use uuid::Uuid;

const FORMAT: &str = "copyx.custom-processing";
const LIMIT: usize = 8 * MB;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Portable {
    name: String,
    kind: Kind,
    script: Option<String>,
    prompt: Option<String>,
    #[serde(default)]
    test_cases: Vec<TestCase>,
}

fn portable(input: Value, tests: bool) -> Result<Value> {
    let item: Portable = serde_json::from_value(input).map_err(|_| "自定义处理类型或内容不正确")?;
    if item.name.trim().is_empty() {
        return Err("请填写处理名称".into());
    }
    match item.kind {
        Kind::Script => {
            let source = item.script.ok_or("脚本内容不正确")?;
            script::validate_source(&source)?;
            let cases = if tests { item.test_cases } else { vec![] };
            script::validate_cases(&cases)?;
            Ok(json!({"name":item.name,"kind":"script","script":source,"testCases":cases}))
        }
        Kind::Ai => Ok(
            json!({"name":item.name,"kind":"ai","prompt":item.prompt.ok_or("提示词内容不正确")?}),
        ),
    }
}

fn serialize(input: Value, tests: bool) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec_pretty(
        &json!({"format":FORMAT,"version":1,"scheme":portable(input, tests)?}),
    )
    .map_err(|_| "无法生成分享文件")?;
    if bytes.len() > LIMIT {
        return Err("分享文件超过 8 MB，请缩短内容后再试".into());
    }
    Ok(bytes)
}

fn decode(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > LIMIT {
        return Err("分享文件超过 8 MB".into());
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let data: Value =
        serde_json::from_slice(bytes).map_err(|_| "无法读取分享文件，请选择有效的 CopyX 文件")?;
    if data["format"] != FORMAT {
        return Err("这不是 CopyX 自定义处理文件".into());
    }
    if data["version"] != 1 {
        return Err("当前版本不支持此分享文件，请更新 CopyX 后再试".into());
    }
    let mut item = portable(data["scheme"].clone(), true)?;
    item["id"] = json!(Uuid::new_v4().to_string());
    item["enabled"] = json!(false);
    item["shortcutMac"] = json!("");
    item["shortcutWin"] = json!("");
    if item["kind"] == "script" {
        item["prompt"] = json!("");
    } else {
        item["script"] = json!("");
        item["testCases"] = json!([]);
    }
    Ok(item)
}

pub fn export(app: &AppHandle, window: &WebviewWindow, input: Value) -> Result<Value> {
    let mut bytes = serialize(input.clone(), false)?;
    if input["kind"] == "script" && input["testCases"].as_array().is_some_and(|v| !v.is_empty()) {
        let choice = app
            .dialog()
            .message("可以同时分享测试输入和预期输出，方便接收方复测。")
            .title("分享自定义处理")
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                "仅分享脚本".into(),
                "包含测试用例".into(),
                "取消".into(),
            ))
            .blocking_show_with_result();
        match choice {
            MessageDialogResult::Yes => {}
            MessageDialogResult::Custom(label) if label == "仅分享脚本" => {}
            MessageDialogResult::No => bytes = serialize(input.clone(), true)?,
            MessageDialogResult::Custom(label) if label == "包含测试用例" => {
                bytes = serialize(input.clone(), true)?
            }
            _ => return Ok(json!(false)),
        }
    }
    let name: String = string(&input, "name")?
        .trim()
        .chars()
        .take(40)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let path = app
        .dialog()
        .file()
        .set_parent(window)
        .set_title("保存分享文件")
        .set_file_name(format!("CopyX-{name}.copyx.json"))
        .add_filter("CopyX 自定义处理文件", &["json"])
        .blocking_save_file();
    let Some(path) = path else {
        return Ok(json!(false));
    };
    let path = path.into_path().map_err(|_| "请选择本地文件")?;
    atomic_write(&path, &bytes).map_err(|_| "无法保存分享文件，请检查目标目录权限和可用空间")?;
    Ok(json!(true))
}

pub fn import(app: &AppHandle, window: &WebviewWindow) -> Result<Value> {
    let path = app
        .dialog()
        .file()
        .set_parent(window)
        .set_title("导入自定义处理")
        .add_filter("CopyX 自定义处理文件", &["json"])
        .blocking_pick_file();
    let Some(path) = path else {
        return Ok(Value::Null);
    };
    let path = path.into_path().map_err(|_| "请选择本地文件")?;
    let bytes = read_limited(&path, LIMIT)
        .map_err(|_| "无法读取所选文件，请检查文件权限和 8 MB 大小限制")?;
    decode(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 旧版分享格式隔离身份和配置() {
        let raw = json!({"format":FORMAT,"version":1,"scheme":{"name":"处理","kind":"ai","prompt":"中文\r\n","id":"old","modelId":"private","enabled":true,"shortcutMac":"Command+Shift+C"}});
        let item = decode(raw.to_string().as_bytes()).unwrap();
        assert_ne!(item["id"], "old");
        assert_eq!(item["prompt"], "中文\r\n");
        assert_eq!(item["enabled"], false);
        assert!(item.get("modelId").is_none());
    }
}
