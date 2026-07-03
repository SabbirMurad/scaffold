import { state } from './state.js';
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

export function saveHistory() {
  const snap = snapshot();
  // Ignore no-op commits (e.g. a blur with no change) to avoid dead entries.
  if (state.history[state.historyIndex] === snap) return;
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snap);
  state.historyIndex = state.history.length - 1;
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
}

// Repaint the design canvas plus whichever non-design tab is currently shown.
function rerenderActive() {
  render();
  renderThemeSwitch(); // active theme may have changed in the restored snapshot
  const mode = document.querySelector('.mode-tab.active')?.dataset.mode;
  if (mode === 'model') renderModels();
  else if (mode === 'api') renderApi();
  else if (mode === 'color') renderColors();
  else if (mode === 'typography') renderTypography();
  else if (mode === 'mock') renderMock();
}
