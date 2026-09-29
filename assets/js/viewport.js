// Per-project canvas viewport (pan + zoom) persisted in localStorage — a purely
// local view preference, so a reload / reopen returns to the same spot and zoom.
// Not part of the design document (never saved to the server).

import { state } from './state.js';

// One per page (pages.js), so each page reopens where it was left. Views saved
// before pages existed are the first page's.
const KEY = (id, page) => 'ff_viewport_' + id + (page ? ':' + page : '');

export function saveViewport(pageId = state.activePageId) {
  if (!state.projectId) return; // unsaved scratch session — nothing to key on
  try {
    localStorage.setItem(KEY(state.projectId, pageId), JSON.stringify({
      panX: state.panX, panY: state.panY, zoom: state.zoom,
    }));
  } catch { /* storage unavailable */ }
}

// Debounced save, called from applyTransform on every pan/zoom change.
let timer = null;
export function saveViewportSoon() {
  clearTimeout(timer);
  timer = setTimeout(saveViewport, 400);
}

// Restore a project's saved viewport into state (before the first paint). No-op if
// none is stored or the values look invalid.
// Returns whether a saved view was found for the open page.
export function restoreViewport() {
  if (!state.projectId) return false;
  try {
    const first = state.pages.length && state.pages[0].id === state.activePageId;
    const raw = localStorage.getItem(KEY(state.projectId, state.activePageId))
      || (first ? localStorage.getItem(KEY(state.projectId)) : null);
    const v = JSON.parse(raw);
    if (v && Number.isFinite(v.panX) && Number.isFinite(v.panY) && Number.isFinite(v.zoom) && v.zoom > 0) {
      state.panX = v.panX;
      state.panY = v.panY;
      state.zoom = v.zoom;
      return true;
    }
  } catch { /* ignore malformed entry */ }
  return false;
}
