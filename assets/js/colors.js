import { state, makeColorValue } from './state.js';
import { esc } from './utils.js';
import { gradientCss, render } from './render.js';
import { saveHistory } from './history.js';
import { renderProps } from './props.js';
import { SCHEME_ROLES } from './codegen.js';
import { ddTrigger } from './dropdown.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

// The top-level fill/alpha/gradient on a color mirror the *active* theme. Write
// that live value back into the theme's stored slot, then snapshot to history.
// Every color edit funnels through here so per-theme values and undo stay right.
function persistActive(c) {
  if (c && state.activeThemeId) {
    c.values[state.activeThemeId] = {
      fillType: c.fillType, fill: c.fill, alpha: c.alpha, gradient: clone(c.gradient),
    };
  }
}
function commit() {
  persistActive(getColor(state.selectedColorId));
  saveHistory();
}

// Point every color's top-level (mirror) fields at the given theme's stored
// value, then repaint. Missing values are backfilled (e.g. a color added before
// this thema existed) from a clone of any existing value.
function loadTheme(themeId) {
  state.activeThemeId = themeId;
  state.colors.forEach(c => {
    if (!c.values) c.values = {};
    let v = c.values[themeId];
    if (!v) { v = c.values[themeId] = clone(Object.values(c.values)[0] || makeColorValue('#5b8af5')); }
    c.fillType = v.fillType; c.fill = v.fill; c.alpha = v.alpha; c.gradient = clone(v.gradient);
  });
}

// Color tab: a grid of 100×100 color swatches. Selecting one edits it in the
// right-hand controller panel. Frame/container reference these by id for fill.

const getColor = (id) => state.colors.find(c => c.id === id);
const isHex = (v) => /^#[0-9a-f]{3,8}$/i.test(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── Color conversions ──
function hexToRgb(hex) {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  const n = parseInt(h.slice(0, 6) || '0', 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
  const h = (x) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
function rgbaStr(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a == null ? 1 : a})`;
}

// Custom picker working state for the currently edited target
let pickerHsv = { h: 0, s: 0, v: 0 };
let pickerKey = null;
let pickerMode = 'hex';
let pickerStopIndex = 0;

const stopCss = (s) => rgbaStr(s.color, s.alpha);

// What the picker edits: the solid color, or the selected gradient stop.
function getTarget(c) {
  if (c.fillType === 'linear' || c.fillType === 'radial') {
    const i = clamp(pickerStopIndex, 0, c.gradient.stops.length - 1);
    const stop = c.gradient.stops[i];
    return {
      key: c.id + ':s' + i,
      getHex: () => stop.color, setHex: (v) => { stop.color = v; },
      getAlpha: () => stop.alpha == null ? 1 : stop.alpha, setAlpha: (v) => { stop.alpha = v; },
    };
  }
  return {
    key: c.id + ':solid',
    getHex: () => c.fill, setHex: (v) => { c.fill = v; },
    getAlpha: () => c.alpha == null ? 1 : c.alpha, setAlpha: (v) => { c.alpha = v; },
  };
}

function ensurePicker(t) {
  if (pickerKey !== t.key) {
    pickerKey = t.key;
    const { r, g, b } = hexToRgb(t.getHex());
    pickerHsv = rgbToHsv(r, g, b);
  }
}

// Validate a color name against camelCase rules. Returns an issue, or null.
function colorNameError(name) {
  if (!name.trim()) return 'Name can’t be empty';
  if (/^[0-9]/.test(name)) return 'Can’t start with a number';
  if (/\s/.test(name)) return 'No spaces allowed';
  if (/[^A-Za-z0-9]/.test(name)) return 'Only letters and numbers allowed';
  if (!/^[a-z]/.test(name)) return 'Must be camelCase (start with a lowercase letter)';
  return null;
}

// Full validation for a color: name format, then uniqueness across colors.
function colorError(c) {
  const fmt = colorNameError(c.name);
  if (fmt) return fmt;
  if (state.colors.some(o => o !== c && o.name.trim() === c.name.trim())) return 'Another color has this name';
  return null;
}

// True when any color variable has a validation error (gates the export button).
export function anyColorError() {
  return state.colors.some(c => colorError(c) !== null);
}

// CSS background string for a color variable.
export function colorCss(c) {
  if (!c) return 'transparent';
  if (c.fillType === 'linear' || c.fillType === 'radial') return gradientCss(c);
  return rgbaStr(c.fill, c.alpha);
}

function addColor() {
  const n = state.nextColorId++;
  // A new color exists in every theme (independent value objects, shared name).
  const values = {};
  state.themes.forEach(t => { values[t.id] = makeColorValue('#5b8af5'); });
  const active = values[state.activeThemeId] || makeColorValue('#5b8af5');
  const c = {
    id: 'c' + n, name: 'color' + n, values,
    fillType: active.fillType, fill: active.fill, alpha: active.alpha, gradient: clone(active.gradient),
  };
  state.colors.push(c);
  state.selectedColorId = c.id;
  commit();
  renderColors();
}

function deleteColor(id) {
  state.colors = state.colors.filter(c => c.id !== id);
  if (state.selectedColorId === id) state.selectedColorId = state.colors.length ? state.colors[0].id : null;
  // Drop any ColorScheme role that pointed at the removed color.
  Object.keys(state.colorRoles).forEach(k => { if (state.colorRoles[k] === id) state.colorRoles[k] = null; });
  saveHistory();
  renderColors();
}

// ── Themes ──
// Add a theme; every color gets a value under it, cloned from the current active
// theme so the new theme starts as a copy the user can then diverge.
function addTheme() {
  const n = state.nextThemeId++;
  const t = { id: 'th' + n, name: 'theme' + n, brightness: 'dark' };
  state.themes.push(t);
  const from = state.activeThemeId;
  state.colors.forEach(c => {
    const src = c.values[from] || Object.values(c.values)[0] || makeColorValue('#5b8af5');
    c.values[t.id] = clone(src);
  });
  loadTheme(t.id);
  saveHistory();
  renderColors();
}

function deleteTheme(id) {
  if (state.themes.length <= 1) return; // keep at least one theme
  state.themes = state.themes.filter(t => t.id !== id);
  state.colors.forEach(c => { if (c.values) delete c.values[id]; });
  if (state.activeThemeId === id) loadTheme(state.themes[0].id);
  saveHistory();
  renderColors();
}

function toggleBrightness(id) {
  const t = state.themes.find(x => x.id === id);
  if (!t) return;
  t.brightness = t.brightness === 'dark' ? 'light' : 'dark';
  saveHistory();
  renderColors();
}

// ── Design-tab theme preview switch ──
// Change which theme the whole app previews. Colors reference the active theme's
// value (mirrored on the top-level fields), so switching + repainting recolors
// every node on the canvas. Not a history event — it's a view preference.
export function applyTheme(themeId) {
  if (themeId === state.activeThemeId || !state.themes.some(t => t.id === themeId)) return;
  persistActive(getColor(state.selectedColorId)); // keep the theme we're leaving
  loadTheme(themeId);
  render();            // recolor the canvas
  renderThemeSwitch(); // reflect the new active theme in the toolbar toggle
  renderProps();       // refresh the selected node's colour swatches
  renderColors();      // keep the Color tab in sync if it's open
}

// Build the toolbar Dark/Light toggle from the current themes, marking the
// active one. Rebuilt on theme switch and undo/redo.
export function renderThemeSwitch() {
  const host = document.getElementById('theme-switch');
  if (!host) return;
  host.innerHTML = state.themes.map(t => {
    const label = t.name ? t.name[0].toUpperCase() + t.name.slice(1) : 'Theme';
    return `<button class="tool-btn ${t.id === state.activeThemeId ? 'active' : ''}" data-themesw="${t.id}" data-tooltip="${esc(label)} theme">${t.brightness === 'dark' ? MOON : SUN}</button>`;
  }).join('');
}

// Sun / moon glyphs for a theme's light / dark brightness toggle.
const MOON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
const SUN = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>`;

// Theme switcher. Adding/renaming/deleting themes isn't exposed yet (two fixed
// themes, dark + light), but the underlying model is fully dynamic — the add /
// delete / rename logic stays in place for when it is.
function renderThemeBar() {
  return `
    <div class="theme-bar">
      ${state.themes.map(t => `
      <div class="theme-chip ${t.id === state.activeThemeId ? 'active' : ''}" data-theme="${t.id}">
        <button class="theme-bright" data-themebright="${t.id}" title="${t.brightness === 'dark' ? 'Dark' : 'Light'} theme — click to toggle">${t.brightness === 'dark' ? MOON : SUN}</button>
        <span class="theme-name">${esc(t.name)}</span>
      </div>`).join('')}
    </div>`;
}

function renderBoard() {
  const board = document.getElementById('color-board');
  if (!board) return;
  board.innerHTML = `
    ${renderThemeBar()}
    <div class="model-board-head">
      <span class="model-board-title">Colors</span>
      <button class="model-add-btn" id="color-new">+ New Color</button>
    </div>
    <div class="color-grid">
      ${state.colors.map(c => {
        const err = colorError(c);
        return `
      <div class="color-tile ${state.selectedColorId === c.id ? 'selected' : ''}" data-tile="${c.id}">
        <button class="tile-del" data-tiledel="${c.id}" title="Delete color">&times;</button>
        <div class="color-swatch-lg" data-swatch="${c.id}" style="background:${swatchBg(c)}">${c.id === state.selectedColorId && c.fillType !== 'solid' ? renderGradOverlay(c) : ''}</div>
        <div class="color-tile-label">
          <span class="color-tile-name" data-tilename="${c.id}">${esc(c.name)}</span>
          <span class="model-warn" data-tilewarn="${c.id}" title="${err ? esc(err) : ''}"${err ? '' : ' style="display:none"'}>&#9888;</span>
        </div>
      </div>`;
      }).join('')}
      ${state.colors.length === 0 ? `<div class="model-empty">No colors yet — click "+ New Color" to create one.</div>` : ''}
    </div>
    ${renderRoleMap()}`;
}

// Maps Material ColorScheme roles to colors (global across themes). Feeds the
// generated ColorScheme in themes.dart. Each theme supplies the mapped color's
// own per-theme value.
function renderRoleMap() {
  if (state.colors.length === 0) return '';
  // Shared option list for every role: "None" + each color variable.
  const roleOptions = [{ value: '', label: 'None' }, ...state.colors.map(c => ({ value: c.id, label: c.name }))];
  return `
    <div class="model-board-head" style="margin-top:22px">
      <span class="model-board-title">Theme Roles</span>
    </div>
    <div class="role-hint">Map Material color-scheme roles to your colors for the generated theme.</div>
    <div class="role-list">
      ${SCHEME_ROLES.map(r => `
      <label class="role-row">
        <span class="role-label">${r.label}</span>
        ${ddTrigger({ value: state.colorRoles[r.id] || '', options: roleOptions, data: { role: r.id }, triggerClass: 'dd-block role-dd' })}
      </label>`).join('')}
    </div>`;
}

function renderPanel() {
  const panel = document.getElementById('color-panel');
  if (!panel) return;
  const c = getColor(state.selectedColorId);
  if (!c) {
    panel.innerHTML = `
      <div class="panel-header"><span class="panel-title">Color</span></div>
      <div class="empty-state">Select a color<br>to edit it</div>`;
    return;
  }
  if (c.fillType !== 'solid') pickerStopIndex = clamp(pickerStopIndex, 0, c.gradient.stops.length - 1);
  const err = colorError(c);
  panel.innerHTML = `
    <div class="panel-header">
      <span class="panel-title">Color</span>
      <button class="panel-action" data-del-color="${c.id}" title="Delete color">&times;</button>
    </div>
    <div class="color-panel-body">
      <div class="prop-section">
        <div class="prop-row" style="gap:6px">
          <input class="prop-input ${err ? 'invalid' : ''}" data-name value="${esc(c.name)}" spellcheck="false" placeholder="colorName" style="width:100%">
          <span class="model-warn" data-warn title="${err ? esc(err) : ''}"${err ? '' : ' style="display:none"'}>&#9888;</span>
        </div>
      </div>
      <div class="prop-section">
        <div class="prop-section-title">Type</div>
        <div class="shape-toggle">
          <button class="fill-btn ${c.fillType === 'solid' ? 'active' : ''}" data-filltype="solid">Solid</button>
          <button class="fill-btn ${c.fillType === 'linear' ? 'active' : ''}" data-filltype="linear">Linear</button>
          <button class="fill-btn ${c.fillType === 'radial' ? 'active' : ''}" data-filltype="radial">Radial</button>
        </div>
      </div>
      <div class="prop-section">
        ${c.fillType === 'solid' ? renderPicker(c) : `
        ${c.fillType === 'linear' ? `
        <div class="prop-row">
          <span class="prop-label-wide">Angle</span>
          <input class="prop-input" data-angle type="number" value="${c.gradient.angle}">
        </div>` : ''}
        <div class="grad-stops">
          ${c.gradient.stops.map((s, i) => `
          <div class="grad-stop ${i === pickerStopIndex ? 'selected' : ''}">
            <span class="grad-stop-sw" data-stopsel="${i}" data-stopsw="${i}" style="background:${stopCss(s)}"></span>
            <input class="prop-input" data-stoppos="${i}" type="number" value="${s.pos}" min="0" max="100" style="width:46px">
            <button class="prop-del" data-stopdel="${i}"${c.gradient.stops.length <= 2 ? ' style="visibility:hidden"' : ''}>&times;</button>
          </div>`).join('')}
          <button class="prop-add" data-addstop style="margin:2px 0 0">+ Add stop</button>
        </div>
        ${renderPicker(c)}`}
      </div>
    </div>`;
}

// Custom color picker (SV square + hue + alpha + hex/rgb inputs) for the current
// target — the solid color, or the selected gradient stop.
function renderPicker(c) {
  const t = getTarget(c);
  ensurePicker(t);
  const { h, s, v } = pickerHsv;
  const a = t.getAlpha();
  const hex = t.getHex();
  const { r, g, b } = hexToRgb(hex);
  return `
    <div class="cpick">
      <div class="cpick-sv" data-sv style="background:hsl(${h},100%,50%)">
        <div class="cpick-sv-white"></div>
        <div class="cpick-sv-black"></div>
        <div class="cpick-sv-handle" style="left:${s * 100}%;top:${(1 - v) * 100}%"></div>
      </div>
      <div class="cpick-hue" data-hue><div class="cpick-hue-handle" style="left:${h / 360 * 100}%"></div></div>
      <div class="cpick-alpha" data-alpha style="--rgb:${r},${g},${b}"><div class="cpick-alpha-handle" style="left:${a * 100}%"></div></div>
      <div class="cpick-fields">
        <button class="cpick-mode" data-mode>${pickerMode.toUpperCase()}</button>
        ${pickerMode === 'hex'
          ? `<input class="prop-input cpick-hex" data-hex value="${esc(hex)}" spellcheck="false">`
          : `<input class="prop-input cpick-rgb" data-r type="number" min="0" max="255" value="${Math.round(r)}">
             <input class="prop-input cpick-rgb" data-g type="number" min="0" max="255" value="${Math.round(g)}">
             <input class="prop-input cpick-rgb" data-b type="number" min="0" max="255" value="${Math.round(b)}">`}
        <input class="prop-input cpick-a" data-alphainput type="number" min="0" max="100" value="${Math.round(a * 100)}">
      </div>
    </div>`;
}

// ── Gradient on-canvas control (line + circle with stop handles) ──
// Geometry is in a normalized 0..1 square; multiplied by 100 for the SVG viewBox.
function linGeom(angle) {
  const th = angle * Math.PI / 180;
  const dx = Math.sin(th), dy = -Math.cos(th);   // CSS angle direction (unit vector)
  return { dx, dy, half: (Math.abs(dx) + Math.abs(dy)) / 2 };
}
function linStopPt(g, pos) {
  const t = pos / 100 - 0.5;
  return { x: 0.5 + t * 2 * g.half * g.dx, y: 0.5 + t * 2 * g.half * g.dy };
}
// Color layer (always an image so it can sit over the checkerboard layer) + checkerboard.
// Exported so the Design-tab property swatches show the same translucency check.
export const swatchBg = (c) => {
  const fill = c.fillType === 'solid' ? `linear-gradient(${colorCss(c)}, ${colorCss(c)})` : colorCss(c);
  return `${fill}, repeating-conic-gradient(#5a5a5a 0 25%, #888 0 50%) 0/12px 12px`;
};

function renderGradOverlay(c) {
  const stops = c.gradient.stops;
  const dot = (st, x, y) => `<circle cx="${x}" cy="${y}" r="5.5" fill="${stopCss(st)}" class="gov-stop${stops.indexOf(st) === pickerStopIndex ? ' sel' : ''}" data-stophandle="${stops.indexOf(st)}"/>`;
  if (c.fillType === 'radial') {
    let s = `<svg class="grad-ov" viewBox="0 0 100 100" preserveAspectRatio="none">`;
    s += `<circle cx="50" cy="50" r="50" class="gov-line" fill="none"/>`;
    s += `<line x1="50" y1="50" x2="100" y2="50" class="gov-line"/>`;
    stops.forEach(st => { s += dot(st, 50 + st.pos / 100 * 50, 50); });
    return s + `</svg>`;
  }
  const g = linGeom(c.gradient.angle);
  const a = linStopPt(g, 0), b = linStopPt(g, 100);
  let s = `<svg class="grad-ov" viewBox="0 0 100 100" preserveAspectRatio="none">`;
  s += `<line x1="${a.x * 100}" y1="${a.y * 100}" x2="${b.x * 100}" y2="${b.y * 100}" class="gov-hit" data-gradrot/>`;
  s += `<line x1="${a.x * 100}" y1="${a.y * 100}" x2="${b.x * 100}" y2="${b.y * 100}" class="gov-line"/>`;
  stops.forEach(st => { const p = linStopPt(g, st.pos); s += dot(st, p.x * 100, p.y * 100); });
  return s + `</svg>`;
}

// Refresh all gradient visuals: the board tile (bg + overlay handles) and the
// selected stop's swatch in the sidebar list.
function refreshGrad(c) {
  refreshStopSwatch(c);
  const sw = document.querySelector(`[data-swatch="${c.id}"]`);
  if (sw) {
    sw.style.background = swatchBg(c);
    sw.innerHTML = (c.id === state.selectedColorId && c.fillType !== 'solid') ? renderGradOverlay(c) : '';
  }
}

// Write current HSV back to the target and refresh the picker DOM live.
function applyPicker(c) {
  const { r, g, b } = hsvToRgb(pickerHsv.h, pickerHsv.s, pickerHsv.v);
  getTarget(c).setHex(rgbToHex(r, g, b));
  refreshGrad(c);
  updatePickerDom(c);
}

// Update the selected gradient stop's little swatch (no-op for solid).
function refreshStopSwatch(c) {
  if (c.fillType === 'solid') return;
  const i = clamp(pickerStopIndex, 0, c.gradient.stops.length - 1);
  const sw = document.querySelector(`[data-stopsw="${i}"]`);
  if (sw) sw.style.background = stopCss(c.gradient.stops[i]);
}

function updatePickerDom(c) {
  const panel = document.getElementById('color-panel');
  if (!panel) return;
  const t = getTarget(c);
  const { h, s, v } = pickerHsv;
  const a = t.getAlpha();
  const { r, g, b } = hexToRgb(t.getHex());
  const set = (sel, fn) => { const el = panel.querySelector(sel); if (el) fn(el); };
  set('[data-sv]', el => { el.style.background = `hsl(${h},100%,50%)`; });
  set('.cpick-sv-handle', el => { el.style.left = s * 100 + '%'; el.style.top = (1 - v) * 100 + '%'; });
  set('.cpick-hue-handle', el => { el.style.left = h / 360 * 100 + '%'; });
  set('[data-alpha]', el => el.style.setProperty('--rgb', `${r},${g},${b}`));
  set('.cpick-alpha-handle', el => { el.style.left = a * 100 + '%'; });
  const upd = (sel, val) => { const el = panel.querySelector(sel); if (el && document.activeElement !== el) el.value = val; };
  upd('[data-hex]', t.getHex());
  upd('[data-r]', Math.round(r)); upd('[data-g]', Math.round(g)); upd('[data-b]', Math.round(b));
  upd('[data-alphainput]', Math.round(a * 100));
}

// Drag handler for the SV square / hue / alpha tracks (normalized 0..1 coords).
function startDrag(el, e, onMove) {
  e.preventDefault();
  const rect = el.getBoundingClientRect();
  const move = (ev) => onMove(
    clamp((ev.clientX - rect.left) / rect.width, 0, 1),
    clamp((ev.clientY - rect.top) / rect.height, 0, 1)
  );
  move(e);
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    commit(); // one history entry per drag gesture (SV/hue/alpha, stop, rotate)
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

export function renderColors() {
  renderBoard();
  renderPanel();
}

// Live preview updates that don't rebuild the panel (so input focus is kept).
function refreshSwatch(c) {
  const sw = document.querySelector(`[data-swatch="${c.id}"]`);
  if (sw) sw.style.background = swatchBg(c);
}
function refreshTileName(c) {
  const el = document.querySelector(`[data-tilename="${c.id}"]`);
  if (el) el.textContent = c.name;
}
// Sync the panel's name warning icon + input outline without rebuilding (keeps focus).
function refreshColorWarn(c) {
  const err = colorError(c);
  const warn = document.querySelector('#color-panel [data-warn]');
  if (warn) { warn.title = err || ''; warn.style.display = err ? '' : 'none'; }
  const input = document.querySelector('#color-panel [data-name]');
  if (input) input.classList.toggle('invalid', !!err);
}

// Sync every board tile's warning icon (renaming one color can change another's
// duplicate status, so refresh them all).
function refreshTileWarns() {
  state.colors.forEach(c => {
    const err = colorError(c);
    const w = document.querySelector(`[data-tilewarn="${c.id}"]`);
    if (w) { w.title = err || ''; w.style.display = err ? '' : 'none'; }
  });
}

export function initColors() {
  const board = document.getElementById('color-board');
  const panel = document.getElementById('color-panel');

  if (board) {
    board.addEventListener('click', e => {
      if (e.target.id === 'color-new') return addColor();
      const brightBtn = e.target.closest('[data-themebright]');
      if (brightBtn) return toggleBrightness(brightBtn.dataset.themebright);
      const chip = e.target.closest('.theme-chip');
      if (chip && chip.dataset.theme !== state.activeThemeId) { loadTheme(chip.dataset.theme); renderColors(); return; }
      if (chip) return; // clicked the already-active chip — no-op
      if (e.target.dataset.tiledel) return deleteColor(e.target.dataset.tiledel);
      // Ignore clicks on the gradient overlay handles (handled by pointerdown drag)
      if (e.target.closest('[data-stophandle]') || e.target.closest('[data-gradrot]')) return;
      const tile = e.target.closest('.color-tile');
      if (tile && tile.dataset.tile !== state.selectedColorId) { state.selectedColorId = tile.dataset.tile; renderColors(); }
    });

    // Theme-role dropdowns (custom dd): assign a color id (or clear) to a role.
    // The dd controller sets data-dd-value but not the visible label, so sync it.
    board.addEventListener('dd:change', e => {
      const trig = e.target.closest('[data-role]');
      if (!trig) return;
      const val = e.detail.value;
      state.colorRoles[trig.dataset.role] = val || null;
      const label = trig.querySelector('.dd-label');
      if (label) label.textContent = val ? (getColor(val)?.name || 'None') : 'None';
      saveHistory();
    });

    // Drag the gradient line/circle handles drawn on the selected color's swatch
    board.addEventListener('pointerdown', e => {
      const c = getColor(state.selectedColorId);
      if (!c || c.fillType === 'solid') return;
      const stopH = e.target.closest('[data-stophandle]');
      const rotH = e.target.closest('[data-gradrot]');
      const sw = document.querySelector(`[data-swatch="${c.id}"]`);
      if (!sw) return;
      if (stopH) {
        const i = +stopH.dataset.stophandle;
        pickerStopIndex = i;
        renderPanel(); // reflect the newly selected stop in the controller
        startDrag(sw, e, (x, y) => {
          let pos;
          if (c.fillType === 'radial') pos = clamp(Math.hypot(x - 0.5, y - 0.5) / 0.5, 0, 1) * 100;
          else { const g = linGeom(c.gradient.angle); pos = clamp(((x - 0.5) * g.dx + (y - 0.5) * g.dy) / (2 * g.half) + 0.5, 0, 1) * 100; }
          c.gradient.stops[i].pos = pos;
          refreshGrad(c);
          const pin = document.querySelector(`#color-panel [data-stoppos="${i}"]`);
          if (pin && document.activeElement !== pin) pin.value = Math.round(pos);
        });
      } else if (rotH) {
        startDrag(sw, e, (x, y) => {
          let ang = Math.atan2(x - 0.5, -(y - 0.5)) * 180 / Math.PI;
          if (ang < 0) ang += 360;
          c.gradient.angle = Math.round(ang);
          refreshGrad(c);
          const ain = document.querySelector('#color-panel [data-angle]');
          if (ain && document.activeElement !== ain) ain.value = Math.round(ang);
        });
      }
    });
  }

  if (panel) {
    panel.addEventListener('click', e => {
      const t = e.target;
      if (t.dataset.delColor) return deleteColor(t.dataset.delColor);
      const c = getColor(state.selectedColorId);
      if (!c) return;
      if (t.dataset.mode != null) { pickerMode = pickerMode === 'hex' ? 'rgb' : 'hex'; renderPanel(); return; }
      if (t.dataset.filltype) { c.fillType = t.dataset.filltype; pickerStopIndex = 0; renderPanel(); refreshGrad(c); commit(); return; }
      if (t.dataset.stopsel != null) { pickerStopIndex = +t.dataset.stopsel; renderPanel(); refreshGrad(c); return; }
      if (t.dataset.stopdel != null) { if (c.gradient.stops.length > 2) { c.gradient.stops.splice(+t.dataset.stopdel, 1); pickerStopIndex = clamp(pickerStopIndex, 0, c.gradient.stops.length - 1); renderPanel(); refreshGrad(c); commit(); } return; }
      if (t.dataset.addstop != null) { const s = c.gradient.stops; s.push({ color: s[s.length - 1]?.color || '#ffffff', alpha: 1, pos: 100 }); pickerStopIndex = s.length - 1; renderPanel(); refreshGrad(c); commit(); return; }
    });

    // Commit field edits (name, hex/rgb, alpha, angle, stop position) to history on blur.
    panel.addEventListener('change', () => commit());

    // Drag on the SV square / hue / alpha tracks
    panel.addEventListener('pointerdown', e => {
      const c = getColor(state.selectedColorId);
      if (!c) return;
      const sv = e.target.closest('[data-sv]');
      const hue = e.target.closest('[data-hue]');
      const alpha = e.target.closest('[data-alpha]');
      if (sv) return startDrag(sv, e, (x, y) => { pickerHsv.s = x; pickerHsv.v = 1 - y; applyPicker(c); });
      if (hue) return startDrag(hue, e, (x) => { pickerHsv.h = x * 360; applyPicker(c); });
      if (alpha) return startDrag(alpha, e, (x) => { getTarget(c).setAlpha(x); refreshGrad(c); updatePickerDom(c); });
    });

    panel.addEventListener('input', e => {
      const t = e.target;
      const c = getColor(state.selectedColorId);
      if (!c) return;
      if (t.dataset.name != null) { c.name = t.value; refreshTileName(c); refreshColorWarn(c); refreshTileWarns(); return; }
      if (t.dataset.hex != null) { if (isHex(t.value)) { getTarget(c).setHex(t.value); const { r, g, b } = hexToRgb(t.value); pickerHsv = rgbToHsv(r, g, b); refreshGrad(c); updatePickerDom(c); } return; }
      if (t.dataset.r != null || t.dataset.g != null || t.dataset.b != null) {
        const rd = panel.querySelector('[data-r]'), gd = panel.querySelector('[data-g]'), bd = panel.querySelector('[data-b]');
        const hex = rgbToHex(+rd.value || 0, +gd.value || 0, +bd.value || 0);
        getTarget(c).setHex(hex);
        const { r, g, b } = hexToRgb(hex); pickerHsv = rgbToHsv(r, g, b);
        refreshGrad(c); updatePickerDom(c); return;
      }
      if (t.dataset.alphainput != null) { getTarget(c).setAlpha(clamp(parseFloat(t.value) || 0, 0, 100) / 100); refreshGrad(c); updatePickerDom(c); return; }
      if (t.dataset.angle != null) { c.gradient.angle = parseFloat(t.value) || 0; refreshGrad(c); return; }
      if (t.dataset.stoppos != null) { c.gradient.stops[+t.dataset.stoppos].pos = clamp(parseFloat(t.value) || 0, 0, 100); refreshGrad(c); return; }
    });
  }
}
