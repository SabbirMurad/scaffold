// Assembles the webview bundle in `desktop/dist` before Tauri embeds it:
// the app pages (desktop/src/*.html), the shared `assets/` folder from the
// repo root, and a generated `app-config.js` that points the frontend at the
// API server.
//
// The API server URL comes from `SCAFFOLD_API_URL` at build time; without it,
// debug builds talk to the local dev server and release builds to production.

use std::{collections::hash_map::DefaultHasher, env, fs, hash::Hasher, io, path::Path};

const DEV_API_URL: &str = "http://localhost:8080";
const PROD_API_URL: &str = "https://scaffold.sabbirhassan.com";

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let pages = manifest.join("../src");
    let assets = manifest.join("../../assets");
    let dist = manifest.join("../dist");

    println!("cargo:rerun-if-changed={}", pages.display());
    println!("cargo:rerun-if-changed={}", assets.display());
    println!("cargo:rerun-if-env-changed=SCAFFOLD_API_URL");

    // Empty it, keeping the folder itself (a shell or editor may be sitting in it).
    if dist.exists() {
        for entry in fs::read_dir(&dist).expect("failed to read desktop/dist") {
            let path = entry.expect("failed to read desktop/dist").path();
            if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) }.expect("failed to clear desktop/dist");
        }
    }
    let mut stamp = DefaultHasher::new();
    copy_dir(&pages, &dist, &mut stamp).expect("failed to copy desktop/src");
    copy_dir(&assets, &dist.join("assets"), &mut stamp).expect("failed to copy assets");
    // The pages are embedded when the app compiles, which cargo only redoes when
    // Rust changes — unless an env value it reads changes: this one does
    // whenever a page or asset does.
    println!("cargo:rustc-env=SCAFFOLD_DIST_STAMP={:x}", stamp.finish());

    let api_url = env::var("SCAFFOLD_API_URL").unwrap_or_else(|_| {
        if env::var("PROFILE").as_deref() == Ok("release") { PROD_API_URL } else { DEV_API_URL }.to_string()
    });
    let api_url = api_url.trim_end_matches('/');
    let config = include_str!("app-config.js").replace("__API_URL__", api_url);
    fs::write(dist.join("app-config.js"), config).expect("failed to write app-config.js");
    // The same server for the Rust side: the updater asks it for the latest release.
    println!("cargo:rustc-env=SCAFFOLD_API_URL={api_url}");

    tauri_build::build()
}

fn copy_dir(from: &Path, to: &Path, stamp: &mut DefaultHasher) -> io::Result<()> {
    fs::create_dir_all(to)?;
    let mut entries = fs::read_dir(from)?.collect::<io::Result<Vec<_>>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let target = to.join(entry.file_name());
        stamp.write(entry.file_name().as_encoded_bytes());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target, stamp)?;
        } else {
            let bytes = fs::read(entry.path())?;
            stamp.write(&bytes);
            fs::write(target, bytes)?;
        }
    }
    Ok(())
}
