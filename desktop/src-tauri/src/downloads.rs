//! Saving a file the page made (an exported frame) to the Downloads folder.
//!
//! The webview's own downloads (`<a download>`) aren't used for this: after the
//! first one, WebView2 quietly blocks further downloads from the same page
//! unless each comes straight from a click, and an export takes a moment to
//! draw first.

use tauri::{ipc::InvokeBody, AppHandle, Manager};

/// The file's bytes are the request body; its name the `x-name` header
/// (URI-encoded). Saved under that name in Downloads — "name (2).png" if taken.
/// Returns where it went.
#[tauri::command]
pub fn save_download(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("No file to save".into()) };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(uri_decode)
        .map(|n| safe_name(&n))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Export".into());
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = free_path(&dir, &name);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// The name, or "stem (2).ext", "stem (3).ext"… — the first not taken.
fn free_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Only a file name: no folders, no characters Windows refuses.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c })
        .collect();
    let name = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    name.chars().take(120).collect::<String>().trim_end().to_string()
}

fn uri_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // Bytes, not a str slice: what follows '%' needn't be ASCII.
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_in_downloads() {
        let name = safe_name("../../etc/passwd");
        assert!(!name.contains('/') && !name.starts_with('.'), "{name}");
        assert!(!safe_name(r"..\..\x.png").contains('\\'));
        assert_eq!(uri_decode("home%20page%40%32x.png"), "home page@2x.png");
        assert_eq!(uri_decode("caf%C3%A9.pdf"), "café.pdf");
        assert_eq!(uri_decode("100%"), "100%");
        assert_eq!(uri_decode("%é.png"), "%é.png");
    }
}
