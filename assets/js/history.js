import { state, repairCounters } from './state.js';
import { render } from './render.js';
import { renderModels } from './models.js';
import { renderApi } from './api.js';
import { renderColors, renderThemeSwitch } from './colors.js';
import { renderTypography } from './typography.js';
import { renderMock } from './mock.js';

// Slices of `state` captured in each undo snapshot — design nodes plus the
// Color / Model / API tabs and all their id counters, so undo/redo works
// consistently across every tab.
const KEYS = [
  'nodes', 'nextId', 'nextFrameNum', 'nextContainerNum',
  'components', 'nextComponentId',
  'themes', 'nextThemeId', 'activeThemeId',
  'colors', 'nextColorId', 'selectedColorId', 'colorRoles',
  'typography', 'nextTypoId', 'selectedTypoId',
  'models', 'nextModelId', 'nextPropId',
  'enums', 'nextEnumId', 'nextEnumValId',
  'mockSets', 'nextMockId',
  'providers', 'nextProviderId', 'apiBaseUrl', 'nextApiId', 'nextHeaderId', 'nextParamId',
];

function snapshot() {
  const obj = {};
  KEYS.forEach(k => { obj[k] = state[k]; });
  return JSON.stringify(obj);
}

// Node types that lay out children (the "container family"); the layout fields
// belong to these, never to leaf nodes (text/image/icon).
const LAYOUT_TYPES = ['frame', 'container', 'section', 'row', 'column', 'wrap', 'stack'];

// Each type-specific field → the node types allowed to keep it when persisting.
// Any other type is stripped of it, so a frame doesn't carry text/image/icon fields
// (svg, src, fontSize, text, …) and a leaf doesn't carry layout fields it never
// uses. Every read of these is type-gated or has a default fallback, so pruning is
// safe; the in-memory shape and undo snapshots keep the full object.
const FIELD_OWNERS = {
  src: ['image'], fit: ['image'],
  svg: ['icon'], iconId: ['icon'],
  text: ['text'], fontSize: ['text'], fontWeight: ['text'], color: ['text'], typoId: ['text'], autoSize: ['text'],
  fontSizeOverride: ['text'], fontWeightOverride: ['text'],
  repeat: ['frame', 'container'],
  routePath: ['frame'], isInitial: ['frame'], screenH: ['frame'],
  layout: LAYOUT_TYPES, scroll: LAYOUT_TYPES, gap: LAYOUT_TYPES, gapH: LAYOUT_TYPES, gapV: LAYOUT_TYPES,
};

// Fields a specific type must NOT carry, even though other types use them. Frames
// (screens) and sections (which "carry no visual styling of their own") expose no
// stroke / appearance / shadow controls (see props.js + render's empty section
// branch), so those never apply to them. An image has no padding UI (padding is only
// for single-child frame/container). Reads of these are guarded, or aren't run for
// the type, so dropping them is safe.
const NO_STYLE = ['frame', 'section'];
const FIELD_EXCLUDE = {
  stroke: NO_STYLE, strokeW: NO_STYLE, strokeOpacity: NO_STYLE, strokeStyle: NO_STYLE, strokeColorId: NO_STYLE,
  opacity: NO_STYLE, radius: NO_STYLE, radii: NO_STYLE, radiusMode: NO_STYLE,
  rotation: NO_STYLE, flipH: NO_STYLE, flipV: NO_STYLE, shadows: NO_STYLE, shape: NO_STYLE,
  padding: ['image'],
};

// Whether a node of `type` carries field `key` (the same rules pruneNode applies).
export function fieldApplies(type, key) {
  const owners = FIELD_OWNERS[key];
  if (owners && !owners.includes(type)) return false;
  const excluded = FIELD_EXCLUDE[key];
  return !(excluded && excluded.includes(type));
}

// A shallow copy of a node minus fields that don't belong to its type.
function pruneNode(node) {
  const out = {};
  for (const k in node) {
    const owners = FIELD_OWNERS[k];
    if (owners && !owners.includes(node.type)) continue;      // owned only by other types
    const excluded = FIELD_EXCLUDE[k];
    if (excluded && excluded.includes(node.type)) continue;   // explicitly not for this type
    out[k] = node[k];
  }
  return out;
}

// The persisted project document: the same state slices undo/redo tracks, as a
// plain object for the project API. `state.projectName` is intentionally left
// out — the name lives on the project's metadata, not inside the document. Nodes
// are pruned to their type-relevant fields so the stored document stays lean.
export function serializeDocument() {
  const obj = {};
  KEYS.forEach(k => { obj[k] = state[k]; });
  obj.nodes = (state.nodes || []).map(pruneNode);
  return obj;
}

// Load a document fetched from the server into state, replacing the tracked
// slices and resetting undo history (the caller seeds the first snapshot).
export function loadDocument(doc) {
  if (!doc) return;
  KEYS.forEach(k => { if (k in doc) state[k] = doc[k]; });
  repairCounters(); // a document saved with stale counters must not reuse ids
  state.history = [];
  state.historyIndex = -1;
  state.selected.clear();
}

// The document as it is right now, and a way back to it without touching the
// undo history — so a multi-step change that fails halfway can be rolled back.
export function captureState() { return snapshot(); }
export function restoreState(snap) {
  const s = JSON.parse(snap);
  KEYS.forEach(k => { if (k in s) state[k] = s[k]; });
  state.selected = new Set([...state.selected].filter(id => state.nodes.some(n => n.id === id)));
  rerenderActive();
}

export function saveHistory() {
  const snap = snapshot();
  // Ignore no-op commits (e.g. a blur with no change) to avoid dead entries.
  if (state.history[state.historyIndex] === snap) return;
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snap);
  state.historyIndex = state.history.length - 1;
  // A committed change — signal the collaboration layer to broadcast it. (Skipped
  // while we're applying a peer's update, so a remote change never echoes back.)
  if (!state.collabApplying) document.dispatchEvent(new Event('doc:commit'));
}

// Replace the current undo snapshot with the live state, without adding a new
// entry. Used to fold an async finalization (swapping inline images for uploaded
// refs) into the same undo step that created the images.
export function commitCurrent() {
  if (state.historyIndex < 0) return;
  state.history[state.historyIndex] = snapshot();
}

export function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  loadSnap(state.history[state.historyIndex]);
}

export function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  loadSnap(state.history[state.historyIndex]);
}

function loadSnap(snap) {
  const s = JSON.parse(snap);
  KEYS.forEach(k => { if (k in s) state[k] = s[k]; });
  state.selected.clear();
  rerenderActive();
  // Undo/redo mutate the document too — broadcast the result to collaborators.
  if (!state.collabApplying) document.dispatchEvent(new Event('doc:commit'));
}

// Repaint the design canvas plus whichever non-design tab is currently shown.
export function rerenderActive() {
  render();
  renderThemeSwitch(); // active theme may have changed in the restored snapshot
  const mode = document.querySelector('.mode-tab.active')?.dataset.mode;
  if (mode === 'model') renderModels();
  else if (mode === 'api') renderApi();
  else if (mode === 'color') renderColors();
  else if (mode === 'typography') renderTypography();
  else if (mode === 'mock') renderMock();
}
