// Comment tool (Figma-style). With the Comment tool active the canvas becomes a
// commenting surface: click anywhere to drop a pin and start a thread; click an
// existing pin to read/reply, resolve, or delete it. Pins are an overlay pinned
// to world coordinates (so they pan/zoom with the canvas) but counter-scaled so
// they stay a constant on-screen size.
//
// Threads are persisted per project (see projects.js / the /comments endpoints):
// loaded when the project opens and each time the Comment tool is activated, and
// written through on create/reply/resolve/delete. An unsaved scratch session (no
// project id) keeps the old session-only behaviour.

import { state } from './state.js';
import { canvas, canvasWrap, esc, showToast } from './utils.js';
import { listComments, createComment, replyComment, resolveComment, deleteComment, getPublicComments } from './projects.js';

// Local thread shape: { id (client handle), serverId (null until saved), x, y,
// resolved, messages: [{ author, text, ts }] }.
let comments = [];
let seq = 0;
let layer;              // #comment-layer overlay inside #canvas
let activeId = null;    // the open thread's comment id
let author = 'You';
let pop, popTitle, thread, input, sendBtn, resolveBtn, delBtn, closeBtn;

const get = id => comments.find(c => c.id === id);
const isDraft = c => c && c.messages.length === 0;

// Map a server thread → local shape (server messages carry author_name/created_at).
function fromServer(t) {
  return {
    id: 'cm' + (++seq),
    serverId: t.uuid,
    x: t.x, y: t.y,
    resolved: !!t.resolved,
    messages: (t.messages || []).map(m => ({ author: m.author_name, text: m.text, ts: m.created_at })),
  };
}
// Fold a server thread back into an existing local one, keeping its client id.
function applyServer(c, t) {
  c.serverId = t.uuid;
  c.x = t.x; c.y = t.y;
  c.resolved = !!t.resolved;
  c.messages = (t.messages || []).map(m => ({ author: m.author_name, text: m.text, ts: m.created_at }));
}

// Load the project's threads from the server. No-op (keeps local state) for an
// unsaved scratch session. Called on project open and on Comment-tool activation;
// a thread is never open at those moments, so replacing the array is safe.
export async function loadComments() {
  if (!state.projectId && !state.publicToken) return;
  const res = state.publicToken ? await getPublicComments(state.publicToken) : await listComments(state.projectId);
  if (!res.ok || !Array.isArray(res.data)) return;
  comments = res.data.map(fromServer);
  drawPins();
}

function worldOf(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left) / state.zoom, y: (clientY - r.top) / state.zoom };
}

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

function ensureLayer() {
  if (!layer || !layer.isConnected) {
    layer = document.createElement('div');
    layer.id = 'comment-layer';
    canvas.appendChild(layer);
  }
  canvas.appendChild(layer); // keep above the re-rendered nodes
  return layer;
}

// Pins carry the thread's ordinal number (resolved ones show a check).
function drawPins() {
  if (state.tool !== 'comment') { if (layer) layer.style.display = 'none'; return; }
  const el = ensureLayer();
  el.style.display = '';
  let n = 0;
  el.innerHTML = comments.map(c => {
    const label = c.resolved ? '&#10003;' : (c.messages.length ? ++n : '');
    return `<button class="comment-pin${c.resolved ? ' resolved' : ''}${activeId === c.id ? ' active' : ''}" data-id="${c.id}" style="left:${c.x}px;top:${c.y}px">${label}</button>`;
  }).join('');
}

// ── thread popover ──
function renderThread(c) {
  popTitle.textContent = c.messages.length ? `Comment ${threadNumber(c)}` : 'New comment';
  resolveBtn.classList.toggle('on', !!c.resolved);
  resolveBtn.title = c.resolved ? 'Reopen' : 'Resolve';
  thread.innerHTML = c.messages.map(m => `
    <div class="cmt-msg">
      <div class="cmt-ava">${esc((m.author[0] || '?').toUpperCase())}</div>
      <div class="cmt-msg-body">
        <div class="cmt-msg-meta"><span class="cmt-author">${esc(m.author)}</span><span class="cmt-time">${esc(relTime(m.ts))}</span></div>
        <div class="cmt-msg-text">${esc(m.text)}</div>
      </div>
    </div>`).join('');
  thread.hidden = c.messages.length === 0;
  thread.scrollTop = thread.scrollHeight;
  input.placeholder = c.messages.length ? 'Reply…' : 'Add a comment…';
}
function threadNumber(target) {
  let n = 0;
  for (const c of comments) { if (c.messages.length) { n++; if (c === target) return n; } }
  return '';
}

function openThread(id) {
  const c = get(id);
  if (!c) return;
  activeId = id;
  renderThread(c);
  pop.hidden = false;
  drawPins();
  positionPopover();
  input.value = '';
  input.style.height = '';
  input.focus();
}

function closeThread() {
  const c = get(activeId);
  if (isDraft(c)) comments = comments.filter(x => x !== c); // discard an unsent draft
  activeId = null;
  pop.hidden = true;
  drawPins();
}

async function sendMessage() {
  const c = get(activeId);
  if (!c) return;
  const text = input.value.trim();
  if (!text) return;

  // Unsaved scratch session → keep the session-only behaviour (no persistence).
  if (!state.projectId) {
    c.messages.push({ author, text, ts: Date.now() });
    input.value = ''; input.style.height = '';
    renderThread(c); drawPins(); positionPopover();
    return;
  }

  // First message creates the thread; later ones are replies. Server-derived
  // author name + ids come back on the thread, so we render from its response.
  input.disabled = true; sendBtn.disabled = true;
  const res = c.serverId
    ? await replyComment(state.projectId, c.serverId, text)
    : await createComment(state.projectId, c.x, c.y, text);
  input.disabled = false; sendBtn.disabled = false;

  if (res.ok && res.data) {
    applyServer(c, res.data);
    input.value = ''; input.style.height = '';
    renderThread(c); drawPins(); positionPopover();
    input.focus();
  } else {
    showToast(res.error || 'Couldn’t post comment');
  }
}

function positionPopover() {
  if (!pop || pop.hidden || activeId == null) return;
  const pin = layer?.querySelector(`.comment-pin[data-id="${activeId}"]`);
  if (!pin) { pop.hidden = true; return; }
  const r = pin.getBoundingClientRect();
  const pw = pop.offsetWidth || 260, ph = pop.offsetHeight || 200;
  let left = r.right + 10;
  if (left + pw > window.innerWidth - 8) left = r.left - pw - 10;
  let top = r.top;
  if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}

// ── canvas interaction (only while the Comment tool is active) ──
function onClick(e) {
  if (state.tool !== 'comment' || e.button !== 0) return;
  const pin = e.target.closest && e.target.closest('.comment-pin');
  if (pin) { e.stopPropagation(); openThread(pin.dataset.id); return; }
  e.stopPropagation();
  if (state.publicToken) return; // a public viewer reads threads, never starts one
  // Empty canvas → drop a new pin and start composing.
  const p = worldOf(e.clientX, e.clientY);
  if (isDraft(get(activeId))) closeThread(); // drop any previous unsent draft
  const c = { id: 'cm' + (++seq), serverId: null, x: p.x, y: p.y, resolved: false, messages: [] };
  comments.push(c);
  drawPins();
  openThread(c.id);
}

export function initComments() {
  if (!canvas) return;
  pop = document.getElementById('comment-popover');
  popTitle = document.getElementById('cmt-title');
  thread = document.getElementById('cmt-thread');
  input = document.getElementById('cmt-input');
  sendBtn = document.getElementById('cmt-send');
  resolveBtn = document.getElementById('cmt-resolve');
  delBtn = document.getElementById('cmt-delete');
  closeBtn = document.getElementById('cmt-close');
  author = document.getElementById('profile-name')?.textContent.trim() || 'You';

  canvasWrap.addEventListener('click', onClick, true); // capture so wrap/node handlers stay out of it

  sendBtn?.addEventListener('click', sendMessage);
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  // Grow the composer with its content. scrollHeight excludes the border, so add
  // it back (box-sizing: border-box) — otherwise the field keeps a 2px scroll.
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    const border = input.offsetHeight - input.clientHeight;
    input.style.height = Math.min(120, input.scrollHeight + border) + 'px';
  });

  resolveBtn?.addEventListener('click', async () => {
    const c = get(activeId); if (!c || isDraft(c)) return;
    const next = !c.resolved;
    c.resolved = next; renderThread(c); drawPins();          // optimistic
    if (!state.projectId || !c.serverId) return;             // scratch session
    const res = await resolveComment(state.projectId, c.serverId, next);
    if (!res.ok) { c.resolved = !next; renderThread(c); drawPins(); showToast(res.error || 'Couldn’t update comment'); }
  });
  delBtn?.addEventListener('click', async () => {
    const c = get(activeId); if (!c) return;
    // An unsent draft (or scratch session) is only local → just drop it.
    if (!state.projectId || !c.serverId) {
      comments = comments.filter(x => x !== c);
      activeId = null; pop.hidden = true; drawPins();
      return;
    }
    const res = await deleteComment(state.projectId, c.serverId);
    if (res.ok) {
      comments = comments.filter(x => x !== c);
      activeId = null; pop.hidden = true; drawPins();
    } else {
      showToast(res.error || 'Couldn’t delete comment'); // e.g. non-owner → 403
    }
  });
  closeBtn?.addEventListener('click', closeThread);

  document.addEventListener('keydown', e => {
    if (state.tool !== 'comment' || activeId == null) return;
    const tag = document.activeElement.tagName;
    if (e.key === 'Escape') { e.stopPropagation(); if (tag !== 'TEXTAREA' || !input.value) closeThread(); }
  }, true);

  document.addEventListener('flow:render', drawPins); // redraw pins after a canvas render
  document.addEventListener('tool:change', e => {
    if (e.detail !== 'comment') { closeThread(); drawPins(); return; }
    loadComments(); // refresh threads (and pins) each time the tool is opened
  });

  (function tick() { positionPopover(); requestAnimationFrame(tick); })();
}
