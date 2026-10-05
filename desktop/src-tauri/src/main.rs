// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod bridge;
mod mcp;
mod oauth;
mod python;
mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Manager, WebviewWindow, WindowEvent};

// Set once the window is on its way out, so the second close (ours) goes through.
static CLOSING: AtomicBool = AtomicBool::new(false);

// Closing the window: give the open page a moment to finish up (the editor
// uploads the project's dashboard preview — see thumbnail.js), then close. The
// page calls `close_window` when it's done; if it never does (a page with
// nothing to do, or one that's stuck), the window closes after a few seconds.
const BEFORE_CLOSE: &str = "(async () => {
  try { if (window.__scaffoldBeforeClose) await window.__scaffoldBeforeClose(); } catch (e) {}
  window.__TAURI_INTERNALS__.invoke('close_window');
})()";

fn close_now(window: &WebviewWindow) {
    CLOSING.store(true, Ordering::SeqCst);
    let _ = window.destroy();
}

#[tauri::command]
fn close_window(window: WebviewWindow) {
    close_now(&window);
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
                    .and_then(|_| agent::mcp_config(&dir, bridge.port, &bridge.token));
            }
            app.manage(bridge);
            app.manage(agent::Running::default());
            app.manage(updater::Pending::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if CLOSING.load(Ordering::SeqCst) { return; }
                let Some(webview) = window.app_handle().get_webview_window(window.label()) else { return };
                api.prevent_close();
                if webview.eval(BEFORE_CLOSE).is_err() { close_now(&webview); return; }
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(4));
                    close_now(&webview);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            close_window,
            oauth::social_sign_in,
            oauth::social_sign_in_cancel,
            agent::claude_status,
            agent::claude_ask,
            agent::claude_stop,
            agent::claude_attach,
            bridge::tool_reply,
            updater::app_version,
            updater::update_check,
            updater::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Scaffold");
}
