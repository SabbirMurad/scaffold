// Assembles the webview bundle in `desktop/dist` before Tauri embeds it:
// the app pages (desktop/src/*.html), the shared `assets/` folder from the
// repo root, and a generated `app-config.js` that points the frontend at the
// API server.
//
// The API server URL comes from `SCAFFOLD_API_URL` at build time; without it,
// debug builds talk to the local dev server and release builds to production.

use std::{env, fs, io, path::Path};

const DEV_API_URL: &str = "http://localhost:8080";
const PROD_API_URL: &str = "https://sabbirhassan.com:444";

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let pages = manifest.join("../src");
    let assets = manifest.join("../../assets");
    let dist = manifest.join("../dist");

    println!("cargo:rerun-if-changed={}", pages.display());
    println!("cargo:rerun-if-changed={}", assets.display());
    println!("cargo:rerun-if-env-changed=SCAFFOLD_API_URL");

    if dist.exists() {
        fs::remove_dir_all(&dist).expect("failed to clear desktop/dist");
    }
    copy_dir(&pages, &dist).expect("failed to copy desktop/src");
    copy_dir(&assets, &dist.join("assets")).expect("failed to copy assets");

    let api_url = env::var("SCAFFOLD_API_URL").unwrap_or_else(|_| {
        if env::var("PROFILE").as_deref() == Ok("release") { PROD_API_URL } else { DEV_API_URL }.to_string()
    });
    let config = include_str!("app-config.js").replace("__API_URL__", api_url.trim_end_matches('/'));
    fs::write(dist.join("app-config.js"), config).expect("failed to write app-config.js");

    tauri_build::build()
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
