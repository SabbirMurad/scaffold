// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod bridge;
mod mcp;

use tauri::Manager;

fn main() {
    // `scaffold mcp …` is Scaffold's MCP server, started by Claude Code from the
    // config the app writes (agent.rs). Same binary, no window.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("mcp") {
        std::process::exit(mcp::main(&args[2..]));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let bridge = bridge::start(app.handle().clone())?;
            app.manage(bridge);
            app.manage(agent::Running::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent::claude_status,
            agent::claude_ask,
            agent::claude_stop,
            bridge::tool_reply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Scaffold");
}
