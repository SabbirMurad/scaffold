//! Signing in with Google / GitHub (the RFC 8252 flow for desktop apps).
//!
//! Google refuses to sign in inside an embedded web view, so the sign-in runs in
//! the user's own browser: the app opens the server's `/auth/social` page there,
//! which signs in with Firebase and posts the resulting ID token back to a
//! one-time listener on 127.0.0.1. A random `state` ties that post to this
//! attempt; anything else is turned away. The app then exchanges the token with
//! the server (`/api/v1/auth/social-login`) like any other sign-in.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// How long the app waits for the browser before giving up.
const WAIT: Duration = Duration::from_secs(300);

/// Bumped by every new attempt (and by cancel), so an older one stops waiting.
static ATTEMPT: AtomicU64 = AtomicU64::new(0);

/// Open the provider's sign-in in the browser; resolves to the Firebase ID token.
#[tauri::command]
pub async fn social_sign_in(provider: String, domain: String) -> Result<String, String> {
    let provider = match provider.to_lowercase().as_str() {
        "google" => "google",
        "github" => "github",
        _ => return Err("Unknown sign-in provider".into()),
    };
    let domain = domain.trim_end_matches('/').to_string();
    let local = domain.starts_with("http://localhost") || domain.starts_with("http://127.0.0.1");
    if !(domain.starts_with("https://") || local) {
        return Err("The server address isn't secure".into());
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state = crate::bridge::token();
    let attempt = ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;

    let url = format!("{domain}/auth/social?provider={provider}&port={port}&state={state}");
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;

    tauri::async_runtime::spawn_blocking(move || wait_for_token(listener, &state, attempt))
        .await
        .map_err(|e| e.to_string())?
}

/// Stop waiting for the browser (the user closed the tab, or wants to retry).
#[tauri::command]
pub fn social_sign_in_cancel() {
    ATTEMPT.fetch_add(1, Ordering::SeqCst);
}

fn wait_for_token(listener: TcpListener, state: &str, attempt: u64) -> Result<String, String> {
    let started = Instant::now();
    loop {
        if ATTEMPT.load(Ordering::SeqCst) != attempt {
            return Err("cancelled".into());
        }
        if started.elapsed() > WAIT {
            return Err("Timed out waiting for the browser — try again".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(result) = handle(stream, state) {
                    return result;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// One request to the listener. `Some` ends the wait (a token, or the page's
/// error); `None` means it wasn't the callback (a favicon, a stale tab).
fn handle(mut stream: TcpStream, state: &str) -> Option<Result<String, String>> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;

    // Headers, then a Content-Length body; nothing here is ever large.
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = find(&buf, b"\r\n\r\n") { break i + 4; }
        if buf.len() > 64 * 1024 { return None; }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 { return None; }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let first = head.lines().next().unwrap_or("");
    if !first.starts_with("POST /callback ") {
        respond(&mut stream, "404 Not Found", "Not found");
        return None;
    }
    let length = head
        .lines()
        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
        .unwrap_or(0)
        .min(64 * 1024);
    while buf.len() < head_end + length {
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 { break; }
        buf.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&buf[head_end..(head_end + length).min(buf.len())]).to_string();
    let field = |name: &str| {
        body.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            (k == name).then(|| decode(v))
        })
    };

    if field("state").as_deref() != Some(state) {
        respond(&mut stream, "400 Bad Request", &page("This sign-in link has expired", "Start again from the Scaffold app."));
        return None;
    }
    if let Some(error) = field("error") {
        respond(&mut stream, "200 OK", &page("Sign-in cancelled", "You can close this tab and return to Scaffold."));
        return Some(Err(error));
    }
    match field("token") {
        Some(token) if !token.is_empty() => {
            respond(&mut stream, "200 OK", &page("You’re signed in", "You can close this tab and return to Scaffold."));
            Some(Ok(token))
        }
        _ => {
            respond(&mut stream, "400 Bad Request", &page("Sign-in failed", "Start again from the Scaffold app."));
            None
        }
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// The small page the browser shows after handing the token over.
fn page(title: &str, text: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title} — Scaffold</title>\
         <style>body{{margin:0;height:100vh;display:grid;place-items:center;background:#111215;color:#e8e9ec;\
         font:15px system-ui,-apple-system,'Segoe UI',sans-serif}}div{{text-align:center}}h1{{font-size:20px;font-weight:600;margin:0 0 8px}}\
         p{{color:#9a9da6;margin:0}}</style></head><body><div><h1>{title}</h1><p>{text}</p></div>\
         <script>setTimeout(()=>window.close(),1500)</script></body></html>"
    )
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// application/x-www-form-urlencoded value → text.
fn decode(v: &str) -> String {
    let bytes = v.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => { out.push(b' '); i += 1; }
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(b) => { out.push(b); i += 3; }
                    Err(_) => { out.push(b'%'); i += 1; }
                }
            }
            b => { out.push(b); i += 1; }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(port: u16, request: String) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }
    fn post(port: u16, body: &str) -> String {
        send(port, format!("POST /callback HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{body}", body.len()))
    }

    #[test]
    fn sign_in_callback() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let attempt = ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;
        let browser = std::thread::spawn(move || {
            let favicon = send(port, "GET /favicon.ico HTTP/1.1\r\nHost: x\r\n\r\n".into());
            let stale = post(port, "state=0000&token=stolen");
            let good = post(port, "state=abc123&token=eyJ.part%2Bone%2Ftwo%3D");
            (favicon, stale, good)
        });
        let got = wait_for_token(listener, "abc123", attempt);
        let (favicon, stale, good) = browser.join().unwrap();
        assert_eq!(got, Ok("eyJ.part+one/two=".to_string()));
        assert!(favicon.starts_with("HTTP/1.1 404"));
        assert!(stale.starts_with("HTTP/1.1 400"));
        assert!(good.starts_with("HTTP/1.1 200") && good.contains("signed in"));

        // (One test: attempts share the app-wide counter, as in the app itself.)
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let attempt = ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;
        let browser = std::thread::spawn(move || post(port, "state=s1&error=cancelled"));
        assert_eq!(wait_for_token(listener, "s1", attempt), Err("cancelled".to_string()));
        browser.join().unwrap();

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let attempt = ATTEMPT.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(|| { std::thread::sleep(Duration::from_millis(300)); social_sign_in_cancel(); });
        assert_eq!(wait_for_token(listener, "s2", attempt), Err("cancelled".to_string()));
    }
}
