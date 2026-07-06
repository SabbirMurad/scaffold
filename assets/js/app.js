import { state, getNode, makeNode, seedDefaults } from './state.js';
import { canvasWrap, addMenu, frameMenu, closeMenus, showToast, esc } from './utils.js';
import { canvasToWorld, canAcceptChild, isSingleChild } from './nodes.js';
import { saveHistory, serializeDocument, loadDocument, commitCurrent } from './history.js';
import { finalizeImages, imagesPending, resolveRefsForExport } from './images.js';
import { render, applyTransform } from './render.js';
import { initCanvasEvents } from './canvas.js';
import { initToolEvents, setTool } from './tools.js';
import { findFrameAt, getWorldPos } from './nodes.js';
import { initModels, renderModels } from './models.js';
import { initApi, renderApi } from './api.js';
import { initColors, renderColors, renderThemeSwitch, applyTheme } from './colors.js';
import { initTypography, renderTypography } from './typography.js';
import { logout, getAuth } from './session.js';
import { getProject, saveProjectDoc, updateProject, requestAccess,
  listCollaborators, inviteCollaborator, setCollaboratorRole, removeCollaborator, respondInvite } from './projects.js';
import { initMock, renderMock } from './mock.js';
import { exportModelsCode, collectExportables, dartPath } from './codegen.js';
import { updateExportButton } from './validate.js';
import { initDropdowns, ddTrigger } from './dropdown.js';
import { initIconPicker } from './icons-picker.js';
import { initFontPicker } from './google-fonts.js';
import { initImagePicker } from './image-picker.js';
import { initFlow } from './flow.js';
import { initComments, loadComments } from './comments.js';

// Initialize event systems
initCanvasEvents();
initToolEvents();
initModels();
initApi();
initColors();
initTypography();
initMock();
initDropdowns();
initIconPicker();
initFontPicker();
initImagePicker();
initFlow();
initComments();

// Image resolution is async (bytes are fetched with the bearer token): re-render
// when a ref's blob URL becomes available, and fold an inline→ref swap into the
// current undo step (then re-render) once uploads finish.
document.addEventListener('image:resolved', () => render());
document.addEventListener('image:committed', () => { commitCurrent(); render(); });

// Add element menu
document.getElementById('btn-add-layer').addEventListener('click', e => {
  const rect = e.target.getBoundingClientRect();
  addMenu.style.left = rect.right + 4 + 'px';
  addMenu.style.top = rect.bottom + 4 + 'px';
  addMenu.style.display = 'block';
  e.stopPropagation();
});

// Resolve where a new w×h node of `type` should be placed: parent (if a selected
// container/frame can accept it) and the local x/y within that parent or the canvas.
function resolvePlacement(type, w, h) {
  const cx = canvasWrap.offsetWidth / 2;
  const cy = canvasWrap.offsetHeight / 2;
  const world = canvasToWorld(cx, cy);

  let parent = null;
  if (type !== 'frame' && state.selected.size === 1) {
    const selNode = getNode([...state.selected][0]);
    if (canAcceptChild(selNode)) parent = selNode;
  }

  let x, y;
  if (parent) {
    // Single-child wrappers pin to top-left; otherwise center within the parent
    if (isSingleChild(parent)) { x = 0; y = 0; }
    else { x = parent.w / 2 - w / 2; y = parent.h / 2 - h / 2; }
  } else {
    x = world.x - w / 2;
    y = world.y - h / 2;
  }
  return { parent, x, y };
}

function finalizeNew(node, parent) {
  if (parent) parent.children.push(node.id);
  state.nodes.push(node);
  state.selected.clear();
  state.selected.add(node.id);
  saveHistory();
  render();
}

// Create an element at the canvas center, nesting into a selected container/frame if possible
function createElement(type) {
  const defaults = { frame: [240, 160], container: [120, 80], row: [200, 200], column: [200, 200], wrap: [200, 200], stack: [200, 200], text: [120, 40] };
  const [w, h] = defaults[type] || [100, 100];
  const { parent, x, y } = resolvePlacement(type, w, h);
  const node = makeNode(type, x, y, w, h, parent ? parent.id : null);
  finalizeNew(node, parent);
}

function createImageNode(src, w, h) {
  const { parent, x, y } = resolvePlacement('image', w, h);
  const node = makeNode('image', x, y, w, h, parent ? parent.id : null);
  node.src = src;
  finalizeNew(node, parent);
  finalizeImages(); // upload the inline bytes to the backend, swap src → ref
}

addMenu.addEventListener('click', e => {
  const item = e.target.closest('.ctx-item');
  if (!item) return;
  createElement(item.dataset.addtype);
  closeMenus();
});

// Image upload — the Image tool opens the stock-image picker (image-picker.js),
// whose "Upload from device" button triggers this hidden file input. On change we
// scale the chosen file to a sane size and place it.
const imageInput = document.getElementById('image-input');
imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  imageInput.value = ''; // allow re-picking the same file later
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const src = reader.result;
    const probe = new Image();
    probe.onload = () => {
      let w = probe.naturalWidth || 200;
      let h = probe.naturalHeight || 200;
      const max = 320;
      if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
      createImageNode(src, w, h);
      showToast(`Added "${file.name}"`);
    };
    probe.src = src;
  };
  reader.readAsDataURL(file);
});

// Export model/provider code as a downloadable Dart project. Clicking the icon
// opens a picker of what will be exported (checkboxes per model/enum/provider).
const exportModal = document.getElementById('export-modal');
const exportList = document.getElementById('export-list');
const closeExport = () => { if (exportModal) exportModal.hidden = true; };

// Build the checkbox list, grouped by kind, all checked by default.
function buildExportList(groups) {
  const group = (kind, title, names) => names.length ? `
    <div class="export-group">
      <div class="export-group-head">
        <span>${title}</span>
        <button type="button" class="export-toggle-all" data-kind="${kind}">Toggle all</button>
      </div>
      ${names.map(n => `
      <label class="export-item">
        <input type="checkbox" data-kind="${kind}" value="${esc(n)}" checked>
        <span class="export-item-name">${esc(n)}</span>
        <span class="export-item-path">${esc(dartPath(kind, n))}</span>
      </label>`).join('')}
    </div>` : '';
  return group('models', 'Models', groups.models.map(m => m.name))
    + group('enums', 'Enums', groups.enums.map(e => e.name))
    + group('providers', 'Providers', groups.providers.map(p => p.name))
    + group('screens', 'Screens', groups.screens.map(s => s.name))
    + group('theme', 'Theme', groups.hasTheme ? [groups.hasTypography ? 'App colors, type & theme' : 'App colors & theme'] : []);
}

function openExportModal() {
  const groups = collectExportables();
  if (!groups.models.length && !groups.enums.length && !groups.providers.length && !groups.screens.length && !groups.hasTheme) {
    showToast('Nothing to export — create a model, provider, screen or color first');
    return;
  }
  exportList.innerHTML = buildExportList(groups);
  exportModal.hidden = false;
}

document.getElementById('btn-export-code')?.addEventListener('click', (e) => {
  e.preventDefault();
  // The icon isn't natively disabled (so its hover hint shows); guard here instead.
  if (e.currentTarget.classList.contains('has-error')) { showToast('Fix errors before exporting'); return; }
  openExportModal();
});

// "Toggle all" in a group flips every checkbox in that group.
exportList?.addEventListener('click', (e) => {
  const btn = e.target.closest('.export-toggle-all');
  if (!btn) return;
  const boxes = [...exportList.querySelectorAll(`input[data-kind="${btn.dataset.kind}"]`)];
  const allOn = boxes.every(b => b.checked);
  boxes.forEach(b => { b.checked = !allOn; });
});

document.getElementById('export-confirm')?.addEventListener('click', async () => {
  const selection = { models: new Set(), enums: new Set(), providers: new Set(), screens: new Set(), theme: new Set() };
  exportList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => selection[cb.dataset.kind].add(cb.value));
  if (!selection.models.size && !selection.enums.size && !selection.providers.size && !selection.screens.size && !selection.theme.size) {
    showToast('Select at least one item to export');
    return;
  }
  // Image nodes hold `img:` refs; fetch their bytes so codegen can bundle assets.
  await resolveRefsForExport(state.nodes);
  const r = exportModelsCode(selection);
  closeExport();
  if (!r.ok) { showToast('Nothing to export'); return; }
  const parts = [];
  if (r.models) parts.push(`${r.models} model${r.models === 1 ? '' : 's'}`);
  if (r.enums) parts.push(`${r.enums} enum${r.enums === 1 ? '' : 's'}`);
  if (r.providers) parts.push(`${r.providers} provider${r.providers === 1 ? '' : 's'}`);
  if (r.screens) parts.push(`${r.screens} screen${r.screens === 1 ? '' : 's'}`);
  if (r.theme) parts.push('theme');
  showToast('Exported ' + (parts.join(' + ') || 'nothing'));
});

document.getElementById('export-close')?.addEventListener('click', closeExport);
document.getElementById('export-cancel')?.addEventListener('click', closeExport);
exportModal?.addEventListener('click', (e) => { if (e.target === exportModal) closeExport(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && exportModal && !exportModal.hidden) closeExport(); });

// Nav icons.
document.getElementById('nav-home')?.addEventListener('click', () => { window.location.href = '/dashboard'; });

// ───────── Project persistence ─────────
// The project this editor is bound to (from ?id=…). null → an unsaved scratch
// session (nothing is persisted until it's opened from a real project).
let currentProjectId = null;
let currentVersion = null;
// Per-slice JSON of what the server currently holds (nodes, colors, models, …), so
// a save can send only the slices that actually changed instead of the whole doc.
let lastSavedSlices = {};
let autosaveTimer = null;

// Snapshot each top-level slice of a document as a JSON string, for change detection.
function docSlices(doc) {
  const slices = {};
  for (const k in doc) slices[k] = JSON.stringify(doc[k]);
  return slices;
}

// Save the design document. `manual` surfaces success/failure via a toast;
// autosave stays silent unless something needs the user's attention.
async function saveProject(manual = false) {
  if (!currentProjectId) {
    if (manual) showToast('Open a project from the dashboard to save');
    return;
  }
  // Don't autosave mid-upload: an image node may still hold a bulky inline data
  // URI that's about to become a compact ref. Manual saves proceed regardless.
  if (!manual && imagesPending()) return;

  const doc = serializeDocument();
  const slices = docSlices(doc);
  // Send only the slices whose JSON differs from what the server last accepted.
  const patch = {};
  let dirty = false;
  for (const k in slices) {
    if (slices[k] !== lastSavedSlices[k]) { patch[k] = doc[k]; dirty = true; }
  }
  if (!dirty) { if (manual) showToast('Project saved'); return; } // nothing changed

  const res = await saveProjectDoc(currentProjectId, patch, currentVersion);
  if (res.ok) {
    for (const k in patch) lastSavedSlices[k] = slices[k]; // the slices we just persisted
    currentVersion = (res.data && res.data.version) != null ? res.data.version : currentVersion;
    if (manual) showToast('Project saved');
  } else if (res.status === 409) {
    showToast('This project changed elsewhere — reload before saving');
  } else if (res.status === 401) {
    showToast('Your session expired — sign in again to save');
  } else if (manual) {
    showToast(res.error || 'Couldn’t save the project');
  }
}

function startAutosave(serverContent) {
  // Baseline against what the SERVER holds — not the post-seedDefaults state — so
  // seeded/migrated slices the server doesn't have yet are treated as dirty and get
  // persisted on the first save (a partial save won't resend them otherwise).
  lastSavedSlices = docSlices(serverContent || {});
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => saveProject(false), 5000);
  // Flush on tab-hide so a quick close doesn't lose the last few seconds.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProject(false);
  });
}

document.getElementById('nav-sync')?.addEventListener('click', () => saveProject(true));
document.getElementById('nav-logout')?.addEventListener('click', () => { logout(); });

// Share project — invite collaborators by email (backed by the collaborators
// API). Roles are lowercase in the UI (viewer/editor) and capitalized on the
// wire (Viewer/Editor); ownership isn't assignable via invites.
const shareModal = document.getElementById('share-modal');
const shareEmail = document.getElementById('share-email');
const shareRoleSlot = document.getElementById('share-role-slot');
const sharePeople = document.getElementById('share-people');
const sharePeopleList = document.getElementById('share-people-list');
const ROLE_LABEL = { viewer: 'Viewer', editor: 'Editor', owner: 'Owner' };
const SHARE_ROLES = ['viewer', 'editor'];
const ROLE_OPTS = SHARE_ROLES.map(r => ({ value: r, label: ROLE_LABEL[r] }));
const toApiRole = (r) => (r || 'editor').charAt(0).toUpperCase() + (r || 'editor').slice(1);
const toUiRole = (r) => (r || '').toLowerCase();
const STATUS_BADGE = {
  Accepted: '<span class="share-badge accepted">Accepted</span>',
  Declined: '<span class="share-badge declined">Declined</span>',
  Pending: '<span class="share-badge pending">Pending</span>',
};

// The role picker beside the email input, reset to Editor each time we open.
function renderInviteRole() {
  if (shareRoleSlot) shareRoleSlot.innerHTML = ddTrigger({ value: 'editor', options: ROLE_OPTS, triggerClass: 'dd-share' });
}
const inviteRole = () => shareRoleSlot?.querySelector('.dd-trigger')?.dataset.ddValue || 'editor';

// A row per collaborator: avatar, email, status badge, a role dropdown, and a
// remove button. Fetched fresh from the server each time the modal opens.
async function renderSharePeople() {
  if (!sharePeople || !sharePeopleList) return;
  if (!currentProjectId) {
    sharePeople.hidden = false;
    sharePeopleList.innerHTML = '<div class="share-empty">Save this project to invite collaborators.</div>';
    return;
  }
  sharePeopleList.innerHTML = '<div class="share-empty">Loading…</div>';
  const res = await listCollaborators(currentProjectId);
  if (!res.ok) {
    sharePeople.hidden = false;
    sharePeopleList.innerHTML = `<div class="share-empty">${esc(res.error || 'Couldn’t load collaborators')}</div>`;
    return;
  }
  // Declined records are dropped; the rest render newest-relevant first with a
  // pending access-request pinned to the top so the owner notices it.
  const people = (Array.isArray(res.data) ? res.data : []).filter(p => p.status !== 'Declined');
  const isRequest = (p) => p.kind === 'Request' && p.status === 'Pending';
  people.sort((a, b) => Number(isRequest(b)) - Number(isRequest(a)));
  sharePeople.hidden = people.length === 0;
  sharePeopleList.innerHTML = people.map(p => {
    const controls = isRequest(p)
      // An access request → the owner grants or declines it.
      ? `<div class="share-req-actions">
          <button type="button" class="share-req-decline" data-decline="${p.uuid}">Decline</button>
          <button type="button" class="share-req-accept" data-accept="${p.uuid}">Accept</button>
        </div>`
      // An invite or a member → role picker + remove.
      : `${ddTrigger({ value: toUiRole(p.role), options: ROLE_OPTS, data: { 'role-for': p.uuid }, triggerClass: 'dd-share' })}
        <button type="button" class="share-remove" data-remove="${p.uuid}" title="Remove" aria-label="Remove collaborator">&times;</button>`;
    const badge = isRequest(p)
      ? '<span class="share-badge request">Wants access</span>'
      : (STATUS_BADGE[p.status] || STATUS_BADGE.Pending);
    return `<div class="share-person" data-id="${p.uuid}">
        <div class="share-ava">${esc((p.email_address[0] || '?').toUpperCase())}</div>
        <div class="share-person-info">
          <div class="share-person-email">${esc(p.email_address)}</div>
          ${badge}
        </div>
        ${controls}
      </div>`;
  }).join('');
}

// The dropdown controller updates data-dd-value but leaves the visible label to
// the consumer; sync it for every role picker inside the share modal.
shareModal?.addEventListener('dd:change', e => {
  const lbl = e.target.closest('.dd-trigger')?.querySelector('.dd-label');
  if (lbl) lbl.textContent = ROLE_LABEL[e.detail.value] || e.detail.value;
});

// Change a collaborator's role.
sharePeopleList?.addEventListener('dd:change', async e => {
  const trig = e.target.closest('[data-role-for]');
  if (!trig || !currentProjectId) return;
  const email = trig.closest('.share-person')?.querySelector('.share-person-email')?.textContent;
  const res = await setCollaboratorRole(currentProjectId, trig.dataset.roleFor, toApiRole(e.detail.value));
  if (res.ok) showToast(`${email || 'Member'} is now ${ROLE_LABEL[e.detail.value] || e.detail.value}`);
  else { showToast(res.error || 'Couldn’t change role'); renderSharePeople(); }
});

// Remove a collaborator, or grant/decline a pending access request.
sharePeopleList?.addEventListener('click', async e => {
  if (!currentProjectId) return;
  const accept = e.target.closest('[data-accept]');
  const decline = e.target.closest('[data-decline]');
  if (accept || decline) {
    const id = (accept || decline).dataset[accept ? 'accept' : 'decline'];
    const res = await respondInvite(currentProjectId, id, accept ? 'Accepted' : 'Declined');
    if (res.ok) { showToast(accept ? 'Access granted' : 'Request declined'); renderSharePeople(); }
    else showToast(res.error || 'Couldn’t update the request');
    return;
  }
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  const res = await removeCollaborator(currentProjectId, btn.dataset.remove);
  if (res.ok) { showToast('Collaborator removed'); renderSharePeople(); }
  else showToast(res.error || 'Couldn’t remove collaborator');
});

const closeShare = () => { if (shareModal) { shareModal.hidden = true; document.getElementById('share-form')?.reset(); } };
document.getElementById('nav-share')?.addEventListener('click', () => { shareModal.hidden = false; renderInviteRole(); renderSharePeople(); shareEmail?.focus(); });
document.getElementById('share-close')?.addEventListener('click', closeShare);
document.getElementById('share-cancel')?.addEventListener('click', closeShare);
shareModal?.addEventListener('click', e => { if (e.target === shareModal) closeShare(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && shareModal && !shareModal.hidden) closeShare(); });
document.getElementById('share-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const email = shareEmail.value.trim();
  if (!email) return;
  if (!currentProjectId) { showToast('Save this project before inviting'); return; }
  const role = inviteRole();
  const res = await inviteCollaborator(currentProjectId, email, toApiRole(role));
  if (res.ok) {
    shareEmail.value = '';
    renderInviteRole();
    renderSharePeople();
    showToast(`Invitation sent to ${email} as ${ROLE_LABEL[role] || role}`);
  } else {
    showToast(res.error || 'Couldn’t send the invitation');
  }
});

// Keep the export button's enabled/disabled state in sync with project validity.
// These events cover edits (input), commits (change), dropdown picks (dd:change),
// add/delete clicks, and undo/redo + delete keystrokes (keyup).
['input', 'change', 'dd:change', 'click', 'keyup'].forEach(ev =>
  document.addEventListener(ev, () => updateExportButton()));

// Project name (editable) — renames the bound project (debounced) as you type.
const projectNameInput = document.getElementById('project-name');
let renameTimer = null;
if (projectNameInput) {
  projectNameInput.value = state.projectName;
  projectNameInput.addEventListener('input', () => {
    state.projectName = projectNameInput.value;
    if (!currentProjectId) return;
    clearTimeout(renameTimer);
    renameTimer = setTimeout(() => {
      const name = state.projectName.trim();
      if (name) updateProject(currentProjectId, { name });
    }, 700);
  });
}

// Collapse / expand the left sidebar
document.getElementById('sidebar-toggle')?.addEventListener('click', () => document.body.classList.add('sidebar-collapsed'));
document.getElementById('sidebar-open')?.addEventListener('click', () => document.body.classList.remove('sidebar-collapsed'));

// Left-panel mode tabs (Design / Model / API)
const modeTabs = document.querySelectorAll('.mode-tab');
const designView = document.getElementById('design-view');
const modelBoard = document.getElementById('model-board');
const mockBoard = document.getElementById('mock-board');
const apiBoard = document.getElementById('api-board');
const colorBoard = document.getElementById('color-board');
const colorPanel = document.getElementById('color-panel');
const typoBoard = document.getElementById('typo-board');
const typoPanel = document.getElementById('typo-panel');
modeTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    modeTabs.forEach(t => t.classList.toggle('active', t === tab));
    const mode = tab.dataset.mode;
    const isDesign = mode === 'design';
    // Design-only chrome (toolbar, zoom, props panel, rulers) is hidden via this class
    document.body.classList.toggle('design-mode', isDesign);
    designView.style.display = isDesign ? '' : 'none';
    modelBoard.style.display = mode === 'model' ? 'flex' : 'none';
    mockBoard.style.display = mode === 'mock' ? 'flex' : 'none';
    apiBoard.style.display = mode === 'api' ? 'flex' : 'none';
    colorBoard.style.display = mode === 'color' ? 'flex' : 'none';
    colorPanel.style.display = mode === 'color' ? 'flex' : 'none';
    typoBoard.style.display = mode === 'typography' ? 'flex' : 'none';
    typoPanel.style.display = mode === 'typography' ? 'flex' : 'none';
    if (mode === 'model') renderModels();
    if (mode === 'mock') renderMock();
    if (mode === 'api') renderApi();
    if (mode === 'color') renderColors();
    if (mode === 'typography') renderTypography();
    if (isDesign) render(); // refresh canvas in case color variables changed
  });
});

// Frame preset menu — opens above the frame tool button (toolbar is bottom-anchored)
const frameBtn = document.getElementById('tool-frame');
frameBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = frameMenu.style.display === 'block';
  closeMenus();
  if (open) return;
  frameMenu.style.display = 'block';
  const r = frameBtn.getBoundingClientRect();
  let left = r.left + r.width / 2 - frameMenu.offsetWidth / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - frameMenu.offsetWidth - 8));
  frameMenu.style.left = left + 'px';
  frameMenu.style.top = (r.top - frameMenu.offsetHeight - 8) + 'px';
});

frameMenu.addEventListener('click', e => {
  const item = e.target.closest('.frame-menu-item');
  if (!item) return;
  const w = parseInt(item.dataset.w, 10);
  const h = parseInt(item.dataset.h, 10);
  const cx = canvasWrap.offsetWidth / 2;
  const cy = canvasWrap.offsetHeight / 2;
  const world = canvasToWorld(cx, cy);

  const node = makeNode('frame', world.x - w / 2, world.y - h / 2, w, h, null);
  state.nodes.push(node);
  state.selected.clear();
  state.selected.add(node.id);
  saveHistory();
  render();
  closeMenus();
});

// Design-tab theme preview switch (Dark / Light).
document.getElementById('theme-switch')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-themesw]');
  if (btn) applyTheme(btn.dataset.themesw);
});

// Full-screen gate shown when a shared project link is opened by someone who
// can't view it: sign in, request access, or "not found". Covers the editor
// chrome entirely (the editor never initializes in this case).
function showAccessScreen(kind, projectId) {
  const el = document.createElement('div');
  el.className = 'access-gate';

  const view = (icon, title, sub, actions) => `
    <div class="access-card">
      <div class="access-icon">${icon}</div>
      <div class="access-title">${title}</div>
      <div class="access-sub">${sub}</div>
      <div class="access-actions">${actions}</div>
    </div>`;

  const dashBtn = '<a class="access-btn ghost" href="/dashboard">Back to dashboard</a>';

  if (kind === 'signin') {
    const target = encodeURIComponent(`/editor/${projectId}`);
    el.innerHTML = view('\ud83d\udd12', 'Sign in to view this project',
      'This project is private. Sign in to request access to it.',
      `<a class="access-btn" href="/authentication?next=${target}">Sign in</a>`);
  } else if (kind === 'notfound') {
    el.innerHTML = view('\ud83d\udd0d', 'Project not found',
      'This project doesn\u2019t exist, or it was deleted.', dashBtn);
  } else { // denied
    el.innerHTML = view('\ud83d\udd12', 'You don\u2019t have access to this project',
      'Ask the owner for access \u2014 they\u2019ll see your request and can let you in.',
      `<button type="button" class="access-btn" id="access-request">Request access</button>${dashBtn}`);
  }

  document.body.appendChild(el);

  const requestBtn = el.querySelector('#access-request');
  requestBtn?.addEventListener('click', async () => {
    requestBtn.disabled = true;
    requestBtn.textContent = 'Sending\u2026';
    const res = await requestAccess(projectId);
    const card = el.querySelector('.access-card');
    if (res.ok) {
      card.innerHTML = `
        <div class="access-icon">\u2705</div>
        <div class="access-title">Request sent</div>
        <div class="access-sub">The owner will review your request. You\u2019ll be able to open the project once they grant access.</div>
        <div class="access-actions">${dashBtn}</div>`;
    } else if (res.status === 409) {
      // Already invited / requested / a member \u2014 tell them and offer a retry.
      card.innerHTML = `
        <div class="access-icon">\u23f3</div>
        <div class="access-title">${esc(res.error || 'Request already pending')}</div>
        <div class="access-sub">If you were just granted access, reload to open the project.</div>
        <div class="access-actions"><button type="button" class="access-btn" onclick="location.reload()">Reload</button>${dashBtn}</div>`;
    } else {
      requestBtn.disabled = false;
      requestBtn.textContent = 'Request access';
      showToast(res.error || 'Couldn\u2019t send the request');
    }
  });
}

// Boot \u2014 load the project named in ?id= before first paint. A shared link opened
// by someone without access shows the access screen instead of the editor; no id
// starts a fresh scratch canvas.
async function boot() {
  // The project id is a path segment: /editor/<id>.
  const match = window.location.pathname.match(/^\/editor\/([^/]+)/);
  const projectId = match ? decodeURIComponent(match[1]) : null;
  let serverContent = {}; // what the server holds at load, for the save baseline

  if (projectId) {
    if (!getAuth()) { showAccessScreen('signin', projectId); return; }
    const res = await getProject(projectId);
    if (res.status === 401) { window.location.href = '/authentication'; return; }
    if (res.status === 403) { showAccessScreen('denied', projectId); return; }
    if (res.status === 404) { showAccessScreen('notfound', projectId); return; }
    if (res.ok && res.data) {
      currentProjectId = projectId;
      state.projectId = projectId; // let image uploads (images.js) target this project
      currentVersion = res.data.document && res.data.document.version != null
        ? res.data.document.version : null;
      if (res.data.project && res.data.project.name) state.projectName = res.data.project.name;
      if (res.data.document && res.data.document.content) {
        serverContent = res.data.document.content;
        loadDocument(serverContent);
      }
    } else {
      showToast(res.error || 'Couldn\u2019t load this project');
    }
  }

  seedDefaults(); // fills any gaps (themes, white/black, default type style) after a load
  saveHistory();
  applyTransform();
  render();
  renderThemeSwitch();
  updateExportButton();
  if (projectNameInput) projectNameInput.value = state.projectName;

  if (currentProjectId) {
    startAutosave(serverContent);
    loadComments(); // pull existing comment threads for this project
    showToast('Project loaded');
  } else {
    showToast('Scaffold ready \u2014 press V to select, R for container, T for text');
  }
}
boot();
