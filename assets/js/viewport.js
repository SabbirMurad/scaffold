// The canvas view (pan + zoom), one per page (pages.js), so each page reopens
// where it was left. It's this person's own — saved for them on the server
// (PUT /v1/project/:id/view → their project_user_state), so any computer they
// sign in on reopens there, and in localStorage for an instant first paint
// (and for a public view link, which has no account). Never part of the shared
// design document: one person panning moves nobody else's view.

import { state } from './state.js';
import { saveProjectView } from './projects.js';

// Views saved before pages existed are the first page's.
const KEY = (id, page) => 'ff_viewport_' + id + (page ? ':' + page : '');
const SERVER_DELAY = 1500; // after the last pan / zoom: one save per pause, not per frame

let serverViews = {};      // page id → view, as the server has them (from the project load)
const pending = new Map(); // page id → view not yet sent
let serverTimer = null;

const valid = (v) => v && Number.isFinite(v.panX) && Number.isFinite(v.panY) && Number.isFinite(v.zoom) && v.zoom > 0;

// The views the project load brought (this person's, by page).
export function setServerViews(views) {
  serverViews = views && typeof views === 'object' ? { ...views } : {};
}

export function saveViewport(pageId = state.activePageId) {
  if (!state.projectId) return; // unsaved scratch session — nothing to key on
  const view = { panX: state.panX, panY: state.panY, zoom: state.zoom };
  try { localStorage.setItem(KEY(state.projectId, pageId), JSON.stringify(view)); } catch { /* storage unavailable */ }
  if (state.publicToken || !pageId) return; // a public link has no account to save to
  pending.set(pageId, view);
  serverViews[pageId] = view;
  clearTimeout(serverTimer);
  serverTimer = setTimeout(flushViews, SERVER_DELAY);
}

// Send the views waiting to be saved (also when leaving the page or project).
export function flushViews() {
  clearTimeout(serverTimer);
  const id = state.projectId;
  if (!id) return;
  pending.forEach((view, page) => { saveProjectView(id, page, view).catch(() => { /* local copy still has it */ }); });
  pending.clear();
}

// Debounced save, called from applyTransform on every pan/zoom change.
let timer = null;
export function saveViewportSoon() {
  clearTimeout(timer);
  timer = setTimeout(saveViewport, 400);
}

// Restore the open page's view into state (before the first paint): the one
// saved for this person on the server, else this computer's. Returns whether
// one was found.
export function restoreViewport() {
  if (!state.projectId) return false;
  let v = serverViews[state.activePageId];
  if (!valid(v)) {
    try {
      const first = state.pages.length && state.pages[0].id === state.activePageId;
      v = JSON.parse(localStorage.getItem(KEY(state.projectId, state.activePageId))
        || (first ? localStorage.getItem(KEY(state.projectId)) : null));
    } catch { v = null; }
  }
  if (!valid(v)) return false;
  state.panX = v.panX;
  state.panY = v.panY;
  state.zoom = v.zoom;
  return true;
}

// Leaving the editor (closing, reloading, opening another project): save now.
window.addEventListener('pagehide', flushViews);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushViews(); });
