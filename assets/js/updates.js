// Settings → App updates, in the desktop app. The app asks the server whether a
// newer release exists (once when the dashboard opens, and on "Check for
// updates"); a newer one is shown with its notes and installed on
// "Update & restart" — downloaded, signature-checked and installed by the
// desktop side (desktop/src-tauri/src/updater.rs), which then restarts the app.

const $ = (id) => document.getElementById(id);

let tauri = null;
let busy = false;

function status(text, kind = '') {
  const el = $('update-status');
  el.textContent = text;
  el.className = 'acct-row-sub' + (kind ? ' ' + kind : '');
}

function showAvailable(update) {
  $('update-badge').textContent = update ? '1' : '';
  $('update-available').hidden = !update;
  if (!update) return;
  $('update-title').textContent = `Version ${update.version} is available`;
  const notes = (update.notes || '').trim();
  $('update-notes').textContent = notes;
  $('update-notes').hidden = !notes;
}

// `quiet`: the automatic check on opening — a failure (e.g. offline) isn't worth
// an error message there; the person can check by hand.
async function check(quiet = false) {
  if (busy) return;
  busy = true;
  const button = $('update-check');
  button.disabled = true;
  if (!quiet) status('Checking for updates…');
  try {
    const result = await tauri.core.invoke('update_check');
    if (result.available) {
      status(`Scaffold ${result.version} is ready to install`, 'available');
      showAvailable(result);
    } else {
      status('You’re on the latest version');
      showAvailable(null);
    }
  } catch (error) {
    if (!quiet) status(String(error), 'error');
  } finally {
    busy = false;
    button.disabled = false;
  }
}

async function install() {
  if (busy) return;
  busy = true;
  $('update-check').disabled = true;
  $('update-install').disabled = true;
  const bar = $('update-progress');
  bar.hidden = false;
  bar.classList.add('indeterminate');
  status('Downloading the update…');

  const stop = await tauri.event.listen('update-progress', ({ payload }) => {
    if (!payload.total) return;
    bar.classList.remove('indeterminate');
    const pct = Math.min(100, Math.round((payload.downloaded / payload.total) * 100));
    $('update-progress-bar').style.width = pct + '%';
    status(pct < 100 ? `Downloading the update… ${pct}%` : 'Installing — Scaffold will restart');
  });

  try {
    // Doesn't return on success: the app restarts into the new version.
    await tauri.core.invoke('update_install');
  } catch (error) {
    status(String(error), 'error');
    bar.hidden = true;
    $('update-install').disabled = false;
    $('update-check').disabled = false;
    busy = false;
  } finally {
    stop();
  }
}

export async function initUpdates() {
  tauri = window.__TAURI__ || null;
  const card = $('update-card');
  if (!tauri || !card) return; // the web page has nothing to update
  card.hidden = false;
  try { $('app-version').textContent = await tauri.core.invoke('app_version'); } catch { /* shown without a number */ }
  $('update-check').addEventListener('click', () => check());
  $('update-install').addEventListener('click', install);
  check(true);
}
