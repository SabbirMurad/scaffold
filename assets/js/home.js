// Home / dashboard page. Switches between the sidebar sections (Projects,
// Settings, Account, Billing) by toggling the matching <section>.

import { ddTrigger, initDropdowns } from './dropdown.js';
import { getShares, setShareStatus, removeShare, pendingCount, seedDemoShares } from './shares.js';

const navItems = document.querySelectorAll('.home-nav-item');
const pages = document.querySelectorAll('.home-page');

function showPage(name) {
  navItems.forEach(b => b.classList.toggle('active', b.dataset.page === name));
  pages.forEach(p => p.classList.toggle('active', p.dataset.page === name));
  if (name === 'requests') renderRequests(); // refresh in case an invite just arrived
  if (name === 'feedback') renderFeedbackMeta(); // recompute today's remaining count
}

navItems.forEach(btn => btn.addEventListener('click', () => showPage(btn.dataset.page)));

// ───────── Demo projects ─────────
// Placeholder list until real projects are persisted. Each card opens the editor.
const demoProjects = [
  { name: 'Mobile Banking App', edited: 'Edited 2 hours ago',  c1: '#5b8af5', c2: '#3d6de0', pinned: true },
  { name: 'E-commerce Store',   edited: 'Edited yesterday',    c1: '#f5576c', c2: '#f093fb', pinned: false },
  { name: 'Fitness Tracker',    edited: 'Edited 3 days ago',   c1: '#11998e', c2: '#38ef7d', pinned: false },
  { name: 'Travel Booking',     edited: 'Edited last week',    c1: '#f7971e', c2: '#ffd200', pinned: false },
  { name: 'Recipe Manager',     edited: 'Edited 2 weeks ago',  c1: '#7b4397', c2: '#dc2430', pinned: false },
  { name: 'Podcast Player',     edited: 'Edited last month',   c1: '#2193b0', c2: '#6dd5ed', pinned: false },
];

const projectSearch = document.getElementById('project-search');

function makeCard(p) {
  const card = document.createElement('div');
  card.className = 'project-card' + (p.pinned ? ' pinned' : '');
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.innerHTML = `
    <button type="button" class="project-pin" title="${p.pinned ? 'Unpin' : 'Pin'}" aria-label="${p.pinned ? 'Unpin project' : 'Pin project'}"></button>
    <div class="project-preview" style="background:linear-gradient(135deg, ${p.c1}, ${p.c2})">${p.name.charAt(0)}</div>
    <div class="project-meta">
      <div class="project-name">${p.name}</div>
      <div class="project-edited">${p.edited}</div>
    </div>`;
  const open = () => { window.location.href = '/editor'; };
  card.addEventListener('click', e => { if (!e.target.closest('.project-pin')) open(); });
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  card.querySelector('.project-pin').addEventListener('click', e => {
    e.stopPropagation();
    p.pinned = !p.pinned;
    renderProjects();
  });
  return card;
}

function renderProjects() {
  const grid = document.getElementById('projects-grid');
  if (!grid) return;
  const q = (projectSearch?.value || '').trim().toLowerCase();
  const matches = demoProjects.filter(p => p.name.toLowerCase().includes(q));
  // Pinned first, otherwise keep the original order (stable).
  const sorted = matches.map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.pinned - a.p.pinned) || (a.i - b.i))
    .map(x => x.p);

  grid.innerHTML = '';
  if (!sorted.length) {
    grid.innerHTML = `<div class="home-placeholder">No projects match “${q}”.</div>`;
    return;
  }
  sorted.forEach(p => grid.appendChild(makeCard(p)));
}

projectSearch?.addEventListener('input', renderProjects);
renderProjects();

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

// ───────── Requests (collaboration invites from the editor) ─────────
const escHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function updateRequestsBadge() {
  const badge = document.getElementById('requests-badge');
  if (badge) badge.textContent = pendingCount() ? String(pendingCount()) : '';
}

const ROLE_LABEL = { viewer: 'Viewer', editor: 'Editor', owner: 'Owner' };

function reqRow(r, actions) {
  const roleLabel = ROLE_LABEL[r.role] || 'Editor';
  const verb = r.status === 'accepted' ? 'Has' : 'Wants';
  return `<div class="req-item">
      <div class="req-ava">${escHtml(r.email[0] || '?')}</div>
      <div class="req-info">
        <div class="req-email">${escHtml(r.email)}</div>
        <div class="req-sub">${verb} <strong>${roleLabel}</strong> access to <strong>${escHtml(r.project)}</strong></div>
      </div>
      <div class="req-actions">${actions}</div>
    </div>`;
}

function renderRequests() {
  const list = document.getElementById('requests-list');
  if (!list) return;
  // Declined invites are dismissed outright, so only pending + accepted remain.
  const reqs = getShares().filter(r => r.status !== 'declined');
  const pending = reqs.filter(r => r.status === 'pending');
  const accepted = reqs.filter(r => r.status === 'accepted');

  if (!reqs.length) {
    list.innerHTML = '<div class="home-placeholder">No collaboration requests yet. Share a project from the editor to send one.</div>';
    updateRequestsBadge();
    return;
  }

  let html = '';
  if (pending.length) {
    html += `<div class="req-group-head">Pending requests</div>`;
    html += pending.map(r => reqRow(r,
      `<button type="button" class="acct-btn-ghost" data-decline="${r.id}">Decline</button>` +
      `<button type="button" class="acct-btn" data-accept="${r.id}">Accept</button>`)).join('');
  }
  if (accepted.length) {
    html += `<div class="req-group-head">People with access</div>`;
    html += accepted.map(r => reqRow(r,
      `<span class="req-status accepted">Accepted</span>` +
      `<button type="button" class="acct-btn-ghost req-revoke" data-remove="${r.id}">Remove</button>`)).join('');
  }
  list.innerHTML = html;

  list.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', () => {
    setShareStatus(b.dataset.accept, 'accepted'); renderRequests(); toast('Request accepted — they can now access this project');
  }));
  list.querySelectorAll('[data-decline]').forEach(b => b.addEventListener('click', () => {
    removeShare(b.dataset.decline); renderRequests(); toast('Request declined');
  }));
  list.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
    removeShare(b.dataset.remove); renderRequests(); toast('Access removed');
  }));
  updateRequestsBadge();
}

seedDemoShares(); // one-time example requests so the tab isn't empty on first load
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

// ───────── Feedback (stored locally; capped at 5 submissions per calendar day) ─────────
const FB_KEY = 'Scaffold_feedback';
const FB_MAX_PER_DAY = 5;
const FB_TYPES = ['Bug', 'Idea', 'Question', 'Other'].map(t => ({ value: t, label: t }));

function getFeedback() { try { return JSON.parse(localStorage.getItem(FB_KEY)) || []; } catch { return []; } }
function saveFeedback(list) { try { localStorage.setItem(FB_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ } }
function sameDay(ts) {
  const d = new Date(ts), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function feedbackTodayCount() { return getFeedback().filter(f => sameDay(f.ts)).length; }

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
  const left = Math.max(0, FB_MAX_PER_DAY - feedbackTodayCount());
  if (fbRemaining) {
    fbRemaining.textContent = left ? `${left} of ${FB_MAX_PER_DAY} left today` : 'Daily limit reached';
    fbRemaining.classList.toggle('none', left === 0);
  }
  if (fbSubmit) {
    fbSubmit.disabled = left === 0;
    fbSubmit.textContent = left === 0 ? 'Come back tomorrow' : 'Send feedback';
  }
}

function renderFeedbackHistory() {
  if (!fbHistory) return;
  const items = getFeedback().slice(0, 8); // newest first (unshifted on add)
  if (fbHistoryCard) fbHistoryCard.hidden = items.length === 0;
  fbHistory.innerHTML = items.map(f => `
    <div class="fb-item">
      <span class="fb-type-chip">${escHtml(f.type)}</span>
      <div class="fb-item-body">
        <div class="fb-item-text">${escHtml(f.text)}</div>
        <div class="fb-item-time">${escHtml(relTime(f.ts))}</div>
      </div>
    </div>`).join('');
}

fbText?.addEventListener('input', () => { if (fbCount) fbCount.textContent = String(fbText.value.length); });

document.getElementById('feedback-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (feedbackTodayCount() >= FB_MAX_PER_DAY) { toast(`You can only send ${FB_MAX_PER_DAY} feedbacks a day — try again tomorrow`); renderFeedbackMeta(); return; }
  const text = fbText.value.trim();
  if (!text) { toast('Write a little something first'); return; }
  const type = fbType?.querySelector('.dd-trigger')?.dataset.ddValue || 'Other';
  const list = getFeedback();
  list.unshift({ type, text, ts: Date.now() });
  saveFeedback(list);
  fbText.value = '';
  if (fbCount) fbCount.textContent = '0';
  renderFeedbackMeta();
  renderFeedbackHistory();
  toast('Thanks for your feedback!');
});

renderFeedbackMeta();
renderFeedbackHistory();

// New project → straight into the editor (the demo project list is added later).
document.getElementById('new-project-btn')?.addEventListener('click', () => {
  window.location.href = '/editor';
});

// Logout → authentication page (built in a later task).
document.getElementById('home-logout')?.addEventListener('click', () => {
  window.location.href = '/authentication';
});
