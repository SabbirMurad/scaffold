//! `scaffold mcp --port N --token T` — Scaffold's tools as an MCP server.
//!
//! Claude Code starts this from the config agent.rs writes, and talks to it over
//! stdio. It holds no design state of its own: the tool list and every call are
//! passed through the bridge (bridge.rs) to the editor that is open, so the tools
//! are defined in one place — assets/js/claude-tools.js — next to the code that
//! carries them out.
//!
//! Protocol handling follows the video editor's server: both the stateless
//! 2026-07-28 revision (version in every request's `_meta`) and the older
//! `initialize` handshake, so it works with whichever Claude Code is installed.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{Value, json};

use crate::bridge::failure;

const MODERN: &str = "2026-07-28";
const LEGACY: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";

/// The tool Claude Code calls (via `--permission-prompt-tool`) when something
/// would ask the person in a terminal. The editor shows Allow / Deny.
pub const PERMISSION_TOOL: &str = "permission_prompt";

fn permission_tool() -> Value {
    json!({
        "name": PERMISSION_TOOL,
        "title": "Ask the person",
        "description": "Used by Claude Code itself to ask the person for permission. Never call it directly.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool_name": { "type": "string" },
                "input": { "type": "object" },
                "tool_use_id": { "type": "string" }
            },
            "required": ["tool_name", "input"]
        },
    })
}

const INSTRUCTIONS: &str = "\
Scaffold is a design tool for Flutter apps. You are working in the person's open project through these tools; they watch the canvas change as you go, and every edit you make is on their undo history like one of their own.

You can do everything the person can do by hand in the editor:
- The canvas: get_design (the tree of sections, screens and elements, with ids), get_element (every field of one element), create_screen, create_section, add_elements, update_element, move_element, duplicate_elements, delete_elements, make_component (then place instances with add_elements), set_interaction (what a tap does: navigate to a screen or go back), search_icons, focus.
- Design tokens: edit_color (color variables, a value per theme), edit_theme, set_color_role (Material ColorScheme roles), edit_text_style.
- Data: edit_model, edit_enum, edit_mock_data, edit_provider (API providers, endpoints and the base URL). get_data shows all of it.
- The project: comments, rename_project, undo, export_code.

How to work:
- Start with get_design (and get_data when tokens or data matter) unless you already know the project from this conversation. The person edits between your turns, so look again rather than assuming.
- Build a new screen in one create_screen call with its nested children, rather than element by element.
- Layout is automatic: screens and containers lay children out as a column, row or wrap with gap and padding, and children fill the parent's width. Only stacks, sections and the bare canvas use x/y.
- Prefer the project's color variables (\"var:<name>\") and text styles over raw values when it has them, so the design stays consistent and themeable; create variables and styles when a design needs a system.
- Names follow the editor's rules, because they become code: screens and sections snake_case, color variables and text styles camelCase, models and enums PascalCase, model fields snake_case.
- Mock data drives the design: bind text, images and colors to fields, show elements only while a condition holds (a whole section for admins only, an empty state when a list is empty), repeat a container's children once per list item (design the item once), and route taps differently by data. Use it whenever the design shows data from a model that has mock data.
- Write realistic copy, never lorem ipsum.
- Check your work: create_screen, add_elements, update_element and move_element report layout and contrast issues on the screen they changed, and check_design reports them for any screen. Fix every issue before you finish — the person sees exactly what these report.
- When a request is vague, make a clear, reasonable design and say briefly what you made rather than asking first.
- Every tool returns ok and a summary. When ok is false, read the summary, fix the call and try again once; then tell the person what did not work.
- Skills: for a new design or wireframes, use the ui-ux-pro-max skill when it's installed (its Flutter stack guidance fits, since Scaffold exports Flutter). Deliver what it recommends as Scaffold design through these tools — color variables with light and dark values, text styles, then screens — not as HTML or code files.
- Wireframes: when asked for wireframes, build low-fidelity greyscale screens (boxes, placeholder images, real labels) in their own section; build the finished design in another section.
- Your other tools (shell, files, web) work as in the person's terminal; anything that needs permission asks them in the Scaffold panel.";

pub fn main(args: &[String]) -> i32 {
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let (Some(port), Some(token)) = (flag("--port").and_then(|p| p.parse().ok()), flag("--token")) else {
        eprintln!("usage: scaffold mcp --port <port> --token <token>");
        return 2;
    };
    let bridge = Bridge { port, token, conn: None };
    let mut server = Server { bridge, legacy: false };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = server.handle_line(&line) {
            if writeln!(stdout, "{reply}").and_then(|_| stdout.flush()).is_err() {
                break;
            }
        }
    }
    0
}

/// A connection to the app's bridge, opened on first use and reopened if dropped.
struct Bridge {
    port: u16,
    token: String,
    conn: Option<(TcpStream, BufReader<TcpStream>)>,
}

impl Bridge {
    fn ask(&mut self, mut req: Value) -> Value {
        req["token"] = json!(self.token);
        // One retry: the connection may have gone stale between turns.
        for _ in 0..2 {
            match self.send(&req) {
                Ok(v) => return v,
                Err(_) => self.conn = None,
            }
        }
        failure("Scaffold is not running, or its editor is closed")
    }

    fn send(&mut self, req: &Value) -> std::io::Result<Value> {
        if self.conn.is_none() {
            let stream = TcpStream::connect(("127.0.0.1", self.port))?;
            // Long enough for the person to answer a permission prompt.
            stream.set_read_timeout(Some(Duration::from_secs(35 * 60)))?;
            let reader = BufReader::new(stream.try_clone()?);
            self.conn = Some((stream, reader));
        }
        let (stream, reader) = self.conn.as_mut().unwrap();
        writeln!(stream, "{req}")?;
        stream.flush()?;
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        serde_json::from_str(&line).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }
}

struct Server {
    bridge: Bridge,
    /// Opened with `initialize` (older clients) rather than per-request versions.
    legacy: bool,
}

impl Server {
    fn handle_line(&mut self, line: &str) -> Option<Value> {
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => return Some(error(Value::Null, -32700, &format!("parse error: {e}"), None)),
        };
        if msg.is_array() {
            return Some(error(Value::Null, -32600, "batches are not supported", None));
        }
        let method = msg.get("method").and_then(Value::as_str)?;
        // Notifications (initialized, cancelled) need no answer.
        let id = msg.get("id").cloned()?;
        let params = msg.get("params").cloned().unwrap_or(json!({}));
        Some(self.request(id, method, &params))
    }

    fn request(&mut self, id: Value, method: &str, params: &Value) -> Value {
        if method == "initialize" {
            let asked = params.get("protocolVersion").and_then(Value::as_str);
            let version = asked.filter(|v| LEGACY.contains(v)).unwrap_or(LEGACY[0]);
            self.legacy = true;
            return json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": server_info(),
                    "instructions": INSTRUCTIONS,
                }
            });
        }

        let requested = params
            .get("_meta")
            .and_then(|m| m.get(VERSION_KEY))
            .and_then(Value::as_str);
        let modern = match requested {
            Some(MODERN) => true,
            Some(other) => {
                return error(
                    id,
                    -32022,
                    "Unsupported protocol version",
                    Some(json!({ "supported": supported(), "requested": other })),
                );
            }
            None if self.legacy || method == "ping" => false,
            None => {
                return error(
                    id,
                    -32602,
                    &format!("missing _meta[\"{VERSION_KEY}\"], or open with initialize"),
                    None,
                );
            }
        };

        let result = match method {
            "server/discover" if modern => Ok(json!({
                "supportedVersions": [MODERN],
                "capabilities": { "tools": {} },
                "instructions": INSTRUCTIONS,
            })),
            "ping" => Ok(json!({})),
            "tools/list" => self.list(),
            "tools/call" => self.call(params),
            _ => Err((-32601, format!("method not found: {method}"))),
        };
        match result {
            Ok(mut value) => {
                if modern {
                    value["resultType"] = json!("complete");
                    value["_meta"] = json!({ "io.modelcontextprotocol/serverInfo": server_info() });
                }
                json!({ "jsonrpc": "2.0", "id": id, "result": value })
            }
            Err((code, message)) => error(id, code, &message, None),
        }
    }

    fn list(&mut self) -> Result<Value, (i64, String)> {
        let answer = self.bridge.ask(json!({ "method": "list" }));
        match answer.get("tools") {
            Some(Value::Array(tools)) => {
                let mut tools = tools.clone();
                tools.push(permission_tool());
                Ok(json!({ "tools": tools }))
            }
            _ => Err((
                -32603,
                answer
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or("the editor did not list its tools")
                    .to_string(),
            )),
        }
    }

    fn call(&mut self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or((-32602, "tools/call needs a name".to_string()))?;
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => json!({}),
            Some(v @ Value::Object(_)) => v.clone(),
            Some(_) => return Err((-32602, "arguments must be an object".to_string())),
        };
        if name == PERMISSION_TOOL {
            return Ok(self.permission(&arguments));
        }
        // A failed edit is the model's to fix, so it is a tool result with
        // isError, not a protocol error it would never see.
        let envelope = self.bridge.ask(json!({ "method": "call", "name": name, "arguments": arguments }));
        let ok = envelope.get("ok").and_then(Value::as_bool).unwrap_or(false);
        Ok(json!({
            "content": [{ "type": "text", "text": envelope.to_string() }],
            "isError": !ok,
        }))
    }
}

impl Server {
    /// Ask the person, and answer Claude Code in the shape its permission
    /// prompt tool expects: allow (with the input to run) or deny (with why).
    fn permission(&mut self, arguments: &Value) -> Value {
        let answer = self.bridge.ask(json!({ "method": "permission", "arguments": arguments }));
        let decision = if answer.get("behavior").and_then(Value::as_str) == Some("allow") {
            json!({ "behavior": "allow", "updatedInput": arguments.get("input").cloned().unwrap_or(json!({})) })
        } else {
            let message = answer
                .get("message")
                .or_else(|| answer.get("summary"))
                .and_then(Value::as_str)
                .unwrap_or("The person denied this.");
            json!({ "behavior": "deny", "message": message })
        };
        json!({ "content": [{ "type": "text", "text": decision.to_string() }] })
    }
}

fn server_info() -> Value {
    json!({ "name": "scaffold", "title": "Scaffold", "version": env!("CARGO_PKG_VERSION") })
}

fn supported() -> Vec<&'static str> {
    std::iter::once(MODERN).chain(LEGACY).collect()
}

fn error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut e = json!({ "code": code, "message": message });
    if let Some(d) = data {
        e["data"] = d;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": e })
}
