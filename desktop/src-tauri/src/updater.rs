//! Updating the app from inside it (Settings → App updates).
//!
//! Tauri's updater asks the server for `/downloads/latest.json` — the newest
//! release's version, notes and, per platform, its installer and signature
//! (written by `desktop/release.mjs`). A newer release is downloaded, checked
//! against the public key in tauri.conf.json (so only installers signed with
//! Scaffold's private key are ever installed), and installed; then the app
//! restarts into the new version.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The server the app talks to (set by build.rs, as for the pages).
const API_URL: &str = env!("SCAFFOLD_API_URL");

/// The update found by the last check, kept for `update_install`.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

/// Download progress, sent to the page as `update-progress` events.
#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn endpoint() -> String {
    format!("{API_URL}/downloads/latest.json")
}

/// This app's version.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Ask the server for a newer release. `{ available: false }` when this is the
/// newest; otherwise its version, date and notes.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Value, String> {
    let url = endpoint().parse().map_err(|e| format!("Bad update address: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(explain)?;
    let answer = match &update {
        None => json!({ "available": false }),
        Some(u) => json!({
            "available": true,
            "version": u.version,
            "notes": u.body,
            "date": u.date.map(|d| d.unix_timestamp()),
        }),
    };
    *pending.0.lock().unwrap() = update;
    Ok(answer)
}

/// Download and install the update the last check found, then restart into it.
/// Progress arrives as `update-progress` events.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("Check for updates first.")?;
    let mut downloaded: u64 = 0;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(explain)?;
    // On Windows the installer has already closed the app by now; elsewhere the
    // new version is in place and needs a restart to run.
    app.restart();
}

/// The updater's errors, in words for the Settings page.
fn explain(error: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match error {
        E::Reqwest(_) | E::Network(_) => {
            "Couldn't reach the update server. Check your connection and try again.".into()
        }
        E::Minisign(_) | E::SignatureUtf8(_) | E::Base64(_) => {
            "The update's signature doesn't match, so it wasn't installed.".into()
        }
        E::TargetNotFound(_) | E::TargetsNotFound(_) => {
            "There's no update for this platform yet.".into()
        }
        other => other.to_string(),
    }
}
