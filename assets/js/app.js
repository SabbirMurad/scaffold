import { state, getNode, makeNode, seedDefaults } from './state.js';
import { canvasWrap, addMenu, frameMenu, closeMenus, showToast, esc } from './utils.js';
import { canvasToWorld, canAcceptChild, isSingleChild } from './nodes.js';
import { saveHistory } from './history.js';
import { render, applyTransform } from './render.js';
import { initCanvasEvents } from './canvas.js';
import { initToolEvents, setTool } from './tools.js';
import { findFrameAt, getWorldPos } from './nodes.js';
import { initModels, renderModels } from './models.js';
import { initApi, renderApi } from './api.js';
import { initColors, renderColors, renderThemeSwitch, applyTheme } from './colors.js';
import { initTypography, renderTypography } from './typography.js';
import { initMock, renderMock } from './mock.js';
import { exportModelsCode, collectExportables, dartPath } from './codegen.js';
import { updateExportButton } from './validate.js';
import { initDropdowns, ddTrigger } from './dropdown.js';
import { initIconPicker } from './icons-picker.js';
import { initFontPicker } from './google-fonts.js';
import { initImagePicker } from './image-picker.js';
import { initFlow } from './flow.js';
import { initComments } from './comments.js';
import { addShare, sharesFor, setShareRole, ROLES } from './shares.js';

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
    + group('theme', 'Theme', groups.hasTheme ? ['App colors & theme'] : []);
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

document.getElementById('export-confirm')?.addEventListener('click', () => {
  const selection = { models: new Set(), enums: new Set(), providers: new Set(), screens: new Set(), theme: new Set() };
  exportList.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => selection[cb.dataset.kind].add(cb.value));
  if (!selection.models.size && !selection.enums.size && !selection.providers.size && !selection.screens.size && !selection.theme.size) {
    showToast('Select at least one item to export');
    return;
  }
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
document.getElementById('nav-sync')?.addEventListener('click', () => showToast('Sync — coming soon'));
document.getElementById('nav-logout')?.addEventListener('click', () => { window.location.href = '/authentication'; });

// Share project — invite by email (the request shows up in the home Requests tab).
const shareModal = document.getElementById('share-modal');
const shareEmail = document.getElementById('share-email');
const shareRoleSlot = document.getElementById('share-role-slot');
const sharePeople = document.getElementById('share-people');
const sharePeopleList = document.getElementById('share-people-list');
const ROLE_LABEL = { viewer: 'Viewer', editor: 'Editor', owner: 'Owner' };
const ROLE_OPTS = ROLES.map(r => ({ value: r, label: ROLE_LABEL[r] }));

// The role picker beside the email input, reset to Editor each time we open.
function renderInviteRole() {
  if (shareRoleSlot) shareRoleSlot.innerHTML = ddTrigger({ value: 'editor', options: ROLE_OPTS, triggerClass: 'dd-share' });
}
const inviteRole = () => shareRoleSlot?.querySelector('.dd-trigger')?.dataset.ddValue || 'editor';

// A row per person the project is shared with, each with a role dropdown and a
// pending/accepted badge. Editing a role updates the stored share in place.
function renderSharePeople() {
  if (!sharePeople) return;
  const people = sharesFor(state.projectName);
  sharePeople.hidden = people.length === 0;
  sharePeopleList.innerHTML = people.map(p => {
    const badge = p.status === 'accepted'
      ? '<span class="share-badge accepted">Accepted</span>'
      : '<span class="share-badge pending">Pending</span>';
    const roleDd = ddTrigger({ value: p.role, options: ROLE_OPTS, data: { 'role-for': p.id }, triggerClass: 'dd-share' });
    return `<div class="share-person" data-id="${p.id}">
        <div class="share-ava">${esc((p.email[0] || '?').toUpperCase())}</div>
        <div class="share-person-info">
          <div class="share-person-email">${esc(p.email)}</div>
          ${badge}
        </div>
        ${roleDd}
      </div>`;
  }).join('');
}

// The dropdown controller updates data-dd-value but leaves the visible label to
// the consumer; sync it for every role picker inside the share modal.
shareModal?.addEventListener('dd:change', e => {
  const lbl = e.target.closest('.dd-trigger')?.querySelector('.dd-label');
  if (lbl) lbl.textContent = ROLE_LABEL[e.detail.value] || e.detail.value;
});

sharePeopleList?.addEventListener('dd:change', e => {
  const trig = e.target.closest('[data-role-for]');
  if (!trig) return;
  setShareRole(trig.dataset.roleFor, e.detail.value);
  const email = trig.closest('.share-person')?.querySelector('.share-person-email')?.textContent;
  showToast(`${email || 'Member'} is now ${ROLE_LABEL[e.detail.value] || e.detail.value}`);
});

const closeShare = () => { if (shareModal) { shareModal.hidden = true; document.getElementById('share-form')?.reset(); } };
document.getElementById('nav-share')?.addEventListener('click', () => { shareModal.hidden = false; renderInviteRole(); renderSharePeople(); shareEmail?.focus(); });
document.getElementById('share-close')?.addEventListener('click', closeShare);
document.getElementById('share-cancel')?.addEventListener('click', closeShare);
shareModal?.addEventListener('click', e => { if (e.target === shareModal) closeShare(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && shareModal && !shareModal.hidden) closeShare(); });
document.getElementById('share-form')?.addEventListener('submit', e => {
  e.preventDefault();
  const email = shareEmail.value.trim();
  if (!email) return;
  const role = inviteRole();
  addShare(email, state.projectName, role);
  shareEmail.value = '';
  renderInviteRole();
  renderSharePeople();
  showToast(`Invitation sent to ${email} as ${ROLE_LABEL[role] || role}`);
});

// Keep the export button's enabled/disabled state in sync with project validity.
// These events cover edits (input), commits (change), dropdown picks (dd:change),
// add/delete clicks, and undo/redo + delete keystrokes (keyup).
['input', 'change', 'dd:change', 'click', 'keyup'].forEach(ev =>
  document.addEventListener(ev, () => updateExportButton()));

// Project name (editable)
const projectNameInput = document.getElementById('project-name');
if (projectNameInput) {
  projectNameInput.value = state.projectName;
  projectNameInput.addEventListener('input', () => { state.projectName = projectNameInput.value; });
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

// Boot
seedDefaults(); // pre-create white/black colors + a default "body" type style
saveHistory();
applyTransform();
render();
renderThemeSwitch();
updateExportButton();
showToast('FrameForge ready \u2014 press V to select, R for container, T for text');
