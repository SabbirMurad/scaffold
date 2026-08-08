use std::env;
use serde::Deserialize;
use serde_json::{json, Value};
use actix_web::{web, Error, HttpRequest, HttpResponse};
use crate::utils::response::Response;
use crate::Middleware::Auth::{require_access, AccessRequirement};

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    prompt: String,
    // Target device size (px). Optional — defaults to a common phone screen.
    device: Option<Device>,
}

#[derive(Debug, Deserialize)]
pub struct Device {
    w: Option<i64>,
    h: Option<i64>,
}

// The design DSL the model must emit. Deliberately small and flat-per-node (not
// the full editor schema) — the frontend expands it into real nodes via makeNode
// and the auto-layout engine, so the model never deals with ids or coordinates.
const SYSTEM_PROMPT: &str = r##"You are a mobile UI generator for a Flutter design tool. Given a plain-language request, output ONE mobile screen as JSON. Respond with ONLY the JSON object — no prose, no markdown fences.

Shape:
{
  "screen": {
    "name": "Login",                     // short PascalCase-ish name
    "background": "#ffffff",             // hex; screen fill
    "padding": 20,                        // px inset around content
    "gap": 16,                            // vertical px gap between children
    "align": "stretch",                  // stretch | left | center | right
    "children": [ <node>, ... ]
  }
}

A <node> is one of:
  text:      { "type":"text", "text":"...", "fontSize":16, "fontWeight":"400|500|600|700", "color":"#111827", "align":"left|center|right" }
  container: { "type":"container", "layout":"column|row|stack|none", "gap":12, "padding":16, "fill":"#f3f4f6", "radius":12, "align":"stretch|left|center|right", "height":<px optional>, "children":[ <node>, ... ] }
  image:     { "type":"image", "height":180, "radius":12, "fill":"#e5e7eb" }   // placeholder box
  button:    { "type":"button", "text":"Sign in", "fill":"#2563eb", "color":"#ffffff", "radius":10 }

Rules:
- Output valid JSON only. Use double-quoted keys and hex colors.
- Compose realistic, well-spaced mobile layouts. Prefer column layouts; use row for horizontal groups.
- Put related fields in containers with a fill/radius to make cards.
- Use concrete, realistic copy (never lorem ipsum).
- Widths are automatic (children fill their parent) — never specify width or x/y.
- Keep it to a single screen with a sensible amount of content."##;

pub async fn task(req: HttpRequest, body: web::Json<ReqBody>) -> Result<HttpResponse, Error> {
    // Any signed-in user may generate. (Editing gates still apply when the result
    // is inserted client-side.)
    let _user = require_access(&req, AccessRequirement::AnyToken)?;

    let prompt = body.prompt.trim();
    if prompt.is_empty() {
        return Ok(Response::bad_request("Describe the screen you want to generate"));
    }

    let api_key = match env::var("ANTHROPIC_API_KEY") {
        Ok(key) if !key.trim().is_empty() => key,
        _ => return Ok(Response::internal_server_error(
            "AI is not configured — set ANTHROPIC_API_KEY on the server",
        )),
    };
    let model = env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-opus-5".to_string());

    let device = body.device.as_ref();
    let dev_w = device.and_then(|d| d.w).unwrap_or(393);
    let dev_h = device.and_then(|d| d.h).unwrap_or(852);
    let user_msg = format!(
        "Design this screen for a {dev_w}x{dev_h} phone.\n\nRequest: {prompt}"
    );

    let payload = json!({
        "model": model,
        "max_tokens": 16000,
        // Keep latency low for an interactive tool; adaptive thinking stays on.
        "output_config": { "effort": "low" },
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": user_msg }],
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&payload)
        .send()
        .await;

    let resp = match resp {
        Ok(resp) => resp,
        Err(error) => {
            log::error!("ai request failed: {:?}", error);
            return Ok(Response::internal_server_error("Couldn't reach the AI service"));
        }
    };

    let status = resp.status();
    let json_body: Value = match resp.json().await {
        Ok(value) => value,
        Err(error) => {
            log::error!("ai response parse failed: {:?}", error);
            return Ok(Response::internal_server_error("The AI service returned an unreadable response"));
        }
    };

    if !status.is_success() {
        let message = json_body["error"]["message"].as_str().unwrap_or("The AI service returned an error");
        log::error!("ai service error {}: {}", status, message);
        return Ok(Response::internal_server_error(message));
    }

    if json_body["stop_reason"].as_str() == Some("refusal") {
        return Ok(Response::bad_request("The request was declined — try describing a UI screen"));
    }

    // Concatenate all text blocks (thinking blocks carry empty text and are skipped).
    let text: String = json_body["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    let design = match extract_json(&text) {
        Some(value) => value,
        None => {
            log::error!("ai returned no parseable JSON: {}", text);
            return Ok(Response::internal_server_error("The AI response wasn't valid — try again"));
        }
    };

    Ok(HttpResponse::Ok()
        .content_type("application/json")
        .json(json!({ "design": design })))
}

// Pull the JSON object out of the model's text: prefer a ```json fenced block,
// otherwise the first '{' … matching last '}'. Tolerant of stray prose.
fn extract_json(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        return Some(value);
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&text[start..=end]).ok()
}
