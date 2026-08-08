// Real-time collaboration client. Instead of periodically POSTing the document,
// the editor now streams committed changes over a WebSocket: when an action is
// *finished* (a drag ends, an edit commits — anything that calls saveHistory) the
// changed document slices are sent; the server persists them and relays them to
// everyone else viewing the project, who apply them live without a reload.
//
// In-progress motion is never sent — only commits are — because the mid-drag path
// updates the DOM live but doesn't call saveHistory, so no `doc:commit` fires.

import { state } from './state.js';
import { serializeDocument } from './history.js';
import { render } from './render.js';
import { getAuth } from './session.js';

let projectId = null;
let ws = null;
let baseline = {};          // sliceKey → JSON string we consider already in sync
let commitTimer = null;
let reconnectTimer = null;
let closed = false;         // true once we intentionally tear down (page leaving)
let pointerDown = false;    // defer remote applies while the user is mid-interaction
let pendingRemote = null;   // latest remote slices stashed while pointerDown

const COMMIT_DEBOUNCE = 200; // ms after a commit before we flush (coalesces bursts)

// Open the collaboration channel for a loaded project. `serverContent` is what the
// server held at load, so anything the client seeded/migrated on top counts as
// dirty and gets pushed as soon as the socket opens.
export function initCollab(id, serverContent) {
  projectId = id;
  baseline = {};
  const server = serverContent || {};
  for (const key in server) baseline[key] = JSON.stringify(server[key]);

  document.addEventListener('doc:commit', scheduleFlush);
  document.addEventListener('mousedown', () => { pointerDown = true; }, true);
  document.addEventListener('mouseup', () => {
    pointerDown = false;
    if (pendingRemote) { const slices = pendingRemote; pendingRemote = null; applyRemote(slices); }
  }, true);
  window.addEventListener('beforeunload', () => { closed = true; flushNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });

  connect();
}

function socketUrl() {
  const token = (getAuth() && getAuth().access_token) || '';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/v1/ws/project/${encodeURIComponent(projectId)}?token=${encodeURIComponent(token)}`;
}

function connect() {
  if (closed) return;
  try {
    ws = new WebSocket(socketUrl());
  } catch (error) {
    console.error('collab: socket open failed', error);
    scheduleReconnect();
    return;
  }
  ws.addEventListener('open', flushNow);       // push anything pending since load
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', () => { if (!closed) scheduleReconnect(); });
  ws.addEventListener('error', () => { try { ws.close(); } catch (e) { /* noop */ } });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

function onMessage(event) {
  let data;
  try { data = JSON.parse(event.data); } catch (error) { return; }
  if (data.type === 'doc_update' && data.payload && data.payload.slices) {
    // Don't repaint over an active drag/resize — stash and apply on mouseup.
    if (pointerDown) pendingRemote = { ...(pendingRemote || {}), ...data.payload.slices };
    else applyRemote(data.payload.slices);
  }
  // `presence` messages are received too; no UI is wired to them yet.
}

// ── outgoing: send the slices that changed since the last flush ──
function scheduleFlush() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(flushNow, COMMIT_DEBOUNCE);
}

function flushNow() {
  clearTimeout(commitTimer);
  const patch = computePatch();
  if (!patch) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'doc_update', payload: { slices: patch } }));
  } else {
    fallbackSave(patch); // socket down → persist over HTTP so nothing is lost
  }
}

// Diff the live document against the baseline; return only the changed slices and
// advance the baseline. Returns null when nothing changed.
function computePatch() {
  const doc = serializeDocument();
  const patch = {};
  let dirty = false;
  for (const key in doc) {
    const json = JSON.stringify(doc[key]);
    if (json !== baseline[key]) { patch[key] = doc[key]; baseline[key] = json; dirty = true; }
  }
  return dirty ? patch : null;
}

// ── incoming: fold a peer's committed change into local state and repaint ──
function applyRemote(slices) {
  state.collabApplying = true;
  for (const key in slices) {
    state[key] = slices[key];
    baseline[key] = JSON.stringify(slices[key]); // in sync now — never echo it back
  }
  // A selection pointing at a node the peer deleted would dangle — prune it.
  if (slices.nodes) {
    const ids = new Set(state.nodes.map(n => n.id));
    [...state.selected].forEach(id => { if (!ids.has(id)) state.selected.delete(id); });
  }
  render();
  document.dispatchEvent(new Event('collab:applied')); // refresh the active side tab
  state.collabApplying = false;
}

// Last-resort persistence when the socket isn't open. Imported lazily to avoid a
// load-time dependency cycle with the project API client.
async function fallbackSave(patch) {
  try {
    const { saveProjectDoc } = await import('./projects.js');
    await saveProjectDoc(projectId, patch, null);
  } catch (error) {
    console.error('collab: fallback save failed', error);
  }
}
