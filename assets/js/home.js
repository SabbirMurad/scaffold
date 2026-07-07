// Home / dashboard page. Switches between the sidebar sections (Projects,
// Settings, Account, Billing) by toggling the matching <section>.

import { ddTrigger, initDropdowns } from './dropdown.js';
import { logout, getAuth, initialsAvatar } from './session.js';
import { listProjects, createProject, updateProject, pinProject, deleteProject, myInvites, respondInvite, getMe } from './projects.js';
import { listFeedback, sendFeedback } from './feedback.js';
import { confirmModal } from './confirm.js';

const navItems = document.querySelectorAll('.home-nav-item');
const pages = document.querySelectorAll('.home-page');

// Sidebar sections are addressable by URL hash (e.g. /dashboard#account) so a
// reload — or a shared link — lands on the same tab instead of resetting.
const PAGES = ['projects', 'settings', 'account', 'billing', 'feedback', 'requests'];

function showPage(name) {
  if (!PAGES.includes(name)) name = 'projects';
  navItems.forEach(b => b.classList.toggle('active', b.dataset.page === name));
  pages.forEach(p => p.classList.toggle('active', p.dataset.page === name));
  if (name === 'requests') renderRequests(); // refresh in case an invite just arrived
  if (name === 'feedback') loadFeedback(); // refresh cap state + history from the server
}

// Clicking a nav item points the URL hash at that tab; the hashchange handler
// performs the switch. Re-clicking the current tab still re-runs its side effects.
navItems.forEach(btn => btn.addEventListener('click', () => {
  const name = btn.dataset.page;
  if (location.hash.slice(1) === name) showPage(name);
  else location.hash = name;
}));

// Switch to the tab named in the URL — on back/forward, and (via the call at the
// end of this module, after all tab state is initialized) on initial load.
function routeFromHash() { showPage(decodeURIComponent(location.hash.slice(1)) || 'projects'); }
window.addEventListener('hashchange', routeFromHash);

// ───────── Projects ─────────
// Loaded from the project API. Each card opens the editor bound to that project.
let projects = [];
const projectSearch = document.getElementById('project-search');

// "Edited 3 hours ago" style relative time from an epoch-millis timestamp.
function timeAgo(ms) {
  if (!ms) return 'just now';
  const s = Math.floor((Date.now() - ms) / 1000);
  const units = [
    [31536000, 'year'], [2592000, 'month'], [604800, 'week'],
    [86400, 'day'], [3600, 'hour'], [60, 'minute'],
  ];
  for (const [secs, label] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${label}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

function makeCard(p) {
  const card = document.createElement('div');
  card.className = 'project-card' + (p.pinned ? ' pinned' : '');
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  const from = p.thumbnail_from || '#5b8af5';
  const to = p.thumbnail_to || '#3d6de0';
  card.innerHTML = `
    <button type="button" class="project-pin" title="${p.pinned ? 'Unpin' : 'Pin'}" aria-label="${p.pinned ? 'Unpin project' : 'Pin project'}"></button>
    <button type="button" class="project-del" title="Delete project" aria-label="Delete project">&times;</button>
    <div class="project-preview" style="background:linear-gradient(135deg, ${from}, ${to})">${escHtml((p.name || '?').charAt(0))}</div>
    <div class="project-meta">
      <div class="project-name">${escHtml(p.name || 'Untitled')}</div>
      <div class="project-edited">Edited ${timeAgo(p.modified_at)}</div>
    </div>`;

  const open = () => { window.location.href = `/editor/${encodeURIComponent(p.uuid)}`; };
  card.addEventListener('click', e => { if (!e.target.closest('.project-pin, .project-del')) open(); });
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });

  // Pin toggles optimistically, reverting if the request fails.
  card.querySelector('.project-pin').addEventListener('click', async e => {
    e.stopPropagation();
    p.pinned = !p.pinned;
    renderProjects();
    const res = await pinProject(p.uuid, p.pinned);
    if (!res.ok) { p.pinned = !p.pinned; renderProjects(); toast(res.error || 'Couldn’t update project'); }
  });

  card.querySelector('.project-del').addEventListener('click', async e => {
    e.stopPropagation();
    const ok = await confirmModal({
      title: 'Delete project?',
      message: `“<strong>${escHtml(p.name || 'Untitled')}</strong>” will be permanently deleted. This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await deleteProject(p.uuid);
    if (res.ok) { projects = projects.filter(x => x.uuid !== p.uuid); renderProjects(); toast('Project deleted'); }
    else toast(res.error || 'Couldn’t delete project');
  });
  return card;
}

function renderProjects() {
  const grid = document.getElementById('projects-grid');
  if (!grid) return;
  const q = (projectSearch?.value || '').trim().toLowerCase();
  const matches = projects.filter(p => (p.name || '').toLowerCase().includes(q));
  // Pinned first, then most-recently edited.
  const sorted = matches.slice().sort((a, b) =>
    (Number(b.pinned) - Number(a.pinned)) || ((b.modified_at || 0) - (a.modified_at || 0)));

  grid.innerHTML = '';
  if (!sorted.length) {
    grid.innerHTML = q
      ? `<div class="home-placeholder">No projects match “${escHtml(q)}”.</div>`
      : `<div class="home-placeholder">No projects yet. Click “New project” to start.</div>`;
    return;
  }
  sorted.forEach(p => grid.appendChild(makeCard(p)));
}

async function loadProjects() {
  if (!getAuth()) { window.location.href = '/authentication'; return; }
  const grid = document.getElementById('projects-grid');
  if (grid) grid.innerHTML = `<div class="home-placeholder">Loading projects…</div>`;
  const res = await listProjects();
  if (res.status === 401) { window.location.href = '/authentication'; return; }
  if (res.ok) {
    projects = Array.isArray(res.data) ? res.data : [];
    renderProjects();
  } else if (grid) {
    grid.innerHTML = `<div class="home-placeholder">Couldn’t load projects. ${escHtml(res.error || '')}</div>`;
  }
}

projectSearch?.addEventListener('input', renderProjects);
loadProjects();

// ───────── Toast ─────────
let toastEl = null, toastTimer = null;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'home-toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// ───────── Account page (UI scaffold) ─────────
// None of these perform real account changes — they only update the UI / preview.

// Avatar: preview a locally-chosen image (no upload).
const avatarInput = document.getElementById('avatar-input');
document.getElementById('avatar-change')?.addEventListener('click', () => avatarInput?.click());
avatarInput?.addEventListener('change', () => {
  const file = avatarInput.files[0];
  avatarInput.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('Image must be under 2MB'); return; }
  const reader = new FileReader();
  reader.onload = () => { document.getElementById('acct-avatar').src = reader.result; toast('Photo updated'); };
  reader.readAsDataURL(file);
});

document.getElementById('profile-form')?.addEventListener('submit', (e) => { e.preventDefault(); toast('Profile saved'); });

// Change password: only checks the two new entries match (demo, nothing stored).
document.getElementById('password-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const [cur, next, confirm] = [...e.target.querySelectorAll('input')].map(i => i.value);
  if (!cur || !next) { toast('Fill in your current and new password'); return; }
  if (next.length < 8) { toast('New password must be at least 8 characters'); return; }
  if (next !== confirm) { toast('New passwords don’t match'); return; }
  e.target.reset();
  toast('Password updated');
});

document.getElementById('twofa-toggle')?.addEventListener('change', (e) => {
  toast(e.target.checked ? 'Two-factor authentication enabled' : 'Two-factor authentication disabled');
});

document.querySelectorAll('[data-connect]').forEach(btn => btn.addEventListener('click', () => toast(`Connect ${btn.dataset.connect} — coming soon`)));

document.getElementById('signout-all')?.addEventListener('click', () => toast('Signed out of all other sessions'));
document.querySelectorAll('.session-out').forEach(btn => btn.addEventListener('click', () => {
  const row = btn.closest('.acct-row');
  if (row) row.remove();
  toast('Session signed out');
}));

document.getElementById('export-data')?.addEventListener('click', () => toast('Preparing your data export…'));

// Timezone — uses the same custom dropdown component as the editor.
const TIMEZONES = [
  '(GMT+06:00) Dhaka',
  '(GMT+00:00) London',
  '(GMT-05:00) New York',
  '(GMT-08:00) Los Angeles',
  '(GMT+09:00) Tokyo',
].map(t => ({ value: t, label: t }));

const tzField = document.getElementById('tz-field');
if (tzField) {
  tzField.innerHTML = ddTrigger({ value: TIMEZONES[0].value, options: TIMEZONES, data: { tz: '1' } });
  // The dropdown only updates its stored value on change; refresh the visible label too.
  tzField.addEventListener('dd:change', (e) => {
    const opt = TIMEZONES.find(o => o.value === e.detail.value);
    const label = tzField.querySelector('.dd-label');
    if (label && opt) label.textContent = opt.label;
  });
}
initDropdowns();

// ───────── Requests — invitations addressed to you ─────────
// Pending collaboration invites to *this* user (from the collaborators API).
// Accepting adds the project to your list; declining dismisses the invite.
const escHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ROLE_LABEL = { viewer: 'Viewer', editor: 'Editor', owner: 'Owner' };
let incomingInvites = [];

function updateRequestsBadge() {
  const badge = document.getElementById('requests-badge');
  if (badge) badge.textContent = incomingInvites.length ? String(incomingInvites.length) : '';
}

function reqRow(inv) {
  const roleLabel = ROLE_LABEL[(inv.role || '').toLowerCase()] || inv.role || 'Editor';
  const name = inv.project_name || 'Untitled';
  return `<div class="req-item">
      <div class="req-ava">${escHtml(name.charAt(0).toUpperCase())}</div>
      <div class="req-info">
        <div class="req-email">${escHtml(name)}</div>
        <div class="req-sub">You're invited as <strong>${roleLabel}</strong></div>
      </div>
      <div class="req-actions">
        <button type="button" class="acct-btn-ghost" data-decline="${inv.uuid}">Decline</button>
        <button type="button" class="acct-btn" data-accept="${inv.uuid}">Accept</button>
      </div>
    </div>`;
}

async function renderRequests() {
  const list = document.getElementById('requests-list');
  if (!list || !getAuth()) return;
  list.innerHTML = '<div class="home-placeholder">Loading…</div>';

  const res = await myInvites();
  if (!res.ok) {
    if (res.status === 401) { window.location.href = '/authentication'; return; }
    list.innerHTML = `<div class="home-placeholder">Couldn’t load invitations. ${escHtml(res.error || '')}</div>`;
    return;
  }

  incomingInvites = Array.isArray(res.data) ? res.data : [];
  updateRequestsBadge();

  if (!incomingInvites.length) {
    list.innerHTML = '<div class="home-placeholder">No pending invitations.</div>';
    return;
  }

  list.innerHTML = `<div class="req-group-head">Pending invitations</div>` + incomingInvites.map(reqRow).join('');

  const respond = async (uuid, status, okMsg) => {
    const inv = incomingInvites.find(i => i.uuid === uuid);
    if (!inv) return;
    const r = await respondInvite(inv.project_id, uuid, status);
    if (r.ok) { toast(okMsg); renderRequests(); }
    else toast(r.error || 'Couldn’t update invitation');
  };
  list.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click',
    () => respond(b.dataset.accept, 'Accepted', 'Invitation accepted — the project is now in your list')));
  list.querySelectorAll('[data-decline]').forEach(b => b.addEventListener('click',
    () => respond(b.dataset.decline, 'Declined', 'Invitation declined')));
}

renderRequests();

// Delete account: two-step confirm. Deletion is intentionally a no-op (demo).
const delBtn = document.getElementById('delete-account');
let delConfirm = null;
delBtn?.addEventListener('click', () => {
  if (delBtn.classList.contains('confirming')) {
    clearTimeout(delConfirm);
    delBtn.classList.remove('confirming');
    delBtn.textContent = 'Delete';
    toast('Account deletion is disabled in this demo');
    return;
  }
  delBtn.classList.add('confirming');
  delBtn.textContent = 'Click again to confirm';
  delConfirm = setTimeout(() => { delBtn.classList.remove('confirming'); delBtn.textContent = 'Delete'; }, 4000);
});

// ───────── Settings (workspace & app preferences — localStorage scaffold) ─────────
// Persisted only; these are the defaults future editor/codegen work would read.
const SETTINGS_KEY = 'Scaffold_settings';
const SET_OPTS = {
  frameSize: [
    { value: 'iphone15', label: 'iPhone 15 · 393×852' },
    { value: 'pixel7',   label: 'Pixel 7 · 412×915' },
    { value: 'ipad',     label: 'iPad · 820×1180' },
    { value: 'desktop',  label: 'Desktop · 1440×1024' },
    { value: 'custom',   label: 'Custom' },
  ],
  units: [{ value: 'px', label: 'Pixels (px)' }, { value: 'dp', label: 'Density-independent (dp)' }],
  autosave: [
    { value: 'off', label: 'Off' }, { value: '15s', label: 'Every 15 seconds' },
    { value: '30s', label: 'Every 30 seconds' }, { value: '1m', label: 'Every minute' }, { value: '5m', label: 'Every 5 minutes' },
  ],
  stateMgmt: [
    { value: 'riverpod', label: 'Riverpod' }, { value: 'provider', label: 'Provider' },
    { value: 'bloc', label: 'Bloc' }, { value: 'setstate', label: 'setState' },
  ],
  naming: [{ value: 'camel', label: 'camelCase' }, { value: 'snake', label: 'snake_case' }],
};
const DEFAULT_SETTINGS = {
  frameSize: 'iphone15', units: 'px', showGrid: true, snapGrid: true, gridSize: 8, nudge: 1, autosave: '30s', showRulers: true,
  stateMgmt: 'riverpod', naming: 'camel', constWidgets: true, codeComments: true, lineLength: 80,
  notifRequests: true, notifComments: true, notifUpdates: false, notifInApp: true,
};

function getSettings() {
  try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
const settings = getSettings();
let settingsToastTimer = null;
function updateSetting(key, val) {
  settings[key] = val;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
  // Debounce the toast so flipping several toggles doesn't spam it.
  clearTimeout(settingsToastTimer);
  settingsToastTimer = setTimeout(() => toast('Settings saved'), 350);
}

const settingsPage = document.querySelector('.home-page[data-page="settings"]');
if (settingsPage) {
  // Custom dropdowns
  settingsPage.querySelectorAll('.set-ctrl[data-setting]').forEach(slot => {
    const key = slot.dataset.setting;
    slot.innerHTML = ddTrigger({ value: settings[key], options: SET_OPTS[key], data: { setting: key } });
  });
  settingsPage.addEventListener('dd:change', e => {
    const trig = e.target.closest('.dd-trigger[data-setting]');
    if (!trig) return;
    const key = trig.dataset.setting;
    const opt = SET_OPTS[key]?.find(o => o.value === e.detail.value);
    const lbl = trig.querySelector('.dd-label');
    if (lbl && opt) lbl.textContent = opt.label;
    updateSetting(key, e.detail.value);
  });
  // Toggles
  settingsPage.querySelectorAll('input[type="checkbox"][data-setting]').forEach(cb => {
    cb.checked = !!settings[cb.dataset.setting];
    cb.addEventListener('change', () => updateSetting(cb.dataset.setting, cb.checked));
  });
  // Number fields
  settingsPage.querySelectorAll('input[type="number"][data-setting]').forEach(inp => {
    inp.value = settings[inp.dataset.setting];
    inp.addEventListener('change', () => {
      let v = Number(inp.value);
      const min = Number(inp.min), max = Number(inp.max);
      if (Number.isNaN(v)) v = DEFAULT_SETTINGS[inp.dataset.setting];
      if (!Number.isNaN(min)) v = Math.max(min, v);
      if (!Number.isNaN(max)) v = Math.min(max, v);
      inp.value = v;
      updateSetting(inp.dataset.setting, v);
    });
  });
}

// ───────── Billing (UI scaffold — no real charges happen) ─────────
document.getElementById('billing-update-pay')?.addEventListener('click', () => toast('Payment methods are managed by your provider — coming soon'));
document.getElementById('billing-change-plan')?.addEventListener('click', () => {
  document.getElementById('billing-plans')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', () => toast(`Switching to ${b.dataset.plan} is disabled in this demo`)));
document.querySelectorAll('.invoice-dl').forEach(b => b.addEventListener('click', () => toast(`Invoice ${b.dataset.invoice} — download coming soon`)));

// Cancel subscription: two-step confirm, intentionally a no-op (demo).
const cancelBtn = document.getElementById('billing-cancel');
let cancelConfirm = null;
cancelBtn?.addEventListener('click', () => {
  if (cancelBtn.classList.contains('confirming')) {
    clearTimeout(cancelConfirm);
    cancelBtn.classList.remove('confirming');
    cancelBtn.textContent = 'Cancel subscription';
    toast('Subscription cancellation is disabled in this demo');
    return;
  }
  cancelBtn.classList.add('confirming');
  cancelBtn.textContent = 'Click again to confirm';
  cancelConfirm = setTimeout(() => { cancelBtn.classList.remove('confirming'); cancelBtn.textContent = 'Cancel subscription'; }, 4000);
});

// ───────── Feedback (server-backed; capped at 5 submissions per calendar day) ─────────
const FB_TYPES = ['Bug', 'Idea', 'Question', 'Other'].map(t => ({ value: t, label: t }));

// Cap state + recent history, loaded from the server (the daily cap is enforced
// server-side; this is just what the UI needs to render).
let fbState = { max_per_day: 5, used_today: 0, items: [] };

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(ts).toLocaleDateString();
}

const fbType = document.getElementById('fb-type');
const fbText = document.getElementById('fb-text');
const fbSubmit = document.getElementById('fb-submit');
const fbRemaining = document.getElementById('fb-remaining');
const fbCount = document.getElementById('fb-count');
const fbHistoryCard = document.getElementById('fb-history-card');
const fbHistory = document.getElementById('fb-history');

if (fbType) {
  fbType.innerHTML = ddTrigger({ value: FB_TYPES[0].value, options: FB_TYPES, data: { fb: '1' } });
  fbType.addEventListener('dd:change', (e) => {
    const label = fbType.querySelector('.dd-label');
    if (label) label.textContent = e.detail.value;
  });
}

function renderFeedbackMeta() {
  const left = Math.max(0, fbState.max_per_day - fbState.used_today);
  if (fbRemaining) {
    fbRemaining.textContent = left ? `${left} of ${fbState.max_per_day} left today` : 'Daily limit reached';
    fbRemaining.classList.toggle('none', left === 0);
  }
  if (fbSubmit) {
    fbSubmit.disabled = left === 0;
    fbSubmit.textContent = left === 0 ? 'Come back tomorrow' : 'Send feedback';
  }
}

function renderFeedbackHistory() {
  if (!fbHistory) return;
  const items = fbState.items.slice(0, 8); // server returns newest first
  if (fbHistoryCard) fbHistoryCard.hidden = items.length === 0;
  fbHistory.innerHTML = items.map(f => `
    <div class="fb-item">
      <span class="fb-type-chip">${escHtml(f.kind)}</span>
      <div class="fb-item-body">
        <div class="fb-item-text">${escHtml(f.message)}</div>
        <div class="fb-item-time">${escHtml(relTime(f.created_at))}</div>
      </div>
    </div>`).join('');
}

// Pull the caller's cap state + recent history from the server and re-render.
async function loadFeedback() {
  const res = await listFeedback();
  if (res.ok && res.data) {
    fbState = {
      max_per_day: res.data.max_per_day ?? 5,
      used_today: res.data.used_today ?? 0,
      items: Array.isArray(res.data.items) ? res.data.items : [],
    };
  }
  renderFeedbackMeta();
  renderFeedbackHistory();
}

fbText?.addEventListener('input', () => { if (fbCount) fbCount.textContent = String(fbText.value.length); });

document.getElementById('feedback-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = fbText.value.trim();
  if (!text) { toast('Write a little something first'); return; }
  const type = fbType?.querySelector('.dd-trigger')?.dataset.ddValue || 'Other';

  if (fbSubmit) fbSubmit.disabled = true;
  const res = await sendFeedback(type, text);
  if (res.ok) {
    fbText.value = '';
    if (fbCount) fbCount.textContent = '0';
    toast('Thanks for your feedback!');
  } else {
    toast(res.error || 'Couldn’t send feedback');
  }
  // Re-sync cap state + history from the server either way (a 429 means the cap
  // was hit, e.g. from another tab).
  await loadFeedback();
});

renderFeedbackMeta();
renderFeedbackHistory();

// New project → create it, then open the editor bound to it.
document.getElementById('new-project-btn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const res = await createProject({ name: 'Untitled Project' });
  btn.disabled = false;
  if (res.ok && res.data && res.data.uuid) {
    window.location.href = `/editor/${encodeURIComponent(res.data.uuid)}`;
  } else if (res.status === 401) {
    window.location.href = '/authentication';
  } else {
    toast(res.error || 'Couldn’t create project');
  }
});

// Logout → purge the session, clear tokens, back to the authentication page.
document.getElementById('home-logout')?.addEventListener('click', async () => {
  const ok = await confirmModal({ title: 'Log out?', message: 'You’ll need to sign in again to get back in.', confirmLabel: 'Log out', danger: true });
  if (ok) logout();
});

// Restore the tab from the URL now that every section's state is initialized.
routeFromHash();

// Fill the profile chip (sidebar + Account tab) with the signed-in user's real data.
async function loadProfile() {
  const res = await getMe();
  if (!res.ok || !res.data) return;
  const { full_name, email_address, profile_picture } = res.data;
  document.querySelectorAll('.home-profile-name').forEach(el => { el.textContent = full_name || ''; });
  document.querySelectorAll('.home-profile-email').forEach(el => { el.textContent = email_address || ''; });
  const nameInput = document.getElementById('acct-fullname');
  if (nameInput) nameInput.value = full_name || '';
  // No uploaded picture → show initials derived from the name.
  if (!profile_picture) {
    const src = initialsAvatar(full_name);
    document.querySelectorAll('.home-avatar, #acct-avatar').forEach(img => { img.src = src; });
  }
}
loadProfile();
