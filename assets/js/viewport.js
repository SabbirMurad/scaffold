// Per-project canvas viewport (pan + zoom) persisted in localStorage — a purely
// local view preference, so a reload / reopen returns to the same spot and zoom.
// Not part of the design document (never saved to the server).

import { state } from './state.js';

const KEY = (id) => 'ff_viewport_' + id;

export function saveViewport() {
  if (!state.projectId) return; // unsaved scratch session — nothing to key on
  try {
    localStorage.setItem(KEY(state.projectId), JSON.stringify({
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
export function restoreViewport() {
  if (!state.projectId) return;
  try {
    const v = JSON.parse(localStorage.getItem(KEY(state.projectId)));
    if (v && Number.isFinite(v.panX) && Number.isFinite(v.panY) && Number.isFinite(v.zoom) && v.zoom > 0) {
      state.panX = v.panX;
      state.panY = v.panY;
      state.zoom = v.zoom;
    }
  } catch { /* ignore malformed entry */ }
}
