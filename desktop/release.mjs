// Build a signed release of the desktop app and publish it for in-app updates.
//
//   node desktop/release.mjs --version 0.2.0 --notes "What's new in this release"
//
// 1. Sets the version in tauri.conf.json and Cargo.toml (skip --version to keep it).
// 2. Builds the installers, signed with the updater key (--skip-build to reuse a build).
// 3. Copies this platform's installer into downloads/ under the name the landing
//    page links to, and writes downloads/latest.json — what the app's
//    "Check for updates" reads (desktop/src-tauri/src/updater.rs).
//
// Then upload downloads/ to the server. Each platform is built on its own OS;
// running this on another OS for the same version adds that platform to
// latest.json (copy the file between machines, or upload after each run).
//
// The private signing key is read from TAURI_SIGNING_PRIVATE_KEY (a path or the
// key itself), or else .keys/scaffold-updater.key in the project (git-ignored).
// Keep it safe and backed up: without it no update can reach apps already installed.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAURI = path.join(HERE, 'src-tauri');
const DOWNLOADS = path.join(HERE, '..', 'downloads');
const BUNDLE = path.join(TAURI, 'target', 'release', 'bundle');
const PROD_URL = 'https://scaffold.sabbirhassan.com';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const fail = (msg) => { console.error('\n✕ ' + msg); process.exit(1); };

// ── version ──────────────────────────────────────────────────────────────────
const confPath = path.join(TAURI, 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
const version = flag('--version') || conf.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Version "${version}" isn't major.minor.patch (e.g. 0.2.0).`);
if (version !== conf.version) {
  conf.version = version;
  fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  const cargoPath = path.join(TAURI, 'Cargo.toml');
  const cargo = fs.readFileSync(cargoPath, 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`);
  fs.writeFileSync(cargoPath, cargo);
  console.log(`Version set to ${version}`);
}

// ── build ────────────────────────────────────────────────────────────────────
if (!has('--skip-build')) {
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY || path.join(HERE, '..', '.keys', 'scaffold-updater.key');
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !fs.existsSync(key)) fail(`No signing key at ${key}. Set TAURI_SIGNING_PRIVATE_KEY.`);
  console.log(`Building Scaffold ${version} (signed)…`);
  execSync('npx --yes @tauri-apps/cli@2 build', {
    cwd: TAURI,
    stdio: 'inherit',
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: key,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '',
    },
  });
}

// ── this platform's installer ────────────────────────────────────────────────
// `update`: what the updater downloads (signed); `extra`: other installers the
// landing page links to. Names are the ones the landing page uses.
const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch] || fail(`Unsupported arch ${process.arch}`);
const find = (dir, test) => {
  const full = path.join(BUNDLE, dir);
  const hit = fs.existsSync(full) && fs.readdirSync(full).find(test);
  return hit ? path.join(full, hit) : null;
};
let target, update, extra = [];
if (process.platform === 'win32') {
  target = `windows-${arch}`;
  update = { from: find('nsis', f => f.includes(`_${version}_`) && f.endsWith('-setup.exe')), as: 'Scaffold-Setup-x64.exe' };
} else if (process.platform === 'darwin') {
  target = `darwin-${arch}`;
  update = { from: find('macos', f => f.endsWith('.app.tar.gz')), as: `Scaffold-${arch}.app.tar.gz` };
  extra = [{ from: find('dmg', f => f.includes(`_${version}_`) && f.endsWith('.dmg')), as: 'Scaffold.dmg' }];
} else {
  target = `linux-${arch}`;
  update = { from: find('appimage', f => f.includes(`_${version}_`) && f.endsWith('.AppImage')), as: 'Scaffold.AppImage' };
  extra = [{ from: find('deb', f => f.includes(`_${version}_`) && f.endsWith('.deb')), as: 'Scaffold.deb' }];
}
if (!update.from) fail(`No ${version} installer found under ${BUNDLE}. Build first (without --skip-build).`);
const sigPath = update.from + '.sig';
if (!fs.existsSync(sigPath)) fail(`${path.basename(update.from)} has no .sig — the build wasn't signed. Is the signing key set?`);

fs.mkdirSync(DOWNLOADS, { recursive: true });
for (const file of [update, ...extra]) {
  if (!file.from) continue;
  fs.copyFileSync(file.from, path.join(DOWNLOADS, file.as));
  console.log(`Copied ${path.basename(file.from)} → downloads/${file.as}`);
}

// ── latest.json ──────────────────────────────────────────────────────────────
// Other platforms' entries are kept only when they're this same version (built
// on their own machines); an older version's entries would announce this
// version with that version's installer.
const baseUrl = (flag('--url') || process.env.SCAFFOLD_API_URL || PROD_URL).replace(/\/$/, '');
const latestPath = path.join(DOWNLOADS, 'latest.json');
let latest = null;
try { latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')); } catch { /* first release */ }
const platforms = latest && latest.version === version ? latest.platforms || {} : {};
if (latest && latest.version !== version && Object.keys(latest.platforms || {}).some(p => p !== target)) {
  console.log(`Note: dropped ${latest.version} entries for other platforms — build ${version} on them too.`);
}
platforms[target] = {
  url: `${baseUrl}/downloads/${update.as}`,
  signature: fs.readFileSync(sigPath, 'utf8').trim(),
};
const next = {
  version,
  notes: flag('--notes') ?? (latest && latest.version === version ? latest.notes : ''),
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(latestPath, JSON.stringify(next, null, 2) + '\n');
console.log(`Wrote downloads/latest.json (${version}: ${Object.keys(platforms).join(', ')})`);
console.log('\nUpload the downloads/ folder to the server to publish the update.');
