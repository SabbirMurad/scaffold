// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod bridge;
mod downloads;
mod mcp;
mod oauth;
mod python;
mod tabs;

// Read so the app recompiles (re-embedding the pages) when they change — see build.rs.
const _DIST_STAMP: &str = env!("SCAFFOLD_DIST_STAMP");
mod updater;

use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, Webview, Window, WindowEvent};

// Windows on their way out, so the second close (ours) goes through.
static CLOSING: Mutex<Vec<String>> = Mutex::new(Vec::new());
// Per closing window: how many of its projects are still finishing up.
static WAITING: Mutex<Vec<(String, usize)>> = Mutex::new(Vec::new());

// Closing a window: give each project open in it a moment to finish up (the
// editor uploads its dashboard preview — see thumbnail.js), then close. Each
// project's page calls `close_window` when it's done; the window closes once
// all have — or after a few seconds, whatever a page is doing.
const BEFORE_CLOSE: &str = "(async () => {
  try { if (window.__scaffoldBeforeClose) await window.__scaffoldBeforeClose(); } catch (e) {}
  window.__TAURI_INTERNALS__.invoke('close_window');
})()";

fn close_now(window: &Window) {
    let label = window.label().to_string();
    CLOSING.lock().unwrap().push(label.clone());
    WAITING.lock().unwrap().retain(|(w, _)| *w != label);
    tabs::forget_window(window.app_handle(), &label);
    let _ = window.destroy();
}

#[tauri::command]
fn close_window(webview: Webview) {
    // One of the window's projects is done; the last one closes it.
    let window = webview.window();
    let label = window.label().to_string();
    let last = {
        let mut waiting = WAITING.lock().unwrap();
        match waiting.iter_mut().find(|(w, _)| *w == label) {
            Some((_, left)) => { *left = left.saturating_sub(1); *left == 0 }
            None => false,
        }
    };
    if last {
        close_now(&window);
    }
}

fn main() {
    // `scaffold mcp …` is Scaffold's MCP server, started by Claude Code from the
    // config the app writes (agent.rs). Same binary, no window.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("mcp") {
        std::process::exit(mcp::main(&args[2..]));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let bridge = bridge::start(app.handle().clone())?;
            // This launch's MCP config, for connecting any Claude Code session to
            // the open app: `claude --mcp-config <app data>/claude/mcp.json`. (The
            // Claude panel writes its own per project each turn — agent.rs.)
            if let Ok(dir) = app.path().app_data_dir().map(|d| d.join("claude")) {
                let _ = std::fs::create_dir_all(&dir)
                    .and_then(|_| agent::mcp_config(&dir, bridge.port, &bridge.token, None));
            }
            app.manage(bridge);
            app.manage(agent::Running::default());
            app.manage(updater::Pending::default());
            app.manage(tabs::Tabs::default());
            tabs::open_window(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // The tabs follow the window's size.
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => tabs::layout(window),
            // Tool calls from outside the app go to the window used last.
            WindowEvent::Focused(true) => tabs::focused(window.app_handle(), window.label()),
            WindowEvent::Destroyed => {
                if window.label() == tabs::GHOST { return; }
                tabs::forget_window(window.app_handle(), window.label());
                CLOSING.lock().unwrap().retain(|w| w != window.label());
                // The last window with tabs is gone: quit (the hidden ghost window
                // would otherwise keep the app running with nothing on screen).
                if tabs::tab_window_count(window.app_handle()) == 0 {
                    window.app_handle().exit(0);
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                let label = window.label().to_string();
                if CLOSING.lock().unwrap().contains(&label) { return; }
                let app = window.app_handle();
                let projects = tabs::project_tabs(app, &label);
                if projects.is_empty() { return; } // only the dashboard: nothing to save
                api.prevent_close();
                let mut left = projects.len();
                for tab in &projects {
                    let saving = app.get_webview(tab).map(|v| v.eval(BEFORE_CLOSE).is_ok()).unwrap_or(false);
                    if !saving { left -= 1; }
                }
                let window = window.clone();
                if left == 0 { close_now(&window); return; }
                WAITING.lock().unwrap().push((label, left));
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(4));
                    close_now(&window);
                });
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            close_window,
            tabs::tab_open,
            tabs::tab_activate,
            tabs::tab_cycle,
            tabs::tab_home,
            tabs::tab_title,
            tabs::tab_close,
            tabs::tab_closed,
            tabs::tab_reorder,
            tabs::tab_drop,
            tabs::tab_ghost,
            tabs::tab_ghost_move,
            tabs::tab_ghost_hide,
            tabs::tabs_list,
            tabs::tabs_signed_out,
            tabs::tabs_prune,
            downloads::save_download,
            oauth::social_sign_in,
            oauth::social_sign_in_cancel,
            agent::claude_status,
            agent::claude_ask,
            agent::claude_stop,
            agent::claude_attach,
            agent::claude_read_attachment,
            bridge::tool_reply,
            updater::app_version,
            updater::update_check,
            updater::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Scaffold");
}
