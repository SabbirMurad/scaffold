// Pages: separate canvases in one project — at first one for the phone app and
// one for the web — shown in the Pages panel above Layers. Each page is either
// "phone" or "web"; the only difference is the screen sizes the frame tool
// offers. Only the active page's contents are drawn and listed.
//
// The page list is part of the design document (state.pages, synced and saved);
// each top-level node carries the id of the page it's on (node.pageId — nodes
// inside it are on the same page as their top-level ancestor). Which page is
// open is this person's own view, remembered per project on this machine.

import { state, getNode } from './state.js';
import { confirmModal } from './confirm.js';

export const KINDS = { phone: 'Phone', web: 'Web' };
const MAX_NAME = 40;
const ACTIVE_KEY = (projectId) => 'ff_page_' + projectId;

// ── model ────────────────────────────────────────────────────────────────────
export const activePage = () => state.pages.find(p => p.id === state.activePageId) || state.pages[0] || null;
export const pageKind = () => (activePage() || {}).kind || 'phone';

// The page a node is on: its top-level ancestor's.
export function pageOf(node) {
  let n = node;
  while (n && n.parentId) n = getNode(n.parentId);
  return n ? n.pageId : null;
}
export const onActivePage = (node) => !!node && pageOf(node) === state.activePageId;

// A page's top-level nodes — by default the open page's (what the canvas draws
// and Layers lists).
export const pageRoots = (pageId = state.activePageId) => state.nodes.filter(n => !n.parentId && n.pageId === pageId);

// Where new top-level nodes go when it isn't the page being viewed: set while
// Claude's tools run (claude-tools.js), so its work lands on the page it's
// working on even if the person switches pages meanwhile.
let rootTarget = null;
export function setRootTarget(pageId) { rootTarget = pageId || null; }

// Seed the starting pages for a project that has none (every project before
// pages existed), and pick the open page. Called with the other defaults.
export function seedPages() {
  if (!Array.isArray(state.pages) || !state.pages.length) {
    state.pages = [
      { id: 'pg' + state.nextPageId++, name: 'Phone', kind: 'phone' },
      { id: 'pg' + state.nextPageId++, name: 'Web', kind: 'web' },
    ];
  }
  if (!state.pages.some(p => p.id === state.activePageId)) {
    let saved = null;
    try { saved = state.projectId && localStorage.getItem(ACTIVE_KEY(state.projectId)); } catch { /* storage unavailable */ }
    state.activePageId = state.pages.some(p => p.id === saved) ? saved : state.pages[0].id;
  }
}

// Keep every top-level node on a page. A new one (made by a tool, pasted, moved
// out of its parent, or from an older version) goes on the page being viewed
// (or, while Claude's tools run, the page Claude is working on);
// nodes inside others don't keep a page of their own. Run before each render.
export function assignPages() {
  if (!state.pages.length) seedPages();
  if (!state.pages.some(p => p.id === state.activePageId)) state.activePageId = state.pages[0].id;
  const valid = new Set(state.pages.map(p => p.id));
  const target = valid.has(rootTarget) ? rootTarget : state.activePageId;
  for (const n of state.nodes) {
    if (n.parentId) { if ('pageId' in n) delete n.pageId; }
    else if (!valid.has(n.pageId)) n.pageId = target;
  }
}

// ── the panel ────────────────────────────────────────────────────────────────
let hooks = { render: () => {}, saveHistory: () => {}, deleteNodes: () => {}, beforeSwitch: () => {}, afterSwitch: () => {}, toast: () => {} };
let listEl, addBtn;

const ICONS = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2.2"/><path d="M11 17.5h2"/></svg>',
  web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M8.5 20h7M12 16.5V20"/></svg>',
};
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initPages(options) {
  hooks = { ...hooks, ...options };
  listEl = document.getElementById('pages-list');
  addBtn = document.getElementById('page-add');
  if (!listEl) return;
  addBtn?.addEventListener('click', (e) => { e.stopPropagation(); openAddForm(); });
  listEl.addEventListener('click', (e) => {
    const menuBtn = e.target.closest('.page-more');
    const item = e.target.closest('.page-item');
    if (!item) return;
    if (menuBtn) { e.stopPropagation(); openMenu(item.dataset.id, menuBtn); return; }
    if (!e.target.closest('input')) switchPage(item.dataset.id);
  });
  listEl.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.page-item');
    if (item && !state.readonly) startRename(item.dataset.id);
  });
  listEl.addEventListener('keydown', (e) => {
    const item = e.target.closest('.page-item');
    if (!item || e.target.closest('input')) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchPage(item.dataset.id); }
    else if (e.key === 'F2' && !state.readonly) { e.preventDefault(); startRename(item.dataset.id); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.page-popover')) closePopovers(); });
}

export function renderPages() {
  if (!listEl) return;
  if (addBtn) addBtn.hidden = !!state.readonly;
  listEl.innerHTML = state.pages.map(p => `
    <div class="page-item${p.id === state.activePageId ? ' active' : ''}" data-id="${esc(p.id)}" role="option" tabindex="0"
         aria-selected="${p.id === state.activePageId}" title="${esc(KINDS[p.kind] || 'Phone')} page">
      <span class="page-icon">${ICONS[p.kind] || ICONS.phone}</span>
      <span class="page-name">${esc(p.name)}</span>
      <span class="page-kind">${esc(KINDS[p.kind] || 'Phone')}</span>
      ${state.readonly ? '' : '<button type="button" class="page-more" aria-label="Page options" title="Page options">⋯</button>'}
    </div>`).join('');
}

export function switchPage(id) {
  if (id === state.activePageId || !state.pages.some(p => p.id === id)) return;
  hooks.beforeSwitch(state.activePageId);
  state.activePageId = id;
  try { if (state.projectId) localStorage.setItem(ACTIVE_KEY(state.projectId), id); } catch { /* storage unavailable */ }
  state.selected.clear();
  hooks.render();
  hooks.afterSwitch(id);
}

// Show the page a node is on (e.g. going to a component's master elsewhere).
export function revealPageOf(node) {
  const id = pageOf(node);
  if (id && id !== state.activePageId) switchPage(id);
}

function nameError(name, exceptId = null) {
  if (!name) return 'Give the page a name';
  if (name.length > MAX_NAME) return `Keep the name within ${MAX_NAME} characters`;
  if (state.pages.some(p => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) return 'There\'s already a page with that name';
  return null;
}

// Add a page (from the form, or a tool). Returns the page, or an error message.
export function addPage(name, kind) {
  name = String(name || '').trim();
  const err = nameError(name);
  if (err) return { error: err };
  if (!KINDS[kind]) return { error: 'A page is either phone or web' };
  const page = { id: 'pg' + state.nextPageId++, name, kind };
  state.pages.push(page);
  hooks.saveHistory();
  switchPage(page.id);
  return { page };
}

function renamePage(id, name) {
  const page = state.pages.find(p => p.id === id);
  name = String(name || '').trim();
  if (!page || name === page.name) return null;
  const err = nameError(name, id);
  if (err) return err;
  page.name = name;
  hooks.saveHistory();
  hooks.render();
  return null;
}

async function deletePage(id) {
  const page = state.pages.find(p => p.id === id);
  if (!page) return;
  if (state.pages.length === 1) { hooks.toast('A project needs at least one page'); return; }
  const roots = state.nodes.filter(n => !n.parentId && n.pageId === id);
  const ok = await confirmModal({
    title: 'Delete page?',
    message: roots.length
      ? `“<strong>${esc(page.name)}</strong>” and everything on it will be deleted.`
      : `“<strong>${esc(page.name)}</strong>” will be deleted.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  if (id === state.activePageId) switchPage(state.pages.find(p => p.id !== id).id);
  state.pages = state.pages.filter(p => p.id !== id);
  // The page's contents go the way a normal delete does (instances of its
  // components elsewhere become plain copies; one undo step).
  hooks.deleteNodes(roots.map(n => n.id));
}

// ── rename in place ──────────────────────────────────────────────────────────
function startRename(id) {
  const item = listEl.querySelector(`.page-item[data-id="${CSS.escape(id)}"]`);
  const page = state.pages.find(p => p.id === id);
  if (!item || !page) return;
  const nameEl = item.querySelector('.page-name');
  const input = Object.assign(document.createElement('input'), { type: 'text', value: page.name, className: 'page-rename', maxLength: MAX_NAME });
  input.setAttribute('aria-label', 'Page name');
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const err = commit ? renamePage(id, input.value) : null;
    if (err) hooks.toast(err);
    renderPages();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ── popovers: page menu, add form ────────────────────────────────────────────
function closePopovers() { document.querySelectorAll('.page-popover').forEach(p => p.remove()); }

function place(pop, anchor) {
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
}

function openMenu(id, anchor) {
  closePopovers();
  const pop = document.createElement('div');
  pop.className = 'page-popover page-menu';
  pop.setAttribute('role', 'menu');
  pop.innerHTML = '<button type="button" role="menuitem" data-act="rename">Rename</button>'
    + `<button type="button" role="menuitem" data-act="delete" class="danger"${state.pages.length === 1 ? ' disabled title="A project needs at least one page"' : ''}>Delete page</button>`;
  pop.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    closePopovers();
    if (act === 'rename') startRename(id);
    else if (act === 'delete') deletePage(id);
  });
  place(pop, anchor);
  pop.querySelector('button').focus();
}

function openAddForm() {
  if (state.readonly) return;
  const open = document.querySelector('.page-add-form');
  closePopovers();
  if (open) return; // the + toggles it
  const pop = document.createElement('form');
  pop.className = 'page-popover page-add-form';
  pop.innerHTML = `
    <label class="page-form-label" for="page-new-name">New page</label>
    <input id="page-new-name" type="text" maxlength="${MAX_NAME}" placeholder="e.g. Admin dashboard" autocomplete="off" spellcheck="false">
    <div class="page-kind-pick" role="radiogroup" aria-label="Page type">
      <button type="button" role="radio" aria-checked="true" data-kind="phone" class="active">${ICONS.phone}Phone</button>
      <button type="button" role="radio" aria-checked="false" data-kind="web">${ICONS.web}Web</button>
    </div>
    <div class="page-form-error" hidden></div>
    <div class="page-form-actions">
      <button type="button" class="page-form-cancel">Cancel</button>
      <button type="submit" class="page-form-add">Add page</button>
    </div>`;
  let kind = 'phone';
  pop.querySelector('.page-kind-pick').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-kind]');
    if (!btn) return;
    kind = btn.dataset.kind;
    pop.querySelectorAll('[data-kind]').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-checked', String(b === btn));
    });
  });
  pop.querySelector('.page-form-cancel').addEventListener('click', closePopovers);
  pop.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closePopovers(); });
  pop.addEventListener('submit', (e) => {
    e.preventDefault();
    const res = addPage(pop.querySelector('#page-new-name').value, kind);
    if (res.error) {
      const errEl = pop.querySelector('.page-form-error');
      errEl.textContent = res.error;
      errEl.hidden = false;
      return;
    }
    closePopovers();
  });
  place(pop, addBtn);
  pop.querySelector('#page-new-name').focus();
}
