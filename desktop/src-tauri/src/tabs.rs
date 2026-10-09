//! Tabs and windows: several projects open at once, like a browser.
//!
//! Each window holds a thin tab strip (tabs.html, webview "tabbar-<window>")
//! over its tab in front. Each tab is a webview of its own — "home" is the
//! dashboard, "p-<project id>" a project's editor — so every project runs as it
//! did alone in the window: its own page, undo, collaboration socket and Claude
//! panel. Hidden tabs keep running.
//!
//! A tab dragged off its strip pops out into a new window where it's let go;
//! dropped on another window's strip it moves there. Either way its page moves
//! with it as it is (the webview is reparented, never reloaded). A window left
//! with no tabs closes.
//!
//! Pages ask for tab changes through these commands (assets/js/tabs.js); a
//! window's strip is told its list after every change (`tabs` event).
//!
//! The main window's tabs are remembered on this computer (tabs.json in the
//! app's data folder — not the server) and come back next time: the one in
//! front loads at once, the others when first clicked. Other windows' tabs
//! aren't remembered, so nothing reopens as extra windows. A remembered tab
//! whose project is gone (deleted elsewhere, access removed) is closed once the
//! dashboard knows the projects there are (`tabs_prune`).

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::webview::WebviewBuilder;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Rect, State, Webview, WebviewUrl, Window,
};

pub const MAIN: &str = "main";
/// The tab that follows the pointer while it's dragged off its strip.
pub const GHOST: &str = "ghost";
/// Its size (ghost.html): the chip plus room for its shadow.
const GHOST_SIZE: (f64, f64) = (238.0, 40.0);
pub const HOME: &str = "home";
/// The strip's height (tabs.html matches it).
pub const TABBAR_H: f64 = 36.0;
const MIN_SIZE: (f64, f64) = (1024.0, 640.0);

static WINDOWS: AtomicU32 = AtomicU32::new(1);

/// A tab, as the strip draws it.
#[derive(Clone, Serialize)]
pub struct Tab {
    pub label: String,
    pub title: String,
}

#[derive(Default, Clone)]
struct WindowTabs {
    list: Vec<Tab>, // in strip order
    active: String,
}

#[derive(Default)]
pub struct Tabs(Mutex<TabsState>);

#[derive(Default)]
pub struct TabsState {
    windows: HashMap<String, WindowTabs>, // window label → its tabs
    focused: String,                      // the window used last
    /// Tabs on their way out (their page is saving its preview).
    closing: HashMap<String, ()>,
}

impl TabsState {
    /// The window a tab is in.
    fn window_of(&self, tab: &str) -> Option<String> {
        self.windows.iter().find(|(_, w)| w.list.iter().any(|t| t.label == tab)).map(|(k, _)| k.clone())
    }
}

#[derive(Clone, Serialize)]
struct Strip {
    tabs: Vec<Tab>,
    active: String,
}

const fn tabbar_label_prefix() -> &'static str {
    "tabbar-"
}
fn tabbar(window: &str) -> String {
    format!("{}{window}", tabbar_label_prefix())
}
pub fn is_tabbar(label: &str) -> bool {
    label.starts_with(tabbar_label_prefix())
}

/// The tab in front of the window used last — where a tool call goes when it
/// names no tab (a Claude Code session started outside the app).
pub fn active(app: &AppHandle) -> Option<String> {
    let tabs = app.try_state::<Tabs>()?;
    let state = tabs.0.lock().unwrap();
    let win = state.windows.get(&state.focused).or_else(|| state.windows.values().next())?;
    (!win.active.is_empty()).then(|| win.active.clone())
}

/// A window with its strip (and nothing in it yet).
/// `first`: the tab it opens with, recorded before its strip exists — the strip
/// asks for its tabs as soon as it loads, and must not find none.
fn new_window(app: &AppHandle, label: &str, size: (f64, f64), at: Option<PhysicalPosition<i32>>, first: Option<Tab>) -> tauri::Result<Window> {
    // No title bar of Windows': the tab strip is the window's top bar (tabs.html —
    // tabs, a drag area and the window buttons), as in Chrome.
    let mut builder = tauri::window::WindowBuilder::new(app, label)
        .title("Scaffold")
        .decorations(false)
        .shadow(true)
        .inner_size(size.0, size.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .visible(at.is_none()); // a popped-out window shows once it's in place
    if at.is_none() {
        builder = builder.center();
    }
    let window = builder.build()?;
    if let Some(at) = at {
        let _ = window.set_position(at);
        let _ = window.show();
    }
    {
        let tabs = app.state::<Tabs>();
        let mut state = tabs.0.lock().unwrap();
        let active = first.as_ref().map(|t| t.label.clone()).unwrap_or_default();
        state.windows.insert(label.to_string(), WindowTabs { list: first.into_iter().collect(), active });
        state.focused = label.to_string();
    }
    let (w, _) = inner(&window);
    window.add_child(
        WebviewBuilder::new(tabbar(label), WebviewUrl::App("tabs.html".into())).disable_drag_drop_handler(),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(w, TABBAR_H),
    )?;
    keep_resizable(&window);
    Ok(window)
}

/// A frameless window resizes from its edges through a thin border window
/// Tauri lays over it — which webviews added (or moved in) after it would cover.
/// Re-making it puts it back on top, over the tabs.
fn keep_resizable(window: &Window) {
    let _ = window.set_resizable(false);
    let _ = window.set_resizable(true);
}

/// The first window, its strip and the home tab. Called once at startup.
pub fn open_window(app: &AppHandle) -> tauri::Result<()> {
    let home = Tab { label: HOME.into(), title: "Home".into() };
    let window = new_window(app, MAIN, (1440.0, 900.0), None, Some(home))?;
    let (w, h) = inner(&window);
    window.add_child(
        WebviewBuilder::new(HOME, WebviewUrl::App("dashboard.html".into())).disable_drag_drop_handler(),
        LogicalPosition::new(0.0, TABBAR_H),
        LogicalSize::new(w, (h - TABBAR_H).max(0.0)),
    )?;
    // The tabs from last time, after Home; their pages load when first shown.
    let (saved, front) = load_saved(app);
    {
        let tabs = app.state::<Tabs>();
        let mut state = tabs.0.lock().unwrap();
        let win = state.windows.get_mut(MAIN).unwrap();
        for tab in saved {
            if !win.list.iter().any(|t| t.label == tab.label) {
                win.list.push(tab);
            }
        }
        if let Some(front) = front.filter(|f| win.list.iter().any(|t| &t.label == f)) {
            win.active = front;
        }
    }
    // The one in front loads now (startup isn't a command: making it here is safe).
    let active = app.state::<Tabs>().0.lock().unwrap().windows.get(MAIN).map(|w| w.active.clone()).unwrap_or_default();
    ensure_page(app, MAIN, &active);
    show_active(app, MAIN, true);
    keep_resizable(&window);
    Ok(())
}

// ── remembering the main window's tabs ──────────────────────────────────────
#[derive(Serialize, serde::Deserialize, Default)]
struct Saved {
    tabs: Vec<SavedTab>,
    active: Option<String>, // a project id, or none for Home
}
#[derive(Serialize, serde::Deserialize)]
struct SavedTab {
    project: String,
    title: String,
}

fn saved_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("tabs.json"))
}

/// The main window's project tabs as they are now, written down.
fn save_main(app: &AppHandle) {
    let saved = {
        let tabs = app.state::<Tabs>();
        let state = tabs.0.lock().unwrap();
        let Some(win) = state.windows.get(MAIN) else { return };
        Saved {
            tabs: win.list.iter().filter_map(|t| {
                t.label.strip_prefix("p-").map(|id| SavedTab { project: id.to_string(), title: t.title.clone() })
            }).collect(),
            active: win.active.strip_prefix("p-").map(String::from),
        }
    };
    if let (Some(path), Ok(json)) = (saved_path(app), serde_json::to_string_pretty(&saved)) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, json);
    }
}

/// The remembered tabs (none if there's no file or it's unreadable) and the
/// label of the one that was in front.
fn load_saved(app: &AppHandle) -> (Vec<Tab>, Option<String>) {
    let saved: Saved = saved_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let tabs = saved
        .tabs
        .into_iter()
        .map(|t| (project_label(&t.project), t.title))
        .filter(|(label, _)| label != "p-")
        .map(|(label, title)| Tab { label, title: title.chars().take(80).collect() })
        .collect();
    (tabs, saved.active.map(|id| project_label(&id)))
}

/// Make a tab's page if it doesn't have one yet (a remembered tab, first shown).
/// Never from a synchronous command — see tab_open.
fn ensure_page(app: &AppHandle, window_label: &str, tab: &str) {
    if tab.is_empty() || tab == HOME || app.get_webview(tab).is_some() {
        return;
    }
    let (Some(project), Some(window)) = (tab.strip_prefix("p-"), app.get_window(window_label)) else { return };
    let (w, h) = inner(&window);
    let url = format!("editor.html?id={}", urlencode(project));
    let made = window.add_child(
        WebviewBuilder::new(tab, WebviewUrl::App(url.into())).disable_drag_drop_handler(),
        LogicalPosition::new(0.0, TABBAR_H),
        LogicalSize::new(w, (h - TABBAR_H).max(0.0)),
    );
    if made.is_ok() {
        keep_resizable(&window);
    }
}

/// The window's inner size, in logical pixels.
fn inner(window: &Window) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .inner_size()
        .map(|s| {
            let l = s.to_logical::<f64>(scale);
            (l.width, l.height)
        })
        .unwrap_or((1440.0, 900.0))
}

/// Lay a window's strip and tabs out to its size (after a resize).
///
/// Size and position go together (set_bounds): set_size / set_position each
/// read the webview's current bounds first, and for a webview moved here from
/// another window (reparent) wry still measures its position against the old
/// window — so the tab ends up shifted by the difference between the windows.
pub fn layout(window: &Window) {
    let (w, h) = inner(window);
    for webview in window.webviews() {
        let (y, height) = if is_tabbar(webview.label()) { (0.0, TABBAR_H) } else { (TABBAR_H, (h - TABBAR_H).max(0.0)) };
        let _ = webview.set_bounds(Rect {
            position: LogicalPosition::new(0.0, y).into(),
            size: LogicalSize::new(w, height).into(),
        });
    }
}

/// Where a window dragged out to screen point (x, y) goes: its top-left a bit
/// up and left of the pointer (which ends up over its tab strip), kept inside
/// that monitor's work area. Physical pixels; `size` is the window's logical size.
fn place_on_screen(app: &AppHandle, x: f64, y: f64, size: (f64, f64)) -> (PhysicalPosition<i32>, (f64, f64)) {
    let monitor = app.monitor_from_point(x, y).ok().flatten().or_else(|| app.primary_monitor().ok().flatten());
    let Some(m) = monitor else {
        return (PhysicalPosition::new((x - 120.0) as i32, (y - 18.0) as i32), size);
    };
    let scale = m.scale_factor();
    let area = m.work_area();
    // At most 90% of the screen, so it's clearly a window of its own.
    let max_w = area.size.width as f64 / scale * 0.9;
    let max_h = area.size.height as f64 / scale * 0.9;
    let (w, h) = (size.0.min(max_w).max(MIN_SIZE.0.min(max_w)), size.1.min(max_h).max(MIN_SIZE.1.min(max_h)));
    // Its outer frame (title bar and borders) is a little bigger than its inner size.
    let (pw, ph) = ((w + 16.0) * scale, (h + 40.0) * scale);
    let (left, top) = (area.position.x as f64, area.position.y as f64);
    let (right, bottom) = (left + area.size.width as f64, top + area.size.height as f64);
    let px = (x - 120.0 * scale).max(left).min((right - pw).max(left));
    let py = (y - 18.0 * scale).max(top).min((bottom - ph).max(top));
    (PhysicalPosition::new(px as i32, py as i32), (w, h))
}

/// Show a window's tab in front (the others are hidden, not closed). `focus`
/// also gives it the keyboard — which brings its whole window to the front, so
/// it's left off when relaying out a window the person isn't turning to (the
/// one a tab was just dragged out of).
fn show_active(app: &AppHandle, window_label: &str, focus: bool) {
    let active = {
        let tabs = app.state::<Tabs>();
        let state = tabs.0.lock().unwrap();
        match state.windows.get(window_label) {
            Some(w) => w.active.clone(),
            None => return,
        }
    };
    ensure_page(app, window_label, &active);
    if let Some(window) = app.get_window(window_label) {
        layout(&window);
        for webview in window.webviews() {
            let l = webview.label();
            if is_tabbar(l) {
                continue;
            }
            let _ = if l == active { webview.show() } else { webview.hide() };
        }
    }
    if focus {
        if let Some(webview) = app.get_webview(&active) {
            let _ = webview.set_focus();
        }
    }
    tell_strip(app, window_label);
}

/// Bring a tab to the front of its window.
fn activate(app: &AppHandle, tab: &str) {
    let window = {
        let tabs = app.state::<Tabs>();
        let mut state = tabs.0.lock().unwrap();
        let Some(window) = state.window_of(tab) else { return };
        state.windows.get_mut(&window).unwrap().active = tab.to_string();
        window
    };
    show_active(app, &window, true);
}

fn tell_strip(app: &AppHandle, window_label: &str) {
    let (strip, title) = {
        let tabs = app.state::<Tabs>();
        let state = tabs.0.lock().unwrap();
        let Some(win) = state.windows.get(window_label) else { return };
        let front = win.list.iter().find(|t| t.label == win.active).cloned();
        let title = match front {
            Some(t) if t.label != HOME => format!("{} — Scaffold", t.title),
            _ => "Scaffold".to_string(),
        };
        (Strip { tabs: win.list.clone(), active: win.active.clone() }, title)
    };
    let _ = app.emit_to(tabbar(window_label).as_str(), "tabs", strip);
    if let Some(window) = app.get_window(window_label) {
        let _ = window.set_title(&title);
    }
    if window_label == MAIN {
        save_main(app);
    }
}

/// A project's tab label: its id, reduced to the characters a label allows.
fn project_label(project: &str) -> String {
    let id: String = project.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    format!("p-{id}")
}

/// The window the asking page is in (for opening a tab beside it).
fn window_of_page(webview: &Webview) -> String {
    let label = webview.window().label().to_string();
    label
}

/// Open a project in a tab of the asking page's window — or bring its tab to
/// the front, in whichever window it's in.
///
/// `async`: off the main thread. On Windows, making a webview inside a
/// synchronous command deadlocks — the command runs inside WebView2's own
/// message callback, which the new webview's creation waits on.
#[tauri::command(async)]
pub fn tab_open(app: AppHandle, webview: Webview, tabs: State<'_, Tabs>, project: String, title: Option<String>) -> Result<(), String> {
    let label = project_label(&project);
    if label == "p-" {
        return Err("No project id".into());
    }
    let open_in = tabs.0.lock().unwrap().window_of(&label);
    if let Some(window) = open_in {
        activate(&app, &label);
        if let Some(w) = app.get_window(&window) {
            let _ = w.set_focus();
        }
        return Ok(());
    }
    let window_label = window_of_page(&webview);
    let window = app.get_window(&window_label).ok_or("The Scaffold window is gone")?;
    let (w, h) = inner(&window);
    let url = format!("editor.html?id={}", urlencode(&project));
    window
        .add_child(
            WebviewBuilder::new(&label, WebviewUrl::App(url.into())).disable_drag_drop_handler(),
            LogicalPosition::new(0.0, TABBAR_H),
            LogicalSize::new(w, (h - TABBAR_H).max(0.0)),
        )
        .map_err(|e| e.to_string())?;
    keep_resizable(&window);
    {
        let mut state = tabs.0.lock().unwrap();
        let win = state.windows.entry(window_label.clone()).or_default();
        win.list.push(Tab { label: label.clone(), title: title.unwrap_or_else(|| "Project".into()) });
    }
    activate(&app, &label);
    Ok(())
}

/// Bring a tab to the front (the strip). `async`: it may make the tab's page.
#[tauri::command(async)]
pub fn tab_activate(app: AppHandle, label: String) {
    activate(&app, &label);
}

/// The next / previous tab of the asking page's window (Ctrl+Tab, Ctrl+Shift+Tab).
/// `async`: it may make the tab's page.
#[tauri::command(async)]
pub fn tab_cycle(app: AppHandle, webview: Webview, tabs: State<'_, Tabs>, back: bool) {
    let window = window_of_page(&webview);
    let next = {
        let state = tabs.0.lock().unwrap();
        let Some(win) = state.windows.get(&window) else { return };
        let n = win.list.len();
        if n == 0 {
            return;
        }
        let i = win.list.iter().position(|t| t.label == win.active).unwrap_or(0);
        win.list[if back { (i + n - 1) % n } else { (i + 1) % n }].label.clone()
    };
    activate(&app, &next);
}

/// The dashboard tab (wherever it is), its window in front.
#[tauri::command]
pub fn tab_home(app: AppHandle, tabs: State<'_, Tabs>) {
    let window = tabs.0.lock().unwrap().window_of(HOME);
    activate(&app, HOME);
    if let Some(w) = window.and_then(|w| app.get_window(&w)) {
        let _ = w.set_focus();
    }
}

/// A page names its tab (the project's name, once it has loaded) — or the strip
/// names one of its project tabs (`label`: renamed there by double-clicking).
#[tauri::command]
pub fn tab_title(app: AppHandle, webview: Webview, tabs: State<'_, Tabs>, title: String, label: Option<String>) {
    let label = match label {
        Some(l) if is_tabbar(webview.label()) && l.starts_with("p-") => l,
        _ => webview.label().to_string(),
    };
    let window = {
        let mut state = tabs.0.lock().unwrap();
        let Some(window) = state.window_of(&label) else { return };
        let win = state.windows.get_mut(&window).unwrap();
        if let Some(tab) = win.list.iter_mut().find(|t| t.label == label) {
            tab.title = title.chars().take(80).collect();
        }
        window
    };
    tell_strip(&app, &window);
}

/// Put a window's tabs in a new order (dragged along its own strip).
#[tauri::command]
pub fn tab_reorder(app: AppHandle, webview: Webview, tabs: State<'_, Tabs>, order: Vec<String>) {
    let window = window_of_page(&webview);
    {
        let mut state = tabs.0.lock().unwrap();
        let Some(win) = state.windows.get_mut(&window) else { return };
        // Only a reordering of what's there: anything else is ignored.
        let mut sorted: Vec<&String> = order.iter().collect();
        sorted.sort();
        let mut have: Vec<&String> = win.list.iter().map(|t| &t.label).collect();
        have.sort();
        if sorted != have {
            return;
        }
        let by_label: HashMap<String, Tab> = win.list.drain(..).map(|t| (t.label.clone(), t)).collect();
        win.list = order.iter().filter_map(|l| by_label.get(l).cloned()).collect();
    }
    tell_strip(&app, &window);
}

/// A tab let go after a drag off its strip, at screen point (x, y) in physical
/// pixels: onto another window's strip → it moves there; anywhere else → it
/// pops out into a new window there (or, the window's only tab, the window
/// moves there). The window it leaves closes if that was its last tab.
/// `async` for the same reason as tab_open (it can make a window).
#[tauri::command(async)]
pub fn tab_drop(app: AppHandle, tabs: State<'_, Tabs>, label: String, x: f64, y: f64) -> Result<(), String> {
    let from = tabs.0.lock().unwrap().window_of(&label).ok_or("No such tab")?;
    let alone = tabs.0.lock().unwrap().windows.get(&from).map(|w| w.list.len() == 1).unwrap_or(false);

    // Over a window's strip?
    let windows: Vec<String> = tabs.0.lock().unwrap().windows.keys().cloned().collect();
    let target = app.windows().into_iter().filter(|(name, _)| windows.contains(name)).find_map(|(name, window)| {
        let pos = window.inner_position().ok()?;
        let size = window.inner_size().ok()?;
        let scale = window.scale_factor().ok()?;
        let strip_h = TABBAR_H * scale;
        let inside = x >= pos.x as f64 && x < pos.x as f64 + size.width as f64 && y >= pos.y as f64 && y < pos.y as f64 + strip_h;
        inside.then_some(name)
    });

    match target {
        Some(to) if to == from => Ok(()), // back on its own strip: the strip reorders it
        Some(to) => move_tab(&app, &label, &from, &to),
        None if alone => {
            // The window's only tab: the window goes where the tab was dropped
            // (kept on that screen).
            if let Some(window) = app.get_window(&from) {
                let (at, _) = place_on_screen(&app, x, y, inner(&window));
                let _ = window.set_position(at);
                let _ = window.set_focus();
            }
            Ok(())
        }
        None => {
            // A new window, sized for the screen it's dropped on.
            let (at, size) = place_on_screen(&app, x, y, (1280.0, 800.0));
            let name = format!("w{}", WINDOWS.fetch_add(1, Ordering::Relaxed));
            new_window(&app, &name, size, Some(at), None).map_err(|e| e.to_string())?;
            move_tab(&app, &label, &from, &name)
        }
    }
}

// ── the dragged tab ──────────────────────────────────────────────────────────
// A strip can't draw outside itself (it's a 36px webview), so a tab dragged off
// it is drawn by a small see-through window that follows the pointer: always on
// top, off the taskbar, never focused, never taking a click.

/// Show the ghost of tab `title` at screen point (x, y), physical pixels.
/// `async` because the first call makes its window (see tab_open).
#[tauri::command(async)]
pub fn tab_ghost(app: AppHandle, title: String, x: f64, y: f64) -> Result<(), String> {
    let ghost = match app.get_webview_window(GHOST) {
        Some(g) => g,
        // The title in the URL too: the first time, the page isn't there yet to be told.
        None => tauri::WebviewWindowBuilder::new(&app, GHOST, WebviewUrl::App(format!("ghost.html?title={}", urlencode(&title)).into()))
            .title("")
            .inner_size(GHOST_SIZE.0, GHOST_SIZE.1)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?,
    };
    let _ = ghost.set_ignore_cursor_events(true);
    let title = serde_json::to_string(&title).unwrap_or_else(|_| "\"Tab\"".into());
    let _ = ghost.eval(&format!("window.__setTab && window.__setTab({title})"));
    place_ghost(&ghost, x, y);
    let _ = ghost.show();
    // Its page fills it: made hidden, frameless and see-through, the window's
    // webview is left 4px tall (only a line shows) — so it's sized here.
    if let Some(page) = app.get_webview(GHOST) {
        let _ = page.set_bounds(Rect {
            position: LogicalPosition::new(0.0, 0.0).into(),
            size: LogicalSize::new(GHOST_SIZE.0, GHOST_SIZE.1).into(),
        });
    }
    Ok(())
}

/// The ghost follows the pointer.
#[tauri::command]
pub fn tab_ghost_move(app: AppHandle, x: f64, y: f64) {
    if let Some(ghost) = app.get_webview_window(GHOST) {
        place_ghost(&ghost, x, y);
    }
}

/// The drag is over (dropped, cancelled, or back on the strip).
#[tauri::command]
pub fn tab_ghost_hide(app: AppHandle) {
    if let Some(ghost) = app.get_webview_window(GHOST) {
        let _ = ghost.hide();
    }
}

/// The ghost's top-left a little up and left of the pointer, as if held by its tab.
fn place_ghost(ghost: &tauri::WebviewWindow, x: f64, y: f64) {
    let scale = ghost.scale_factor().unwrap_or(1.0);
    let _ = ghost.set_position(PhysicalPosition::new((x - 40.0 * scale) as i32, (y - 20.0 * scale) as i32));
}

/// How many windows hold tabs (the ghost doesn't count).
pub fn tab_window_count(app: &AppHandle) -> usize {
    app.try_state::<Tabs>().map(|t| t.0.lock().unwrap().windows.len()).unwrap_or(0)
}

/// Move a tab, its page as it is, from one window to another. The window it
/// leaves shows its next tab, or closes if it has none left.
fn move_tab(app: &AppHandle, label: &str, from: &str, to: &str) -> Result<(), String> {
    let target = app.get_window(to).ok_or("No such window")?;
    // A remembered tab never shown has no page yet: it's made in its new window.
    if let Some(webview) = app.get_webview(label) {
        webview.reparent(&target).map_err(|e| e.to_string())?;
        keep_resizable(&target);
    }
    let emptied = {
        let tabs = app.state::<Tabs>();
        let mut state = tabs.0.lock().unwrap();
        let src = state.windows.get_mut(from).ok_or("No such window")?;
        let i = src.list.iter().position(|t| t.label == label).ok_or("No such tab")?;
        let tab = src.list.remove(i);
        if src.active == label {
            src.active = src.list.get(i.min(src.list.len().saturating_sub(1))).map(|t| t.label.clone()).unwrap_or_default();
        }
        let emptied = src.list.is_empty();
        let dst = state.windows.entry(to.to_string()).or_default();
        dst.list.push(tab);
        dst.active = label.to_string();
        state.focused = to.to_string();
        emptied
    };
    // The window it left first — without taking focus — then the one it went
    // to, last, so that's the window in front: it stays there until the
    // person clicks another.
    if emptied {
        // Nothing left in it: the window goes.
        app.state::<Tabs>().0.lock().unwrap().windows.remove(from);
        if let Some(window) = app.get_window(from) {
            let _ = window.destroy();
        }
    } else {
        show_active(app, from, false);
    }
    show_active(app, to, true);
    let _ = target.set_focus();
    Ok(())
}

/// Close a tab — `label`, or the asking page's own. The page first gets to save
/// what it's in the middle of (the editor uploads its dashboard preview), then
/// answers with `tab_closed`; if it never does, the tab closes after a moment.
/// `async`: closing it may show (and so make) its neighbour's page.
#[tauri::command(async)]
pub fn tab_close(app: AppHandle, webview: Webview, tabs: State<'_, Tabs>, label: Option<String>) {
    let label = label.unwrap_or_else(|| webview.label().to_string());
    if label == HOME || is_tabbar(&label) {
        return;
    }
    tabs.0.lock().unwrap().closing.insert(label.clone(), ());
    // A remembered tab never shown has no page: nothing to save first.
    let Some(page) = app.get_webview(&label) else {
        finish_close(&app, &label);
        return;
    };
    // Claude working in it stops (its edits so far stay, saved).
    crate::agent::stop_turn(&app, &app.state::<crate::agent::Running>(), &label);
    let script = "(async () => {
      try { if (window.__scaffoldBeforeClose) await window.__scaffoldBeforeClose(); } catch (e) {}
      window.__TAURI_INTERNALS__.invoke('tab_closed');
    })()";
    if page.eval(script).is_err() {
        finish_close(&app, &label);
        return;
    }
    let (app2, label2) = (app.clone(), label);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4));
        finish_close(&app2, &label2);
    });
}

/// The closing page is done: close its tab. `async` as tab_close.
#[tauri::command(async)]
pub fn tab_closed(app: AppHandle, webview: Webview) {
    finish_close(&app, webview.label());
}

fn finish_close(app: &AppHandle, label: &str) {
    let (window, emptied) = {
        let tabs = app.state::<Tabs>();
        let mut state = tabs.0.lock().unwrap();
        if state.closing.remove(label).is_none() {
            return; // already closed (the page answered before the timer)
        }
        let Some(window) = state.window_of(label) else { return };
        let win = state.windows.get_mut(&window).unwrap();
        let i = win.list.iter().position(|t| t.label == label).unwrap();
        win.list.remove(i);
        // Closing the tab in front shows its neighbour, as a browser does.
        if win.active == label {
            win.active = win.list.get(i.min(win.list.len().saturating_sub(1))).map(|t| t.label.clone()).unwrap_or_default();
        }
        (window, win.list.is_empty())
    };
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.close();
    }
    if emptied {
        // Its last tab closed: so does the window.
        app.state::<Tabs>().0.lock().unwrap().windows.remove(&window);
        if let Some(w) = app.get_window(&window) {
            let _ = w.destroy();
        }
    } else {
        show_active(app, &window, true);
    }
}

/// A strip's first look (it loads after its window's tabs exist).
#[tauri::command]
pub fn tabs_list(webview: Webview, tabs: State<'_, Tabs>) -> serde_json::Value {
    let window = window_of_page(&webview);
    let state = tabs.0.lock().unwrap();
    let win = state.windows.get(&window).cloned().unwrap_or_default();
    serde_json::json!({ "tabs": win.list, "active": win.active })
}

/// Signed out (or the session ended): every project tab closes, the other
/// windows with them, and the home tab shows the sign-in page.
#[tauri::command]
pub fn tabs_signed_out(app: AppHandle, tabs: State<'_, Tabs>) {
    let (projects, home_window, other_windows) = {
        let mut state = tabs.0.lock().unwrap();
        let home_window = state.window_of(HOME).unwrap_or_else(|| MAIN.to_string());
        let projects: Vec<String> = state.windows.values().flat_map(|w| w.list.iter()).filter(|t| t.label != HOME).map(|t| t.label.clone()).collect();
        let others: Vec<String> = state.windows.keys().filter(|k| **k != home_window).cloned().collect();
        state.windows.retain(|k, _| *k == home_window);
        if let Some(win) = state.windows.get_mut(&home_window) {
            win.list.retain(|t| t.label == HOME);
            win.active = HOME.into();
        }
        (projects, home_window, others)
    };
    let running = app.state::<crate::agent::Running>();
    for label in projects {
        crate::agent::stop_turn(&app, &running, &label);
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }
    for window in other_windows {
        if let Some(w) = app.get_window(&window) {
            let _ = w.destroy();
        }
    }
    if let Some(home) = app.get_webview(HOME) {
        let _ = home.eval("window.location.href = '/auth.html';");
    }
    show_active(&app, &home_window, true);
}

/// The dashboard has the person's projects: close any tab whose project isn't
/// among them (deleted on another computer, access removed) — in every window.
/// Returns how many closed.
#[tauri::command(async)]
pub fn tabs_prune(app: AppHandle, tabs: State<'_, Tabs>, projects: Vec<String>) -> usize {
    let known: std::collections::HashSet<String> = projects.iter().map(|p| project_label(p)).collect();
    let gone: Vec<(String, String)> = {
        let state = tabs.0.lock().unwrap();
        state
            .windows
            .iter()
            .flat_map(|(w, win)| win.list.iter().map(move |t| (w.clone(), t.label.clone())))
            .filter(|(_, label)| label.starts_with("p-") && !known.contains(label))
            .collect()
    };
    let running = app.state::<crate::agent::Running>();
    let mut touched: Vec<String> = Vec::new();
    for (window, label) in &gone {
        crate::agent::stop_turn(&app, &running, label);
        if let Some(page) = app.get_webview(label) {
            let _ = page.close();
        }
        let mut state = tabs.0.lock().unwrap();
        if let Some(win) = state.windows.get_mut(window) {
            if let Some(i) = win.list.iter().position(|t| &t.label == label) {
                win.list.remove(i);
                if &win.active == label {
                    win.active = win.list.get(i.min(win.list.len().saturating_sub(1))).map(|t| t.label.clone()).unwrap_or_default();
                }
            }
        }
        if !touched.contains(window) {
            touched.push(window.clone());
        }
    }
    for window in touched {
        let empty = tabs.0.lock().unwrap().windows.get(&window).map(|w| w.list.is_empty()).unwrap_or(true);
        if empty && window != MAIN {
            tabs.0.lock().unwrap().windows.remove(&window);
            if let Some(w) = app.get_window(&window) {
                let _ = w.destroy();
            }
        } else {
            show_active(&app, &window, false);
        }
    }
    gone.len()
}

/// The project tabs open in a window (for that window closing: each saves first).
pub fn project_tabs(app: &AppHandle, window: &str) -> Vec<String> {
    let tabs = app.state::<Tabs>();
    let state = tabs.0.lock().unwrap();
    state.windows.get(window).map(|w| w.list.iter().filter(|t| t.label != HOME).map(|t| t.label.clone()).collect()).unwrap_or_default()
}

/// A window was used: tool calls from outside the app go to its tab in front.
pub fn focused(app: &AppHandle, window: &str) {
    if let Some(tabs) = app.try_state::<Tabs>() {
        let mut state = tabs.0.lock().unwrap();
        if state.windows.contains_key(window) {
            state.focused = window.to_string();
        }
    }
}

/// A window is gone: forget its tabs.
pub fn forget_window(app: &AppHandle, window: &str) {
    if let Some(tabs) = app.try_state::<Tabs>() {
        tabs.0.lock().unwrap().windows.remove(window);
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_labels_are_safe() {
        assert_eq!(project_label("0193a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b"), "p-0193a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b");
        assert_eq!(project_label("../x y"), "p-xy");
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
        assert!(is_tabbar(&tabbar("w3")) && !is_tabbar("p-1"));
    }
}
