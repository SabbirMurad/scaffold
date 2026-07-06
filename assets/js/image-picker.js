import { state, getNode, makeNode } from './state.js';
import { canvasToWorld, canAcceptChild, isSingleChild } from './nodes.js';
import { saveHistory } from './history.js';
import { render } from './render.js';
import { canvasWrap, esc, showToast } from './utils.js';
import { finalizeImages } from './images.js';

// Stock-image picker — searches the free Openverse API (https://openverse.org),
// a catalogue of openly-licensed images. No API key; CORS-enabled. The search is
// restricted to photographs (illustrations are excluded).
// A picked image is fetched and inlined as a data-URL so the design stays
// self-contained (same as an uploaded image), then dropped on the canvas as an
// "image" node — reusing the placement rules of the icon picker.
//
// A plain click adds one image immediately; Shift-click (or clicking while a
// selection exists) toggles a multi-select, and the action bar adds them all.

const API = 'https://api.openverse.org/v1/images/';
const MAX = 320;      // largest side of a freshly-placed image, in canvas px
const CASCADE = 24;   // px offset between images placed together, so they don't fully overlap

let modal, searchInput, results, uploadBtn, closeBtn, actionBar, countEl, addBtn, clearBtn;
let searchToken = 0; // guards against out-of-order async responses
let debounce;
let seeded = false;
// Pagination state for the infinite-scroll grid.
let curQuery = '', curPage = 0, totalPages = 1, loading = false;
const selected = new Map(); // thumbnail src -> { w, h }

function msg(text) { results.innerHTML = `<div class="icon-msg">${esc(text)}</div>`; }

function tileHtml(it) {
  return `<button class="img-tile" data-src="${esc(it.thumbnail)}" data-w="${it.width || 0}" data-h="${it.height || 0}" title="${esc(it.title || '')}">
       <img src="${esc(it.thumbnail)}" alt="" loading="lazy">
     </button>`;
}

// ───────── Multi-select ─────────
function updateActionBar() {
  if (!actionBar) return;
  const n = selected.size;
  actionBar.hidden = n === 0;
  if (n) countEl.textContent = `${n} selected`;
}

function toggleSelect(tile) {
  const src = tile.dataset.src;
  if (selected.has(src)) { selected.delete(src); tile.classList.remove('selected'); }
  else { selected.set(src, { w: +tile.dataset.w, h: +tile.dataset.h }); tile.classList.add('selected'); }
  updateActionBar();
}

function clearSelection() {
  selected.clear();
  results.querySelectorAll('.img-tile.selected').forEach(t => t.classList.remove('selected'));
  updateActionBar();
}

// ───────── Search ─────────

// Openverse validates every result's link is still live before returning; that
// step intermittently fails with 424 (Failed Dependency). `filter_dead=false`
// skips it, and we retry a couple of times as a guard against a transient 424/5xx.
async function fetchWithRetry(url, tries = 3) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await fetch(url);
    if (res.ok || (res.status !== 424 && res.status < 500)) return res;
    await new Promise(r => setTimeout(r, 250 * (i + 1)));
  }
  return res;
}

// One page of photo results. Openverse pages are 1-indexed and page_size is
// capped at 20 for anonymous use; illustrations are intentionally excluded.
function fetchPage(q, page) {
  return fetchWithRetry(`${API}?q=${encodeURIComponent(q)}&page_size=20&page=${page}&mature=false&filter_dead=false&category=photograph`);
}

// Fresh search — resets pagination and replaces the grid.
async function runSearch() {
  clearSelection(); // results are about to change; drop any pending picks
  const q = searchInput.value.trim();
  curQuery = q; curPage = 0; totalPages = 1;
  if (!q) { msg('Type to search free stock photos.'); return; }
  const token = ++searchToken;
  msg('Searching…');
  try {
    const res = await fetchPage(q, 1);
    if (token !== searchToken) return; // a newer search superseded this one
    if (!res.ok) { msg('The image service is busy right now — please try again in a moment.'); return; }
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) { msg('No images found — try another search.'); return; }
    curPage = 1;
    totalPages = data.page_count || 1;
    results.innerHTML = items.map(tileHtml).join('');
    results.scrollTop = 0;
  } catch {
    if (token === searchToken) msg('Could not reach the image service — check your connection.');
  }
}

// Infinite scroll — append the next page as the grid nears its bottom.
async function loadMore() {
  if (loading || curPage === 0 || curPage >= totalPages) return;
  loading = true;
  const token = searchToken; // tie this fetch to the active search
  try {
    const res = await fetchPage(curQuery, curPage + 1);
    if (token !== searchToken || !res.ok) return; // superseded, or transient — a later scroll retries
    const data = await res.json();
    if (token !== searchToken) return;
    curPage += 1;
    totalPages = data.page_count || totalPages;
    results.insertAdjacentHTML('beforeend', (data.results || []).map(tileHtml).join(''));
  } catch {
    /* ignore; scrolling again retries */
  } finally {
    loading = false;
  }
}

// ───────── Placement ─────────
function fit(natW, natH) {
  let w = natW || MAX, h = natH || MAX;
  if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  return { w, h };
}

// The container images should drop into, if a single acceptable one is selected.
function currentParent() {
  if (state.selected.size !== 1) return null;
  const s = getNode([...state.selected][0]);
  return s && canAcceptChild(s) ? s : null;
}

function addImageNode(src, natW, natH, parent, index) {
  const { w, h } = fit(natW, natH);
  const off = index * CASCADE;
  let x, y;
  if (parent) {
    if (isSingleChild(parent)) { x = 0; y = 0; }
    else { x = parent.w / 2 - w / 2 + off; y = parent.h / 2 - h / 2 + off; }
  } else {
    const world = canvasToWorld(canvasWrap.offsetWidth / 2, canvasWrap.offsetHeight / 2);
    x = world.x - w / 2 + off; y = world.y - h / 2 + off;
  }
  const node = makeNode('image', x, y, w, h, parent ? parent.id : null);
  node.src = src;
  if (parent) parent.children.push(node.id);
  state.nodes.push(node);
  return node;
}

function placeImage(src, natW, natH) {
  const node = addImageNode(src, natW, natH, currentParent(), 0);
  state.selected.clear(); state.selected.add(node.id);
  saveHistory(); render();
  finalizeImages(); // inline data URI → uploaded ref (remote-URL fallback left as-is)
}

function placeImages(items) {
  let parent = currentParent();
  if (parent && isSingleChild(parent)) parent = null; // a frame/container holds only one child
  state.selected.clear();
  items.forEach((it, i) => state.selected.add(addImageNode(it.src, it.w, it.h, parent, i).id));
  saveHistory(); render();
  finalizeImages(); // inline data URIs → uploaded refs (remote-URL fallbacks left as-is)
}

// Fetch an image and inline it as a data-URL so the project is self-contained;
// on failure (e.g. CORS) fall back to the remote URL.
async function toDataUrl(src) {
  try {
    const res = await fetch(src);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch { return src; }
}

async function pickSingle(tile) {
  const w = +tile.dataset.w, h = +tile.dataset.h;
  close();
  showToast('Adding image…');
  placeImage(await toDataUrl(tile.dataset.src), w, h);
  showToast('Image added');
}

async function addSelected() {
  if (!selected.size) return;
  const items = [...selected.entries()].map(([src, d]) => ({ src, w: d.w, h: d.h }));
  close();
  const n = items.length;
  showToast(`Adding ${n} image${n > 1 ? 's' : ''}…`);
  const resolved = await Promise.all(items.map(async it => ({ ...it, src: await toDataUrl(it.src) })));
  placeImages(resolved);
  showToast(`Added ${n} image${n > 1 ? 's' : ''}`);
}

function open() {
  modal.hidden = false;
  searchInput.focus(); searchInput.select();
  if (!seeded) { seeded = true; searchInput.value = 'nature'; }
  runSearch();
}

function close() { modal.hidden = true; clearSelection(); }

export function initImagePicker() {
  modal = document.getElementById('image-modal');
  if (!modal) return; // not on this page
  searchInput = document.getElementById('image-search');
  results = document.getElementById('image-results');
  uploadBtn = document.getElementById('image-upload');
  closeBtn = document.getElementById('image-close');
  actionBar = document.getElementById('image-action-bar');
  countEl = document.getElementById('image-selcount');
  addBtn = document.getElementById('image-add-sel');
  clearBtn = document.getElementById('image-clear-sel');

  searchInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(runSearch, 300); });
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(debounce); runSearch(); } });

  // Infinite scroll: fetch the next page as the grid nears its bottom.
  results.addEventListener('scroll', () => {
    if (results.scrollTop + results.clientHeight >= results.scrollHeight - 240) loadMore();
  });

  // Plain click adds one; Shift-click (or clicking while a selection exists) toggles multi-select.
  results.addEventListener('click', e => {
    const tile = e.target.closest('.img-tile');
    if (!tile) return;
    if (e.shiftKey || selected.size > 0) toggleSelect(tile);
    else pickSingle(tile);
  });

  addBtn?.addEventListener('click', addSelected);
  clearBtn?.addEventListener('click', clearSelection);

  // "Upload from device" bridges to the existing hidden file input (app.js owns
  // its change handler that scales + places the local image).
  uploadBtn?.addEventListener('click', () => { close(); document.getElementById('image-input')?.click(); });

  // The toolbar Image tool opens this picker.
  document.getElementById('tool-image')?.addEventListener('click', open);

  closeBtn?.addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) { e.stopPropagation(); close(); } });
}
