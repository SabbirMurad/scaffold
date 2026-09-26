//! The way from Scaffold's MCP server into the open editor.
//!
//! The design lives in the editor's page, not in a file, so a tool call has to
//! be carried out there: that keeps every edit on the undo history and on the
//! collaboration socket, exactly like one made by hand. The MCP server (a
//! separate process Claude Code starts) connects here over loopback, one JSON
//! line per request; this emits the call to the page as a `scaffold-tool` event
//! and waits for the page to answer through `tool_reply`.
//!
//! Loopback only, and every request must carry the token the app wrote into the
//! MCP config — nothing else on the machine can drive the editor.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};

/// How long a tool call may take in the page before the model is told it failed.
const TIMEOUT: Duration = Duration::from_secs(60);
/// How long a permission prompt waits for the person.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Value>>>>;

pub struct Bridge {
    pub port: u16,
    pub token: String,
    pending: Pending,
}

pub fn start(app: AppHandle) -> std::io::Result<Bridge> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let token = token();
    let pending: Pending = Arc::default();

    let (key, waiting) = (token.clone(), pending.clone());
    std::thread::spawn(move || {
        let next = Arc::new(AtomicU64::new(1));
        for stream in listener.incoming().flatten() {
            let (app, key, waiting, next) = (app.clone(), key.clone(), waiting.clone(), next.clone());
            std::thread::spawn(move || {
                let _ = serve(stream, &app, &key, &waiting, &next);
            });
        }
    });

    Ok(Bridge { port, token, pending })
}

/// One connection: request lines in, one answer line out for each.
fn serve(stream: TcpStream, app: &AppHandle, key: &str, pending: &Pending, next: &AtomicU64) -> std::io::Result<()> {
    let mut out = stream.try_clone()?;
    for line in BufReader::new(stream).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(req) if req.get("token").and_then(Value::as_str) == Some(key) => forward(app, pending, next, req),
            Ok(_) => failure("refused: wrong token"),
            Err(e) => failure(&format!("unreadable request: {e}")),
        };
        writeln!(out, "{answer}")?;
        out.flush()?;
    }
    Ok(())
}

/// Hand a request to the page and wait for its answer.
fn forward(app: &AppHandle, pending: &Pending, next: &AtomicU64, mut req: Value) -> Value {
    let id = next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending.lock().unwrap().insert(id, tx);

    if let Some(obj) = req.as_object_mut() {
        obj.remove("token");
        obj.insert("id".into(), json!(id));
    }
    if app.emit("scaffold-tool", &req).is_err() {
        pending.lock().unwrap().remove(&id);
        return failure("the editor window is not available");
    }
    let asking = req.get("method").and_then(Value::as_str) == Some("permission");
    let answer = rx.recv_timeout(if asking { PROMPT_TIMEOUT } else { TIMEOUT });
    pending.lock().unwrap().remove(&id);
    answer.unwrap_or_else(|_| {
        failure("the editor did not answer — is a project open in the editor?")
    })
}

/// The page's answer to a forwarded request.
#[tauri::command]
pub fn tool_reply(bridge: State<'_, Bridge>, id: u64, result: Value) {
    if let Some(tx) = bridge.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(result);
    }
}

pub fn failure(summary: &str) -> Value {
    json!({ "ok": false, "summary": summary })
}

/// A per-launch secret. `RandomState` is seeded from the OS, so two hashes of
/// the clock give 128 unguessable bits without another dependency.
pub(crate) fn token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    (0..2)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(now ^ i);
            h.write_u32(std::process::id());
            format!("{:016x}", h.finish())
        })
        .collect()
}
