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

To publish, copy the installers into the server's `downloads/` folder under the
names the landing page links to: `Scaffold-Setup-x64.exe`, `Scaffold.dmg`,
`Scaffold.AppImage`, `Scaffold.deb`. The macOS and Linux installers have to be
built on those platforms.

When running the server with `cargo watch`, add `-i "desktop/*"` so desktop
edits don't restart it.
