// Build a signed release of the desktop app and publish it for in-app updates.
//
//   node desktop/release.mjs --version 0.2.0 --notes "What's new in this release"
//
// 1. Sets the version in tauri.conf.json and Cargo.toml (skip --version to keep it).
// 2. Builds the installers, signed with the updater key (--skip-build to reuse a build).
// 3. Copies this platform's installers into downloads/ under the names the landing
//    page links to (plus versioned copies, which never change once published),
//    and writes downloads/latest.json — what the app's "Check for updates" reads
//    (desktop/src-tauri/src/updater.rs).
// 4. On Windows, writes the winget manifest for this version under winget/,
//    ready to submit to microsoft/winget-pkgs (see winget/README.md).
//
// Then upload downloads/ to the server. Each platform is built on its own OS;
// running this on another OS for the same version adds that platform to
// latest.json (copy the file between machines, or upload after each run).
//
// The private signing key is read from TAURI_SIGNING_PRIVATE_KEY (a path or the
// key itself), or else .keys/scaffold-updater.key in the project (git-ignored).
// Keep it safe and backed up: without it no update can reach apps already installed.

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
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
  update = { from: find('nsis', f => f.includes(`_${version}_`) && f.endsWith('-setup.exe')), as: 'Scaffold-Setup-x64.exe', installer: 'nsis' };
  extra = [{ from: find('msi', f => f.includes(`_${version}_`) && f.endsWith('.msi')), as: 'Scaffold-Setup-x64.msi', installer: 'msi' }];
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

// Each installer goes out twice: under the fixed name the landing page links to
// (replaced every release), and under a versioned name that never changes once
// published — what updates and winget point at, so the file always matches the
// signature / hash recorded for it.
const versioned = (file) => {
  const base = path.basename(file.from);
  return base.includes(version) ? base : `Scaffold_${version}_${file.as}`;
};
fs.mkdirSync(DOWNLOADS, { recursive: true });
for (const file of [update, ...extra]) {
  if (!file.from) continue;
  fs.copyFileSync(file.from, path.join(DOWNLOADS, file.as));
  fs.copyFileSync(file.from, path.join(DOWNLOADS, versioned(file)));
  console.log(`Copied ${path.basename(file.from)} → downloads/${file.as} and downloads/${versioned(file)}`);
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
if (latest && latest.version !== version && Object.keys(latest.platforms || {}).some(p => !p.startsWith(target))) {
  console.log(`Note: dropped ${latest.version} entries for other platforms — build ${version} on them too.`);
}
const entry = (file) => ({
  url: `${baseUrl}/downloads/${versioned(file)}`,
  signature: fs.readFileSync(file.from + '.sig', 'utf8').trim(),
});
platforms[target] = entry(update);
// On Windows each installer type updates with its own kind: the updater looks for
// "<target>-<installer>" first (the build stamps which one it came from), so an
// .msi install gets the .msi and an .exe install the .exe — never both side by side.
for (const file of [update, ...extra]) {
  if (!file.installer || !file.from) continue;
  if (!fs.existsSync(file.from + '.sig')) fail(`${path.basename(file.from)} has no .sig — the build wasn't signed.`);
  platforms[`${target}-${file.installer}`] = entry(file);
}
const next = {
  version,
  notes: flag('--notes') ?? (latest && latest.version === version ? latest.notes : ''),
  pub_date: new Date().toISOString(),
  platforms,
};
fs.writeFileSync(latestPath, JSON.stringify(next, null, 2) + '\n');
console.log(`Wrote downloads/latest.json (${version}: ${Object.keys(platforms).join(', ')})`);

// ── winget manifest ──────────────────────────────────────────────────────────
// Windows only: the three files winget-pkgs wants for this version, pointing at
// the versioned .exe (winget checks its SHA-256, so that file must never change).
if (process.platform === 'win32') {
  const ID = 'SabbirHassan.Scaffold';
  const SCHEMA = '1.9.0';
  const dir = path.join(HERE, '..', 'winget', 'manifests', 's', 'SabbirHassan', 'Scaffold', version);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(update.from)).digest('hex').toUpperCase();
  const schema = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${SCHEMA}.schema.json`;
  const lines = (...l) => l.join('\n') + '\n';
  const notes = (next.notes || '').replace(/"/g, "'");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ID}.yaml`), lines(
    schema('version'),
    `PackageIdentifier: ${ID}`, `PackageVersion: ${version}`, 'DefaultLocale: en-US',
    'ManifestType: version', `ManifestVersion: ${SCHEMA}`));
  fs.writeFileSync(path.join(dir, `${ID}.installer.yaml`), lines(
    schema('installer'),
    `PackageIdentifier: ${ID}`, `PackageVersion: ${version}`,
    'InstallerType: nullsoft', 'Scope: user',
    'InstallModes:', '- interactive', '- silent', '- silentWithProgress',
    'UpgradeBehavior: install', `ReleaseDate: ${next.pub_date.slice(0, 10)}`,
    'Installers:', '- Architecture: x64',
    `  InstallerUrl: ${baseUrl}/downloads/${versioned(update)}`,
    `  InstallerSha256: ${sha256}`,
    'ManifestType: installer', `ManifestVersion: ${SCHEMA}`));
  fs.writeFileSync(path.join(dir, `${ID}.locale.en-US.yaml`), lines(
    schema('defaultLocale'),
    `PackageIdentifier: ${ID}`, `PackageVersion: ${version}`, 'PackageLocale: en-US',
    'Publisher: Sabbir Hassan', `PublisherUrl: ${baseUrl}`, 'PackageName: Scaffold', `PackageUrl: ${baseUrl}`,
    'License: Proprietary', 'ShortDescription: Design Flutter apps visually and export clean code.',
    'Moniker: scaffold', 'Tags:', '- design', '- flutter', '- ui', '- prototyping',
    `ReleaseNotes: "${notes}"`, 'ManifestType: defaultLocale', `ManifestVersion: ${SCHEMA}`));
  console.log(`Wrote the winget manifest → winget/manifests/s/SabbirHassan/Scaffold/${version}/`);
}
console.log('\nUpload the new files in downloads/ to the server to publish the update; for winget, see winget/README.md.');
