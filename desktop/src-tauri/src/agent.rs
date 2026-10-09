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
        if let Err(detail) = ensure_skills(&claude, say) {
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

/// Save an image the person pasted or dropped into the panel in the project's
/// working folder (attachments/), where Claude opens it with its Read tool.
/// `data` is the image as base64. Returns the saved file's path.
#[tauri::command]
pub fn claude_attach(app: AppHandle, project: String, name: String, data: String) -> Result<String, String> {
    let bytes = base64_decode(&data).ok_or("That image couldn't be read")?;
    if bytes.len() > MAX_ATTACHMENT {
        return Err("That image is over 10 MB".into());
    }
    let ext = image_kind(&bytes).ok_or("Only PNG, JPEG, GIF and WebP images can be attached")?;
    let dir = workspace(&app, &project)?.join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(40)
        .collect();
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("{millis}-{}.{ext}", stem.trim_matches('-')));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

const MAX_ATTACHMENT: usize = 10 * 1024 * 1024;

/// An attached image, read back for the editor (Claude's study_reference tool
/// measures its colors): a data: URL. Only files in this project's
/// attachments folder — the real path is checked, so `..` or a link can't
/// reach anything else.
#[tauri::command]
pub fn claude_read_attachment(app: AppHandle, project: String, path: String) -> Result<String, String> {
    let dir = workspace(&app, &project)?.join("attachments");
    let dir = dir.canonicalize().map_err(|_| "No images have been attached in this project".to_string())?;
    let file = Path::new(&path).canonicalize().map_err(|_| format!("No attached image at {path}"))?;
    if !file.starts_with(&dir) || !file.is_file() {
        return Err("Only images attached in the Claude panel can be studied by path".into());
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let mime = match image_kind(&bytes) {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => return Err("That file isn't an image".into()),
    };
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

fn base64_encode(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= chunk.len() { ABC[(n >> shift & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The image format, by its first bytes (not its name): what Claude can read.
fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("jpg"),
        [b'G', b'I', b'F', b'8', ..] => Some("gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("webp"),
        _ => None,
    }
}

/// Standard base64 (with or without a data: URL prefix, padding, or line breaks).
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let body = text.rsplit_once("base64,").map_or(text, |(_, b)| b);
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in body.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=') {
        acc = (acc << 6) | u32::from(value(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
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

/// A skill Claude Code needs for Scaffold, and the plugin marketplace it comes
/// from when it has to be installed.
struct Skill {
    /// Its name: the skill's folder in ~/.claude/skills, and the plugin's name.
    name: &'static str,
    /// What the panel calls it while installing.
    label: &'static str,
    marketplace: &'static str,
    /// `plugin@marketplace`, as `claude plugin install` takes it.
    plugin: &'static str,
    /// A required skill stops the turn when it can't be installed; an optional
    /// one only says so, and the turn goes on without it.
    required: bool,
    /// A skill that isn't a Claude Code plugin: a .tar.gz of its repository and
    /// the skill's folder inside it, copied to ~/.claude/skills/<name>.
    archive: Option<(&'static str, &'static str)>,
}

/// The design skill every design in Scaffold goes through
/// (github.com/nextlevelbuilder/ui-ux-pro-max-skill).
const DESIGN_SKILL: Skill = Skill {
    name: "ui-ux-pro-max",
    label: "ui-ux-pro-max design skill",
    marketplace: "nextlevelbuilder/ui-ux-pro-max-skill",
    plugin: "ui-ux-pro-max@ui-ux-pro-max-skill",
    required: true,
    archive: None,
};
/// The logo skill, for when a design needs a logo, app icon or favicon
/// (github.com/kaankiziltug/logo-design-skill).
const LOGO_SKILL: Skill = Skill {
    name: "logo-design",
    label: "logo design skill",
    marketplace: "kaankiziltug/logo-design-skill",
    plugin: "logo-design@logo-design-skill",
    required: false,
    archive: None,
};
/// The animation skill, for Lottie animations (github.com/diffusionstudio/lottie).
/// Not a plugin: its folder is copied from the repository's archive.
const LOTTIE_SKILL: Skill = Skill {
    name: "text-to-lottie",
    label: "animation skill",
    marketplace: "",
    plugin: "",
    required: false,
    archive: Some((
        "https://codeload.github.com/diffusionstudio/lottie/tar.gz/refs/heads/main",
        "lottie-main/skills/text-to-lottie",
    )),
};
const SKILLS: [&Skill; 3] = [&DESIGN_SKILL, &LOGO_SKILL, &LOTTIE_SKILL];

/// Make sure Claude Code has Scaffold's skills before a turn. An error means
/// the turn can't run: design work never goes ahead without the design skill.
fn ensure_skills(claude: &Path, say: impl Fn(&str)) -> Result<(), String> {
    for skill in SKILLS {
        match ensure_skill(claude, skill, &say) {
            Ok(()) => {}
            Err(detail) if skill.required => return Err(detail),
            Err(_) => say(&format!("Couldn't install the {} — going on without it.", skill.label)),
        }
    }
    Ok(())
}

/// One skill: a copy in the person's own skills folder, or the plugin installed
/// and enabled. Installs (or re-enables) the plugin through Claude Code's own
/// `claude plugin` commands when it's missing, telling the panel through `say`.
fn ensure_skill(claude: &Path, skill: &Skill, say: &impl Fn(&str)) -> Result<(), String> {
    if own_skill_installed(skill.name) {
        return Ok(());
    }
    if let Some((url, folder)) = skill.archive {
        say(&format!("Installing the {}…", skill.label));
        return install_from_archive(skill.name, url, folder);
    }
    match plugin_state(claude, skill)? {
        PluginState::Enabled => return Ok(()),
        PluginState::Disabled(id) => {
            say(&format!("Turning on the {}…", skill.label));
            cli(claude, &["plugin", "enable", &id])?;
        }
        PluginState::Missing => {
            say(&format!("Installing the {}…", skill.label));
            // Adding a marketplace that's already there fails harmlessly; the
            // install below is what has to succeed.
            let added = cli(claude, &["plugin", "marketplace", "add", skill.marketplace]);
            if let Err(error) = cli(claude, &["plugin", "install", skill.plugin]) {
                return Err(install_failed(skill, added.err().unwrap_or(error)));
            }
        }
    }
    match plugin_state(claude, skill)? {
        PluginState::Enabled => Ok(()),
        _ => Err(install_failed(skill, "Claude Code doesn't list it as enabled afterwards.".into())),
    }
}

/// Download a repository archive (curl and tar come with Windows 10+, macOS and
/// Linux) and copy one skill folder out of it into ~/.claude/skills/<name>.
fn install_from_archive(name: &str, url: &str, folder: &str) -> Result<(), String> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).ok_or("no home folder")?;
    let target = PathBuf::from(home).join(".claude").join("skills").join(name);
    let work = std::env::temp_dir().join(format!("scaffold-skill-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let archive = work.join("skill.tar.gz");
    let result = (|| {
        run_tool("curl", &["-fsSL", "--max-time", "120", "-o", &archive.to_string_lossy(), url])?;
        run_tool("tar", &["-xzf", &archive.to_string_lossy(), "-C", &work.to_string_lossy(), folder])?;
        let source = work.join(folder);
        if !source.join("SKILL.md").is_file() {
            return Err(format!("the download has no {folder}/SKILL.md"));
        }
        let _ = std::fs::remove_dir_all(&target);
        copy_dir(&source, &target).map_err(|e| format!("couldn't copy it to {}: {e}", target.display()))
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn run_tool(program: &str, args: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null());
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("`{program}` could not be started: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!("`{program}` failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

fn install_failed(skill: &Skill, detail: String) -> String {
    format!(
        "Scaffold designs with the {name} skill, and couldn't install it.\n\n{detail}\n\n\
         To install it yourself, run these in a terminal and send your message again:\n\
         claude plugin marketplace add {marketplace}\n\
         claude plugin install {plugin}",
        name = skill.name,
        marketplace = skill.marketplace,
        plugin = skill.plugin,
    )
}

#[derive(Debug, PartialEq)]
enum PluginState {
    Enabled,
    /// Installed but turned off; holds its `plugin@marketplace` id.
    Disabled(String),
    Missing,
}

/// A skill's plugin as Claude Code itself reports it.
fn plugin_state(claude: &Path, skill: &Skill) -> Result<PluginState, String> {
    let out = cli(claude, &["plugin", "list", "--json"])?;
    let list: Value = serde_json::from_str(&out)
        .map_err(|e| format!("Couldn't read Claude Code's plugin list: {e}"))?;
    Ok(plugin_state_in(&list, skill.name))
}

fn plugin_state_in(list: &Value, name: &str) -> PluginState {
    let prefix = format!("{name}@");
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
             All design in Scaffold is done with the {design} skill. It is installed \
             (as `{design}:{design}` when it comes from its plugin).\n\n\
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
             comments, undo and export.\n\n\
             ## Logos\n\n\
             When a design needs a logo, logotype, wordmark, brand mark, app icon or favicon, design it with the \
             {logo} skill (`{logo}:{logo}` from its plugin) together with the design skill: load it with the Skill tool \
             and follow its process for the thinking and the craft, using the project's colors and text styles. If it \
             isn't installed, design the logo by the usual principles without it.\n\n\
             The person sees and picks logos on the canvas, never in a folder: they are a designer working in Scaffold, \
             and the working folder is hidden from them. The skill's own steps say to save files and show a concept sheet \
             or board; in Scaffold those steps change:\n\
             - Draw and render in the working folder only to check your own work. Never point the person to a file or \
             folder there.\n\
             - Wherever the skill says to show concepts, a concept sheet, test sheets, a board or a presentation, put it \
             on the canvas instead, then stop and ask as the skill says: add_elements with no parent_id, placed in empty \
             space beside the screens, one container named \"Logo concepts\" (a row, gap 48, padding 48, a light fill, \
             radius 24). Inside it, one column per concept: the mark as an icon element with its markup in \"svg\" (it \
             stays vector and keeps its own colors) and an \"alt\" naming the brand, its lockup with the name the same \
             way, and a text with the concept's letter, name and one-line idea. Outline lettering to paths first: text \
             inside an SVG only draws in fonts the computer has. Then tell the person to look at the \"Logo concepts\" \
             board on the canvas.\n\
             - Once they pick one, put it in the design: replace the placeholder logo in the screens with the chosen \
             mark or lockup, and keep the board until they say to remove it. Give files only when they ask for files.\n\n\
             ## Reference images\n\n\
             When the person gives an image to design from (attached in the panel, a link, or an image on the canvas) — \
             \"like this\", \"in this style\", \"match this\" — measure it before deciding anything: open it with the Read \
             tool to see it, and run study_reference on it for its real colors, background, text and accent colors, \
             contrast, saturation and density. Base the palette on those measurements, not on an impression: the \
             measured colors become the color variables (with dark-mode values to match), and check the roles you give \
             them with study_reference's \"check\" pairs before using them. Read layout, spacing, type, corners and \
             shadows from the image yourself. Make the design your own in the reference's spirit; don't copy it.\n\n\
             ## Animations\n\n\
             When a design needs an animation (a loader, a success or error tick, an empty state, an animated logo or \
             icon, a small illustration in motion), make a Lottie animation with the {lottie} skill: load it with the \
             Skill tool and follow its motion and design guidance, using the project's colors. Its own workflow builds a \
             player project and a dev server to preview in; in Scaffold, skip all of that. Write the Lottie JSON, check it \
             is valid, and put it on the canvas with add_elements as a \"lottie\" element with the animation in \"json\" \
             (the canvas shows its \"still\" frame; Play and the exported app play it). Give it \"alt\" if it means \
             something, or \"decorative\": true. Keep animations few and small. If the skill isn't installed, write the \
             animation without it.\n",
            design = DESIGN_SKILL.name,
            logo = LOGO_SKILL.name,
            lottie = LOTTIE_SKILL.name,
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
        let list = |json: &str| plugin_state_in(&serde_json::from_str(json).unwrap(), DESIGN_SKILL.name);
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
        assert!(text.contains("logo-design:logo-design"));
        // Logos are shown on the canvas, not as files in the hidden working folder.
        assert!(text.contains("Logo concepts") && text.contains("never in a folder"));
        assert!(text.contains("study_reference")); // references are measured, not eyeballed
    }

    #[test]
    fn the_logo_skill_is_found_and_optional() {
        let list = |json: &str| plugin_state_in(&serde_json::from_str(json).unwrap(), LOGO_SKILL.name);
        assert_eq!(list(r#"[{"id":"logo-design@logo-design-skill","enabled":true}]"#), PluginState::Enabled);
        assert_eq!(list(r#"[{"id":"ui-ux-pro-max@ui-ux-pro-max-skill","enabled":true}]"#), PluginState::Missing);
        assert!(DESIGN_SKILL.required && !LOGO_SKILL.required && !LOTTIE_SKILL.required);
        // The animation skill isn't a plugin: it's copied from its repository.
        assert!(LOTTIE_SKILL.archive.is_some_and(|(url, folder)| url.starts_with("https://") && folder.ends_with("/text-to-lottie")));
    }

    #[test]
    fn attached_images_are_decoded_and_recognised() {
        // A 1×1 PNG, as the panel sends it (a data: URL).
        let png = base64_decode("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==").unwrap();
        assert_eq!(png.len(), 70);
        assert_eq!(image_kind(&png), Some("png"));
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert!(base64_decode("not*base64").is_none());
        // Encoding round-trips (study_reference reads attachments back).
        for sample in [&b""[..], b"M", b"Ma", b"Man", &png] {
            assert_eq!(base64_decode(&base64_encode(sample)).unwrap(), sample);
        }
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(image_kind(b"%PDF-1.7"), None); // only images Claude can read
        assert_eq!(image_kind(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("webp"));
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
