//! The Claude panel: the person's own Claude Code, run headless.
//!
//! The same structure as the video editor's agent. Scaffold does not run an
//! agent loop or hold an API key. It writes an MCP config pointing at its own
//! server (`scaffold mcp`, see mcp.rs), starts `claude -p` as the person's
//! terminal would run it — their settings, skills and permission mode — with
//! permission prompts answered in the panel, and turns the JSON lines it prints
//! into the conversation shown there.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bridge::Bridge;

/// The MCP server's name in the config; tools arrive as `mcp__scaffold__<tool>`.
const SERVER: &str = "scaffold";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    /// Claude said something to the person.
    Said { text: String },
    /// Claude called a tool (`id` pairs it with its answer).
    Using { id: String, tool: String, input: Value },
    /// That call answered.
    Answered { id: String, ok: bool, summary: String },
    /// The turn ended.
    Done {
        ok: bool,
        session: Option<String>,
        summary: String,
        /// Set when Claude Code stopped for its own reason (a usage limit, a
        /// turn cap) rather than because the work was finished.
        stopped_by: Option<String>,
    },
    /// Something went wrong before or instead of an answer.
    Failed { detail: String },
    /// The session asked to resume no longer exists in Claude Code (its history
    /// was cleared, or this is another computer). Nothing ran; the panel gives
    /// the project a new session and sends the message again.
    SessionMissing,
}

/// The process id of the turn in progress, if any. One turn at a time.
#[derive(Default)]
pub struct Running(Mutex<Option<u32>>);

#[tauri::command]
pub fn claude_status() -> Value {
    json!({ "claude": find_claude().map(|p| p.to_string_lossy().into_owned()) })
}

/// Start one turn. Returns once Claude Code is running; the turn itself arrives
/// as `claude` events, ending with `done` or `failed`.
#[tauri::command]
pub fn claude_ask(
    app: AppHandle,
    bridge: State<'_, Bridge>,
    running: State<'_, Running>,
    project: String,
    text: String,
    resume: Option<String>,
) -> Result<(), String> {
    let claude = find_claude().ok_or(
        "Claude Code is not on this computer. Scaffold uses your own Claude Code — install it and sign in, then try again.",
    )?;
    let mut slot = running.0.lock().unwrap();
    if slot.is_some() {
        return Err("Claude is still working on the last message.".into());
    }

    let workspace = workspace(&app, &project)?;
    let config = mcp_config(&workspace, bridge.port, &bridge.token).map_err(|e| e.to_string())?;
    let prompt = design_prompt(&workspace).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&claude);
    cmd.args(argv(&config, prompt.as_deref(), resume.as_deref()))
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Claude Code could not be started: {e}"))?;
    *slot = Some(child.id());
    drop(slot);

    // The message goes in on stdin, not argv: on Windows `claude` is usually a
    // .cmd script, and Rust refuses some characters in a batch file's arguments.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
    }

    let stderr = child.stderr.take();
    let tail = std::thread::spawn(move || {
        let mut tail: Vec<String> = Vec::new();
        if let Some(err) = stderr {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    tail.push(line);
                    if tail.len() > 20 {
                        tail.remove(0);
                    }
                }
            }
        }
        tail
    });

    let stdout = child.stdout.take();
    std::thread::spawn(move || {
        // The turn's last event is held until the process has exited and the
        // slot is free, so the panel can send the next message (or retry in a
        // new session) the moment it hears the turn is over.
        let mut last: Option<Event> = None;
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    for event in translate(&value) {
                        if matches!(event, Event::Done { .. } | Event::SessionMissing) {
                            last = Some(event);
                        } else {
                            let _ = app.emit("claude", event);
                        }
                    }
                }
            }
        }
        let status = child.wait();
        let tail = tail.join().unwrap_or_default();
        *app.state::<Running>().0.lock().unwrap() = None;

        let last = last.unwrap_or_else(|| Event::Failed {
            detail: match status {
                Ok(s) if s.success() && tail.is_empty() => "Claude Code ended without an answer.".to_string(),
                _ if !tail.is_empty() => tail.join("\n"),
                Ok(s) => format!("Claude Code stopped ({s})."),
                Err(e) => e.to_string(),
            },
        });
        let _ = app.emit("claude", last);
    });
    Ok(())
}

/// Stop the turn in progress. Edits already made stay on the canvas.
#[tauri::command]
pub fn claude_stop(running: State<'_, Running>) {
    let Some(pid) = *running.0.lock().unwrap() else { return };
    // The whole tree: on Windows the child is cmd.exe with node under it.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

/// Claude Code's working directory for one Scaffold project: a folder of
/// Scaffold's own, so no CLAUDE.md or settings are picked up by accident, and
/// each project's Claude Code sessions are kept together.
fn workspace(app: &AppHandle, project: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("claude")
        .join(folder_name(project));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A project id as a folder name. Ids are UUIDs; anything else is reduced to
/// safe characters so it can never point outside the workspace root.
fn folder_name(project: &str) -> String {
    let name: String = project
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if name.is_empty() { "scratch".to_string() } else { name }
}

/// The MCP config naming Scaffold's server — this binary, pointed at this
/// launch's bridge. Rewritten every turn because the port and token change with
/// each launch.
fn mcp_config(dir: &Path, port: u16, token: &str) -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let path = dir.join("mcp.json");
    let config = json!({
        "mcpServers": {
            SERVER: {
                "command": exe.to_string_lossy(),
                "args": ["mcp", "--port", port.to_string(), "--token", token],
            }
        }
    });
    std::fs::write(&path, serde_json::to_string_pretty(&config)?)?;
    Ok(path)
}

/// The design skill Scaffold has Claude use for new designs, when it's installed.
const DESIGN_SKILL: &str = "ui-ux-pro-max";

/// What Claude is told on top of Claude Code's own system prompt: new designs
/// and wireframes always start from the design skill. Written only when the
/// skill is installed (otherwise there is nothing to load), and passed as a
/// file because `claude` on Windows is a .cmd script and multi-line arguments
/// don't survive it.
fn design_prompt(dir: &Path) -> std::io::Result<Option<PathBuf>> {
    let path = dir.join("design-workflow.md");
    if !skill_installed(DESIGN_SKILL) {
        let _ = std::fs::remove_file(&path);
        return Ok(None);
    }
    std::fs::write(
        &path,
        format!(
            "# Designing in Scaffold\n\n\
             Whenever the person asks for a new design — a new app, screens, a flow, a redesign, or wireframes — \
             you MUST load the {DESIGN_SKILL} skill with the Skill tool before building anything, and follow its workflow:\n\
             1. Generate a design system with its search script (--design-system), from the product, audience and mood in the request. \
             Add --stack flutter for implementation guidance, since Scaffold exports Flutter.\n\
             2. Build what it recommends in Scaffold through the scaffold tools: color variables with light and dark values, \
             text styles, then the screens. Deliver design on the canvas, never HTML or code files.\n\
             3. Run check_design and fix every issue it reports.\n\n\
             Skip the skill only for small changes to an existing design (moving, recoloring, renaming, fixing issues).\n"
        ),
    )?;
    Ok(Some(path))
}

/// Whether a skill is installed where Claude Code finds it: the person's own
/// skills folder, or a plugin's.
fn skill_installed(name: &str) -> bool {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return false;
    };
    let claude = PathBuf::from(home).join(".claude");
    if claude.join("skills").join(name).join("SKILL.md").is_file() {
        return true;
    }
    // Plugins keep skills at <plugin>/skills/<name>/SKILL.md, a few levels down.
    fn find(dir: &Path, name: &str, depth: u8) -> bool {
        if depth == 0 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return false };
        entries.flatten().any(|e| {
            let path = e.path();
            path.is_dir()
                && ((e.file_name() == name && path.join("SKILL.md").is_file()) || find(&path, name, depth - 1))
        })
    }
    find(&claude.join("plugins"), name, 7)
}

/// The command line, built in one place because every flag is load-bearing.
fn argv(config: &Path, prompt: Option<&Path>, resume: Option<&str>) -> Vec<String> {
    // Claude Code runs as it does in the person's terminal: their settings,
    // skills, MCP servers, permission mode and built-in tools all apply. What
    // would ask them in a terminal asks them in the panel instead, through
    // Scaffold's permission tool (mcp.rs → bridge → the page).
    let mut args: Vec<String> = [
        "-p",
        "--mcp-config",
        &config.to_string_lossy(),
        "--permission-prompt-tool",
        &format!("mcp__{SERVER}__{}", crate::mcp::PERMISSION_TOOL),
        // Scaffold's own design tools never need asking: every edit is on the
        // person's undo history.
        "--allowedTools",
        &format!("mcp__{SERVER}"),
        // One JSON object per line, so the panel shows the turn as it happens.
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(prompt) = prompt {
        args.push("--append-system-prompt-file".into());
        args.push(prompt.to_string_lossy().into_owned());
    }
    if let Some(session) = resume {
        args.push("--resume".into());
        args.push(session.into());
    }
    args
}

/// One line of Claude Code's stream as the panel's own events. Anything not
/// understood here is ignored rather than shown unexplained.
fn translate(v: &Value) -> Vec<Event> {
    let mut out = Vec::new();
    let content = || {
        v.pointer("/message/content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    match v.get("type").and_then(Value::as_str) {
        Some("assistant") => {
            for block in content() {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.trim().is_empty() {
                            out.push(Event::Said { text: text.to_string() });
                        }
                    }
                    Some("tool_use") => out.push(Event::Using {
                        id: block.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                        tool: block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("a tool")
                            .trim_start_matches(&format!("mcp__{SERVER}__"))
                            .to_string(),
                        input: block.get("input").cloned().unwrap_or(Value::Null),
                    }),
                    _ => {}
                }
            }
        }
        Some("user") => {
            // A tool result comes back as a user message; the envelope inside it
            // is the editor's own answer, which is what to show.
            for block in content() {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let text = match block.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(items)) => items
                        .iter()
                        .find_map(|i| i.get("text").and_then(Value::as_str))
                        .unwrap_or("")
                        .to_string(),
                    _ => String::new(),
                };
                let envelope: Option<Value> = serde_json::from_str(&text).ok();
                let is_error = block.get("is_error").and_then(Value::as_bool) == Some(true);
                out.push(Event::Answered {
                    id: block.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string(),
                    ok: envelope
                        .as_ref()
                        .and_then(|e| e.get("ok"))
                        .and_then(Value::as_bool)
                        .unwrap_or(!is_error),
                    summary: envelope
                        .as_ref()
                        .and_then(|e| e.get("summary"))
                        .and_then(Value::as_str)
                        .unwrap_or(text.lines().next().unwrap_or(""))
                        .to_string(),
                });
            }
        }
        Some("result") => {
            let subtype = v.get("subtype").and_then(Value::as_str).unwrap_or("success");
            // Failures carry their reason in `errors`, not `result`.
            let errors: Vec<&str> = v
                .get("errors")
                .and_then(Value::as_array)
                .map(|e| e.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if errors.iter().any(|e| e.contains("No conversation found")) {
                out.push(Event::SessionMissing);
                return out;
            }
            let text = match v.get("result").and_then(Value::as_str) {
                Some(t) if !t.is_empty() => t.to_string(),
                _ if !errors.is_empty() => errors.join("\n"),
                _ if subtype != "success" => format!("Claude Code stopped ({subtype})."),
                _ => String::new(),
            };
            let stopped_by = match subtype {
                "success" => None,
                "error_max_turns" => Some("It stopped after its turn limit.".to_string()),
                s if s.contains("limit") || text.to_lowercase().contains("usage limit") => Some(
                    "Claude Code has reached your plan's usage limit. What it made so far is on \
                     the canvas; send another message once the limit resets."
                        .to_string(),
                ),
                // Any other failure: its message is the summary, shown as an error.
                _ => None,
            };
            out.push(Event::Done {
                ok: v.get("is_error").and_then(Value::as_bool) != Some(true),
                session: v.get("session_id").and_then(Value::as_str).map(str::to_string),
                summary: text,
                stopped_by,
            });
        }
        _ => {}
    }
    out
}

/// Where Claude Code is, if it is anywhere. Only looks; never installs.
pub fn find_claude() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let mut tried: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = PathBuf::from(home);
        tried.push(home.join(".local").join("bin").join(exe));
        tried.push(home.join("AppData").join("Roaming").join("npm").join("claude.cmd"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            tried.push(dir.join(exe));
            if cfg!(windows) {
                tried.push(dir.join("claude.cmd"));
            }
        }
    }
    tried.into_iter().find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(json: &str) -> Vec<Event> {
        translate(&serde_json::from_str(json).unwrap())
    }

    #[test]
    fn tool_names_drop_the_mcp_prefix() {
        let events = line(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__scaffold__create_screen","input":{}}]}}"#,
        );
        assert!(matches!(&events[0], Event::Using { tool, .. } if tool == "create_screen"));
    }

    #[test]
    fn a_tool_result_shows_the_editors_summary() {
        let events = line(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"{\"ok\":true,\"summary\":\"Added Login\"}"}]}]}}"#,
        );
        assert!(matches!(&events[0], Event::Answered { id, ok: true, summary } if summary == "Added Login" && id == "tu1"));
    }

    #[test]
    fn the_result_line_ends_the_turn_with_its_session() {
        let events = line(r#"{"type":"result","subtype":"success","result":"Done.","session_id":"abc"}"#);
        assert!(matches!(&events[0], Event::Done { ok: true, session: Some(s), stopped_by: None, .. } if s == "abc"));
    }

    #[test]
    fn a_session_claude_code_no_longer_has_is_reported_as_missing() {
        // What Claude Code 2.1.282 prints for `--resume <unknown id>`.
        let events = line(
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"session_id":"0000","errors":["No conversation found with session ID: 0000"]}"#,
        );
        assert!(matches!(&events[0], Event::SessionMissing));
    }

    #[test]
    fn a_failed_turn_shows_its_error() {
        let events = line(r#"{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["boom"]}"#);
        assert!(matches!(&events[0], Event::Done { ok: false, summary, stopped_by: None, .. } if summary == "boom"));
    }

    #[test]
    fn project_folders_stay_inside_the_workspace() {
        assert_eq!(folder_name("0193a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b"), "0193a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b");
        assert_eq!(folder_name("../../etc"), "etc");
        assert_eq!(folder_name(""), "scratch");
    }

    #[test]
    fn runs_like_the_terminal_with_prompts_sent_to_the_panel() {
        let args = argv(Path::new("mcp.json"), Some(Path::new("design-workflow.md")), Some("s1"));
        let after = |flag: &str| args[args.iter().position(|a| a == flag).unwrap() + 1].clone();
        assert_eq!(after("--permission-prompt-tool"), "mcp__scaffold__permission_prompt");
        assert_eq!(after("--allowedTools"), "mcp__scaffold");
        assert_eq!(after("--resume"), "s1");
        assert_eq!(after("--append-system-prompt-file"), "design-workflow.md");
        assert!(!argv(Path::new("mcp.json"), None, None).iter().any(|a| a == "--append-system-prompt-file"));
        // Nothing narrows Claude Code below what the person's own setup allows.
        assert!(!args.iter().any(|a| a == "--tools" || a == "--strict-mcp-config"));
    }
}
