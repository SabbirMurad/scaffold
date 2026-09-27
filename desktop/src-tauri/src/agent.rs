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
    /// Setting up before Claude Code starts (installing the design skill).
    Preparing { text: String },
    /// Something went wrong before or instead of an answer.
    Failed { detail: String },
    /// The session asked to resume no longer exists in Claude Code (its history
    /// was cleared, or this is another computer). Nothing ran; the panel gives
    /// the project a new session and sends the message again.
    SessionMissing,
}

/// The turn in progress, if any. One turn at a time.
#[derive(Default)]
pub struct Running(Mutex<Option<Turn>>);

/// A turn: its number (so a stopped turn's setup can tell it was replaced), and
/// Claude Code's process id once it has started.
#[derive(Clone, Copy)]
pub struct Turn {
    id: u64,
    pid: Option<u32>,
}

static TURNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
pub fn claude_status() -> Value {
    json!({ "claude": find_claude().map(|p| p.to_string_lossy().into_owned()) })
}

/// Start one turn. Returns at once; the turn arrives as `claude` events — first
/// `preparing` while the design skill is checked (and installed if missing),
/// then Claude Code's own, ending with `done` or `failed`.
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
    let workspace = workspace(&app, &project)?;
    let config = mcp_config(&workspace, bridge.port, &bridge.token).map_err(|e| e.to_string())?;

    let id = {
        let mut slot = running.0.lock().unwrap();
        if slot.is_some() {
            return Err("Claude is still working on the last message.".into());
        }
        let id = TURNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        *slot = Some(Turn { id, pid: None });
        id
    };

    // Checking for the skill runs `claude plugin …`, and installing it clones a
    // repository, so it happens off the command thread.
    std::thread::spawn(move || {
        let fail = |detail: String| {
            let running = app.state::<Running>();
            let mut slot = running.0.lock().unwrap();
            // Stopped (and possibly replaced by a newer turn): the stop said so.
            if slot.map(|t| t.id) != Some(id) {
                return;
            }
            *slot = None;
            drop(slot);
            let _ = app.emit("claude", Event::Failed { detail });
        };
        let say = |text: &str| {
            let _ = app.emit("claude", Event::Preparing { text: text.to_string() });
        };
        // The skill's scripts are Python; it's no use without it.
        let python = match crate::python::ensure(say) {
            Ok(found) => found,
            Err(detail) => return fail(detail),
        };
        if let Err(detail) = ensure_design_skill(&claude, say) {
            return fail(detail);
        }
        let prompt = match design_prompt(&workspace) {
            Ok(path) => path,
            Err(e) => return fail(e.to_string()),
        };
        start(app.clone(), id, &claude, &workspace, &config, &prompt, python.as_deref(), resume.as_deref(), &text)
            .unwrap_or_else(fail);
    });
    Ok(())
}

/// Start Claude Code for turn `id` and stream its answer as events.
#[allow(clippy::too_many_arguments)]
fn start(
    app: AppHandle,
    id: u64,
    claude: &Path,
    workspace: &Path,
    config: &Path,
    prompt: &Path,
    python: Option<&Path>,
    resume: Option<&str>,
    text: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(claude);
    cmd.args(argv(config, Some(prompt), resume))
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    // Python installed where this app's PATH doesn't reach (e.g. just now).
    if let Some(dir) = python {
        cmd.env("PATH", crate::python::path_with(dir));
    }

    let mut child = {
        let running = app.state::<Running>();
        let mut slot = running.0.lock().unwrap();
        // Stopped while the skill was being checked: don't start at all.
        if slot.map(|t| t.id) != Some(id) {
            return Ok(());
        }
        let child = cmd.spawn().map_err(|e| format!("Claude Code could not be started: {e}"))?;
        *slot = Some(Turn { id, pid: Some(child.id()) });
        child
    };

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

    // The turn's last event is held until the process has exited and the slot
    // is free, so the panel can send the next message (or retry in a new
    // session) the moment it hears the turn is over.
    let mut last: Option<Event> = None;
    if let Some(out) = child.stdout.take() {
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
    Ok(())
}

/// Stop the turn in progress. Edits already made stay on the canvas.
#[tauri::command]
pub fn claude_stop(app: AppHandle, running: State<'_, Running>) {
    let mut slot = running.0.lock().unwrap();
    let Some(turn) = *slot else { return };
    let Some(pid) = turn.pid else {
        // Still checking for the skill: nothing to kill. Freeing the slot tells
        // the setup not to start Claude Code once it's done.
        *slot = None;
        drop(slot);
        let _ = app.emit("claude", Event::Failed { detail: "Stopped.".into() });
        return;
    };
    drop(slot);
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

pub(crate) fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
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
pub(crate) fn mcp_config(dir: &Path, port: u16, token: &str) -> std::io::Result<PathBuf> {
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

/// The design skill every design in Scaffold goes through.
const DESIGN_SKILL: &str = "ui-ux-pro-max";
/// Where it comes from when it has to be installed: the skill author's plugin
/// marketplace (github.com/nextlevelbuilder/ui-ux-pro-max-skill).
const SKILL_MARKETPLACE: &str = "nextlevelbuilder/ui-ux-pro-max-skill";
const SKILL_PLUGIN: &str = "ui-ux-pro-max@ui-ux-pro-max-skill";

/// Make sure Claude Code has the design skill before a turn: a copy in the
/// person's own skills folder, or the plugin installed and enabled. Installs
/// (or re-enables) the plugin through Claude Code's own `claude plugin`
/// commands when it's missing, telling the panel through `say`. An error means
/// the turn can't run: design work never goes ahead without the skill.
fn ensure_design_skill(claude: &Path, say: impl Fn(&str)) -> Result<(), String> {
    if own_skill_installed(DESIGN_SKILL) {
        return Ok(());
    }
    match plugin_state(claude)? {
        PluginState::Enabled => return Ok(()),
        PluginState::Disabled(id) => {
            say("Turning on the ui-ux-pro-max design skill…");
            cli(claude, &["plugin", "enable", &id])?;
        }
        PluginState::Missing => {
            say("Installing the ui-ux-pro-max design skill…");
            // Adding a marketplace that's already there fails harmlessly; the
            // install below is what has to succeed.
            let added = cli(claude, &["plugin", "marketplace", "add", SKILL_MARKETPLACE]);
            if let Err(error) = cli(claude, &["plugin", "install", SKILL_PLUGIN]) {
                return Err(install_failed(added.err().unwrap_or(error)));
            }
        }
    }
    match plugin_state(claude)? {
        PluginState::Enabled => Ok(()),
        _ => Err(install_failed("Claude Code doesn't list it as enabled afterwards.".into())),
    }
}

fn install_failed(detail: String) -> String {
    format!(
        "Scaffold designs with the ui-ux-pro-max skill, and couldn't install it.\n\n{detail}\n\n\
         To install it yourself, run these in a terminal and send your message again:\n\
         claude plugin marketplace add {SKILL_MARKETPLACE}\n\
         claude plugin install {SKILL_PLUGIN}"
    )
}

#[derive(Debug, PartialEq)]
enum PluginState {
    Enabled,
    /// Installed but turned off; holds its `plugin@marketplace` id.
    Disabled(String),
    Missing,
}

/// The design skill's plugin as Claude Code itself reports it.
fn plugin_state(claude: &Path) -> Result<PluginState, String> {
    let out = cli(claude, &["plugin", "list", "--json"])?;
    let list: Value = serde_json::from_str(&out)
        .map_err(|e| format!("Couldn't read Claude Code's plugin list: {e}"))?;
    Ok(plugin_state_in(&list))
}

fn plugin_state_in(list: &Value) -> PluginState {
    let prefix = format!("{DESIGN_SKILL}@");
    let mut state = PluginState::Missing;
    for plugin in list.as_array().into_iter().flatten() {
        let Some(id) = plugin.get("id").and_then(Value::as_str) else { continue };
        if !id.starts_with(&prefix) {
            continue;
        }
        if plugin.get("enabled").and_then(Value::as_bool) != Some(false) {
            return PluginState::Enabled;
        }
        state = PluginState::Disabled(id.to_string());
    }
    state
}

/// Run a `claude` subcommand and return what it printed.
fn cli(claude: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(claude);
    cmd.args(args).stdin(Stdio::null());
    no_window(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("`claude {}` could not be started: {e}", args.join(" ")))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let said = [&out.stderr[..], &out.stdout[..]]
        .iter()
        .map(|b| String::from_utf8_lossy(b).trim().to_string())
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| format!("it exited with {}", out.status));
    Err(format!("`claude {}` failed: {said}", args.join(" ")))
}

/// What Claude is told on top of Claude Code's own system prompt: all design
/// work goes through the design skill. Passed as a file because `claude` on
/// Windows is a .cmd script and multi-line arguments don't survive it.
fn design_prompt(dir: &Path) -> std::io::Result<PathBuf> {
    let path = dir.join("design-workflow.md");
    std::fs::write(
        &path,
        format!(
            "# Designing in Scaffold\n\n\
             All design in Scaffold is done with the {DESIGN_SKILL} skill. It is installed \
             (as `{DESIGN_SKILL}:{DESIGN_SKILL}` when it comes from its plugin).\n\n\
             Before any design work, load it with the Skill tool, unless it is already loaded in this conversation, \
             and follow its workflow and rules for every design decision. Design work is anything that changes how the \
             app looks: new apps, screens, flows, sections or wireframes; adding, restyling or rearranging elements; \
             colors, themes, text styles, spacing, icons and imagery; redesigns and design fixes.\n\n\
             1. Start from its design system: run its search script with --design-system for the product, audience and mood, \
             then a separate --stack flutter query for implementation guidance, since Scaffold exports Flutter. When the project \
             already has color variables and text styles, keep to them and use the skill to extend them, rather than starting over.\n\
             2. Build what it recommends in Scaffold through the scaffold tools: color variables with light and dark values, \
             text styles, then the screens. Deliver design on the canvas, never HTML or code files.\n\
             3. Check the result against the skill's rules, then run check_design and fix every issue it reports.\n\n\
             Only work with no visual effect skips the skill: renaming, data models, mock data, API providers, \
             comments, undo and export.\n"
        ),
    )?;
    Ok(path)
}

/// Whether the skill is in the person's own skills folder (installed by hand
/// rather than through the plugin).
fn own_skill_installed(name: &str) -> bool {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return false;
    };
    PathBuf::from(home).join(".claude").join("skills").join(name).join("SKILL.md").is_file()
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
    fn the_design_skill_plugin_is_found_in_claude_codes_plugin_list() {
        // The shape `claude plugin list --json` prints (Claude Code 2.1.282).
        let list = |json: &str| plugin_state_in(&serde_json::from_str(json).unwrap());
        let other = r#"{"id":"rust-analyzer-lsp@claude-plugins-official","enabled":true}"#;
        assert_eq!(list(&format!("[{other}]")), PluginState::Missing);
        assert_eq!(list("[]"), PluginState::Missing);
        assert_eq!(
            list(&format!(r#"[{other},{{"id":"ui-ux-pro-max@ui-ux-pro-max-skill","enabled":true}}]"#)),
            PluginState::Enabled
        );
        assert_eq!(
            list(r#"[{"id":"ui-ux-pro-max@ui-ux-pro-max-skill","enabled":false}]"#),
            PluginState::Disabled("ui-ux-pro-max@ui-ux-pro-max-skill".into())
        );
        // A similarly named plugin isn't it.
        assert_eq!(list(r#"[{"id":"ui-ux-pro-max-lite@x","enabled":true}]"#), PluginState::Missing);
    }

    #[test]
    fn the_design_prompt_makes_the_skill_mandatory() {
        let dir = std::env::temp_dir().join(format!("scaffold-prompt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let text = std::fs::read_to_string(design_prompt(&dir).unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(text.contains("All design in Scaffold is done with the ui-ux-pro-max skill"));
        assert!(text.contains("ui-ux-pro-max:ui-ux-pro-max"));
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
