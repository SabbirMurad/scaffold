If you already know about the project run the code below to run it

```bash
systemfd --no-pid -s http::8080 -- cargo watch -x run
```

OR

```bash
systemfd --no-pid -s http::8080 -- \
  cargo watch -i ".cargo/*" -i "target/*" -i ".git/*" -i "static/*" -i "logs/*" -x run
```

If you don't know about the project run the code below to read the full documentation

```bash
mkdocs serve
```

## Desktop app (Tauri)

The web server now serves only the landing page and the API. Sign in, the
dashboard and the editor ship as a desktop app in `desktop/`:

- `desktop/src/` — the app pages (`auth.html`, `dashboard.html`, `editor.html`)
- `desktop/src-tauri/` — the Tauri shell. Its `build.rs` copies those pages plus
  the shared `assets/` folder into `desktop/dist/` and writes `app-config.js`,
  which sets the API server URL.

The API URL is taken from `SCAFFOLD_API_URL` at build time. Without it, debug
builds use `http://localhost:8080` (the port `systemfd` serves on) and release builds use the production URL in
`desktop/src-tauri/build.rs`.

```bash
cd desktop/src-tauri
cargo run                                  # dev build against the local server
npx @tauri-apps/cli@2 build                # release installers → target/release/bundle/
```

### Releasing (and in-app updates)

The app updates itself: Settings → App updates checks the server's
`/downloads/latest.json` (also once when the dashboard opens), and installs a newer
release after checking its signature. To publish a release:

```bash
node desktop/release.mjs --version 0.2.0 --notes "What's new in this release"
```

This sets the version, builds signed installers, copies this platform's installer
into `downloads/` under the names the landing page links to
(`Scaffold-Setup-x64.exe`, `Scaffold.dmg`, `Scaffold.AppImage`, `Scaffold.deb`)
and writes `downloads/latest.json`. Then upload `downloads/` to the server. The
macOS and Linux installers have to be built on those platforms: run the script
there with the same version and it adds that platform to `latest.json`.

Updates are signed with the private key at `~/.tauri/scaffold-updater.key` (or
`TAURI_SIGNING_PRIVATE_KEY`); its public half is in `tauri.conf.json`. **Back the
key up somewhere safe** — without it, no update can reach apps already installed.
It must never be committed.

When running the server with `cargo watch`, add `-i "desktop/*"` so desktop
edits don't restart it.
