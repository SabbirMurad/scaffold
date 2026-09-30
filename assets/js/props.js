import { state, getNode, getComponent, getMasterNode, isMaster } from './state.js';
import { componentName, instancesOf, detachInstance, placeInstance, goToNode, renameComponent } from './operations.js';
import { noSelection, propsFields, esc } from './utils.js';
import { swatchBg } from './colors.js';
import { updateNodeEl, render } from './render.js';
import { renderLayers } from './layers.js';
import { ddTrigger } from './dropdown.js';
import { ensureFontLoaded } from './google-fonts.js';
import { saveHistory } from './history.js';
import { scopeFor, pathOptions, pathType, canRepeat, aliasOf, OPS, isUnary } from './data.js';

const STROKE_STYLES = ['solid', 'dashed', 'dotted', 'double'];

// Whether the Fill / Stroke / Shadow swatch grids are expanded (all rows) vs
// collapsed (2 rows). Kept at module scope so the choice survives the
// renderProps() that a swatch pick triggers. Shadows: by index, one grid each.
let fillExpanded = false;
let strokeExpanded = false;
const shadowExpanded = new Set();

// Shape toggle glyphs: a rounded square and a circle (sized by .shape-btn svg).
const SHAPE_RECT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4.5" y="4.5" width="15" height="15" rx="3"/></svg>`;
const SHAPE_CIRCLE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="7.7"/></svg>`;

// Padding/Margin can show 2 combined inputs (Horizontal/Vertical) or 4 per-side
// inputs. Transient UI preference (not per-node), toggled by the side icon.
const boxExpanded = { pad: false, mar: false };
const SIDES_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><rect x="5.5" y="5.5" width="5" height="5" rx="1"/></svg>`;
// Plus icon for adding a shadow.
const PLUS_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>`;
// Text sizing: auto-width = text lines with outward horizontal arrows (grows
// sideways); fixed-width = wrapped lines inside a fixed box.
const ICON = (d) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ITALIC_ICON = ICON('<path d="M10 4h8M6 20h8M14 4l-4 16"/>');
const UNDERLINE_ICON = ICON('<path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14"/>');
const STRIKE_ICON = ICON('<path d="M4 12h16"/><path d="M16.5 7c-.5-1.8-2.3-3-4.5-3-2.8 0-4.5 1.5-4.5 3.3 0 1.2.7 2.1 2 2.7M8 16.5c.6 2 2.4 3.5 4.9 3.5 2.9 0 4.6-1.6 4.6-3.6 0-.9-.3-1.6-.9-2.2"/>');
// A square with one side drawn heavier: which side the stroke is on.
const SIDE_ICONS = {
  t: ICON('<rect x="5" y="5" width="14" height="14" rx="1.5" stroke-opacity=".3"/><path d="M4.5 5h15" stroke-width="2.6"/>'),
  r: ICON('<rect x="5" y="5" width="14" height="14" rx="1.5" stroke-opacity=".3"/><path d="M19 4.5v15" stroke-width="2.6"/>'),
  b: ICON('<rect x="5" y="5" width="14" height="14" rx="1.5" stroke-opacity=".3"/><path d="M4.5 19h15" stroke-width="2.6"/>'),
  l: ICON('<rect x="5" y="5" width="14" height="14" rx="1.5" stroke-opacity=".3"/><path d="M5 4.5v15" stroke-width="2.6"/>'),
};

// Figma's text resizing icons: Auto width (↔ between two bars) and Auto height
// (↕ between two bars — fixed width, the height grows as the text wraps).
const AUTOWIDTH_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7v10M20 7v10"/><path d="M7.5 12h9"/><path d="M10 9.5 7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5"/></svg>`;
const FIXEDWIDTH_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10M7 20h10"/><path d="M12 7.5v9"/><path d="M9.5 10 12 7.5l2.5 2.5M9.5 14l2.5 2.5 2.5-2.5"/></svg>`;

// Figma-style spacing icons: a faint box with the relevant inner edge(s)
// emphasised (h = left+right, v = top+bottom, and each single side).
const boxIcon = (lines) => `<svg viewBox="0 0 16 16" width="18" height="18" fill="none">`
  + `<rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>`
  + lines.map(l => `<line x1="${l[0]}" y1="${l[1]}" x2="${l[2]}" y2="${l[3]}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`).join('')
  + `</svg>`;
const BOX_ICONS = {
  h: boxIcon([[4.5, 5, 4.5, 11], [11.5, 5, 11.5, 11]]),
  v: boxIcon([[5, 4.5, 11, 4.5], [5, 11.5, 11, 11.5]]),
  t: boxIcon([[5, 4.5, 11, 4.5]]),
  b: boxIcon([[5, 11.5, 11, 11.5]]),
  l: boxIcon([[4.5, 5, 4.5, 11]]),
  r: boxIcon([[11.5, 5, 11.5, 11]]),
};

// Figma-style appearance icons: opacity = a half-filled circle; corner radius =
// rounded corner brackets (one path per corner).
const OPACITY_ICON = `<svg viewBox="0 0 16 16" width="18" height="18" fill="none"><circle cx="8" cy="8" r="5.3" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.7 A5.3 5.3 0 0 1 8 13.3 Z" fill="currentColor"/></svg>`;
// Rotation = a circular arrow; flip H/V = mirrored triangles around a dashed axis.
const ROTATION_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 9a8 8 0 1 1-.6 5"/><path d="M4.5 4v5h5"/></svg>`;
// Rotate by a quarter turn: clockwise (+90) and counter-clockwise (-90).
const ROTATE_CW_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 9a8 8 0 1 0 .6 5"/><path d="M19.5 4v5h-5"/></svg>`;
const ROTATE_CCW_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 9a8 8 0 1 1-.6 5"/><path d="M4.5 4v5h5"/></svg>`;
const FLIPH_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M9 7l-4.5 5 4.5 5z"/><path d="M15 7l4.5 5-4.5 5z"/></svg>`;
const FLIPV_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18" stroke-dasharray="2 2.5"/><path d="M7 9l5-4.5 5 4.5z"/><path d="M7 15l5 4.5 5-4.5z"/></svg>`;
const CORNER_PATH = {
  tl: 'M3 7 L3 4.5 A1.5 1.5 0 0 1 4.5 3 L7 3',
  tr: 'M9 3 L11.5 3 A1.5 1.5 0 0 1 13 4.5 L13 7',
  br: 'M13 9 L13 11.5 A1.5 1.5 0 0 1 11.5 13 L9 13',
  bl: 'M7 13 L4.5 13 A1.5 1.5 0 0 1 3 11.5 L3 9',
};
// Uniform radius: four corner brackets with space between them.
const RADIUS_ICON = `<svg viewBox="0 0 16 16" width="18" height="18" fill="none">`
  + ['tl', 'tr', 'br', 'bl'].map(c => `<path d="${CORNER_PATH[c]}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`).join('')
  + `</svg>`;
// Per-corner: a faint box with the one corner emphasised.
const cornerIcon = (c) => `<svg viewBox="0 0 16 16" width="18" height="18" fill="none">`
  + `<rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.2"/>`
  + `<path d="${CORNER_PATH[c]}" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CORNER_ICONS = { tl: cornerIcon('tl'), tr: cornerIcon('tr'), br: cornerIcon('br'), bl: cornerIcon('bl') };
const CORNER_TITLE = { tl: 'Top-left', tr: 'Top-right', br: 'Bottom-right', bl: 'Bottom-left' };

// Uniform corner-radius field with a toggle to switch to independent corners.
function radiusField(node) {
  const on = node.radiusMode === 'corners';
  const disabled = on || node.shape === 'circle';
  return `<label class="input-affix sizemode" title="Corner radius">`
    + `<span class="input-affix-label icon">${RADIUS_ICON}</span>`
    + `<input class="prop-input bare" id="p-radius" type="number" value="${node.radius}" min="0" ${disabled ? 'disabled' : ''}>`
    + `<button type="button" class="affix-toggle ${on ? 'active' : ''}" data-radius-toggle title="${on ? 'Uniform radius' : 'Independent corners'}">${SIDES_ICON}</button>`
    + `</label>`;
}

// One per-corner radius input (shown when radiusMode === 'corners').
function cornerField(node, c) {
  const r = node.radii || { tl: 0, tr: 0, br: 0, bl: 0 };
  return `<label class="input-affix" title="${CORNER_TITLE[c]}"><span class="input-affix-label icon">${CORNER_ICONS[c]}</span><input class="prop-input bare" id="p-rad-${c}" type="number" value="${r[c]}" min="0"></label>`;
}

// Markup for a Padding/Margin section. Collapsed → Horizontal (left+right) and
// Vertical (top+bottom); expanded → Top/Right/Bottom/Left. `prefix` is 'pad'/'mar'.
function boxSection(title, prefix, box) {
  const expanded = boxExpanded[prefix];
  const field = (icon, id, val, title) => `<label class="input-affix" title="${title}"><span class="input-affix-label icon">${BOX_ICONS[icon]}</span><input class="prop-input bare" id="p-${prefix}-${id}" type="number" value="${val}" min="0"></label>`;
  const fields = expanded
    ? field('t', 't', box.t, 'Top') + field('r', 'r', box.r, 'Right') + field('b', 'b', box.b, 'Bottom') + field('l', 'l', box.l, 'Left')
    : field('h', 'h', box.l, 'Horizontal') + field('v', 'v', box.t, 'Vertical');
  return `
    <div class="prop-section">
      <div class="prop-section-head">
        <div class="prop-section-title">${title}</div>
        <button class="box-toggle ${expanded ? 'active' : ''}" data-box-toggle="${prefix}" title="${expanded ? 'Combine to horizontal / vertical' : 'Edit each side'}">${SIDES_ICON}</button>
      </div>
      <div class="box-grid">${fields}</div>
    </div>`;
}

const DEFAULT_SHADOW = { x: 0, y: 4, blur: 12, spread: 0, colorId: null, alpha: 0.25 };

// Drop-shadow section (container/image). The "+" adds a shadow; each shadow has
// its own × to remove it (multiple shadows stack as a CSS box-shadow list).
function shadowSection(node) {
  const list = node.shadows || [];
  return `
    <div class="prop-section">
      <div class="prop-section-head">
        <div class="prop-section-title">Shadow</div>
        <button class="box-toggle" data-shadow-add title="Add shadow">${PLUS_ICON}</button>
      </div>
      ${list.map((s, i) => shadowItem(s, i, node.type === 'text')).join('')}
    </div>`;
}

// A text's shadow has no spread and no inner option (Flutter's text Shadow has neither).
function shadowItem(s, i, isText = false) {
  const field = (label, key, val, min) => `<label class="input-affix" title="${esc(label)}"><span class="input-affix-label">${label[0]}</span><input class="prop-input bare" id="p-sh-${key}-${i}" type="number"${min ? ' min="0"' : ''} value="${val}"></label>`;
  return `
    <div class="shadow-item">
      <div class="shadow-item-head">
        ${isText ? `<span class="shadow-item-title">Shadow ${i + 1}</span>` : `<div class="shadow-kind" title="Drop shadows fall outside the box; inner shadows sit inside its edges (pressed buttons, inset fields)">
          <button type="button" class="${s.inset ? '' : 'active'}" data-shkind="drop" data-shidx="${i}">Drop</button>
          <button type="button" class="${s.inset ? 'active' : ''}" data-shkind="inner" data-shidx="${i}">Inner</button>
        </div>`}
        <button class="model-del" data-shadow-del="${i}" title="Remove shadow">&times;</button>
      </div>
      <div class="box-grid">
        ${field('X offset', 'x', s.x)}${field('Y offset', 'y', s.y)}${field('Blur', 'blur', s.blur, true)}${isText ? '' : field('Spread', 'spread', s.spread)}
      </div>
      <div class="color-pick-grid${shadowExpanded.has(i) ? '' : ' collapsed'}" id="p-shadow-grid-${i}" style="margin-top:14px">
        <button class="color-pick none ${!s.colorId ? 'selected' : ''}" data-shadowcolor="" data-shidx="${i}" title="Black (default)"></button>
        ${state.colors.filter(c => c.fillType === 'solid').map(c => `<button class="color-pick ${s.colorId === c.id ? 'selected' : ''}" data-shadowcolor="${c.id}" data-shidx="${i}" title="${esc(c.name)}" style="background:${swatchBg(c)}"></button>`).join('')}
      </div>
      <button type="button" class="color-show-all" id="p-shadow-showall-${i}" hidden></button>
      <div style="height:8px"></div>
      <div class="prop-row">
        <span class="prop-label" style="width:auto">Opacity</span>
        <input class="prop-input" id="p-sh-alpha-${i}" type="number" min="0" max="100" value="${Math.round((s.alpha == null ? 0.25 : s.alpha) * 100)}" style="width:56px;flex:0 0 auto">
      </div>
    </div>`;
}

// Wire a Padding/Margin section's inputs in whichever mode it's currently in.
function bindBox(prefix, box, node) {
  if (boxExpanded[prefix]) {
    bindPropNum(`p-${prefix}-t`, v => { box.t = Math.max(0, v); updateNodeEl(node); });
    bindPropNum(`p-${prefix}-r`, v => { box.r = Math.max(0, v); updateNodeEl(node); });
    bindPropNum(`p-${prefix}-b`, v => { box.b = Math.max(0, v); updateNodeEl(node); });
    bindPropNum(`p-${prefix}-l`, v => { box.l = Math.max(0, v); updateNodeEl(node); });
  } else {
    bindPropNum(`p-${prefix}-h`, v => { box.l = box.r = Math.max(0, v); updateNodeEl(node); });
    bindPropNum(`p-${prefix}-v`, v => { box.t = box.b = Math.max(0, v); updateNodeEl(node); });
  }
}
const FIT_OPTIONS = [
  { value: 'cover', label: 'cover' }, { value: 'contain', label: 'contain' },
  { value: 'fill', label: 'fill' }, { value: 'fitWidth', label: 'fit width' },
  { value: 'fitHeight', label: 'fit height' },
];

// All custom dropdowns in the panel route their selection here (one delegated
// listener; the panel rebuilds its innerHTML but #props-fields itself persists).
propsFields.addEventListener('dd:change', e => {
  const node = getNode([...state.selected][0]);
  if (!node) return;
  const v = e.detail.value;
  switch (e.target.dataset.pp) {
    case 'fit': node.fit = v; updateNodeEl(node); break;
    case 'sstyle': node.strokeStyle = v; updateNodeEl(node); renderProps(); break;
    case 'repeat-src':
      if (v) node.repeat = { source: v, as: aliasOf(node) }; else delete node.repeat;
      commitData(); break;
    case 'bind': {
      const slot = e.target.dataset.slot;
      node.bind = { ...(node.bind || {}) };
      if (v) node.bind[slot] = v; else { delete node.bind[slot]; openBinds.delete(node.id + ':' + slot); }
      if (!Object.keys(node.bind).length) delete node.bind;
      commitData(); break;
    }
    case 'cond-path':
      if (v) node.showIf = { path: v, op: (node.showIf && node.showIf.op) || 'truthy', value: node.showIf ? node.showIf.value : '' };
      else delete node.showIf;
      commitData(); break;
    case 'cond-op': if (node.showIf) { node.showIf.op = v; commitData(); } break;
    case 'cond-value': if (node.showIf) { node.showIf.value = v; commitData(); } break;
    case 'route-path': case 'route-op': case 'route-value': case 'route-target': {
      const r = node.action && node.action.routes && node.action.routes[Number(e.target.dataset.route)];
      if (!r) break;
      const pp = e.target.dataset.pp;
      if (pp === 'route-target') r.target = v || null;
      else {
        r.when = { ...(r.when || { op: 'truthy' }) };
        if (pp === 'route-path') r.when.path = v;
        if (pp === 'route-op') r.when.op = v;
        if (pp === 'route-value') r.when.value = v;
      }
      commitData(); break;
    }
    case 'wmode': setSizeMode(node, 'w', v); break;
    case 'hmode': setSizeMode(node, 'h', v); break;
    case 'tweight':
      if (node.typoId) node.fontWeightOverride = v || null; else node.fontWeight = v;
      updateNodeEl(node); renderProps(); saveHistory(); break;
    case 'typo': node.typoId = v || null; updateNodeEl(node); renderProps(); saveHistory(); break;
    case 'act-type': case 'act-target': case 'act-mode': case 'act-trans':
      setAction(node, e.target.dataset.pp, v); break;
    case 'tcolor': node.colorId = v || null; updateNodeEl(node); renderProps(); saveHistory(); break;
  }
});

// A data change affects copies and other screens' links, so it re-renders fully.
function commitData() { saveHistory(); render(); }

// The Data section's text inputs and the routes' add / remove buttons.
function bindDataInputs(node) {
  const asEl = document.getElementById('p-repeat-as');
  asEl?.addEventListener('change', () => {
    const v = asEl.value.trim();
    // An alias is a Dart variable in the generated code, and mustn't hide a mock set.
    if (!/^[a-z][A-Za-z0-9_]*$/.test(v) || state.mockSets.some(m => m.name === v)) { asEl.value = aliasOf(node); return; }
    node.repeat = { ...node.repeat, as: v };
    commitData();
  });
  const cv = document.getElementById('p-cond-value');
  cv?.addEventListener('change', () => { if (node.showIf) { node.showIf.value = cv.value; commitData(); } });
  document.querySelectorAll('[id^="p-route-value-"]').forEach(inp => inp.addEventListener('change', () => {
    const r = node.action && node.action.routes && node.action.routes[Number(inp.id.split('-').pop())];
    if (r) { r.when = { ...(r.when || { op: 'truthy' }), value: inp.value }; commitData(); }
  }));
  document.getElementById('p-add-route')?.addEventListener('click', () => {
    if (!node.action || node.action.type !== 'navigate') {
      node.action = { type: 'navigate', targetFrameId: null, mode: 'push', transition: 'platform', ...(node.action && node.action.type === 'navigate' ? node.action : {}) };
    }
    node.action.routes = [...(node.action.routes || []), { when: { path: '', op: 'truthy', value: '' }, target: null }];
    commitData();
  });
  document.querySelectorAll('[data-del-route]').forEach(btn => btn.addEventListener('click', () => {
    node.action.routes.splice(Number(btn.dataset.delRoute), 1);
    if (!node.action.routes.length) delete node.action.routes;
    commitData();
  }));
}

// ───────── Navigation / Interactions (Phase 1: design only) ─────────
// Screens are the top-level frame nodes.
function screenFrames() { return state.nodes.filter(n => n.type === 'frame'); }
function slugifyName(name) {
  const s = (name || 'screen').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return '/' + (s || 'screen');
}
function routeOf(frame) {
  return frame.routePath && frame.routePath.trim() ? frame.routePath.trim() : slugifyName(frame.name);
}
// A route must be lowercase dashed-case with no spaces (e.g. /user-profile),
// optionally with nested "/" segments. Returns an error string, or null if ok.
export function routeError(r) {
  const v = (r || '').trim();
  if (!v || v === '/') return null;
  if (/\s/.test(v)) return 'No spaces — use dashes, e.g. /user-profile';
  if (/[A-Z]/.test(v)) return 'Lowercase only, e.g. /user-profile';
  if (!/^\/?[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(v))
    return 'Use dashed-case, e.g. /user-profile';
  return null;
}

// A frame name becomes a Dart file + class in generated code, so it must be a
// clean snake_case identifier: lowercase, no spaces, not starting with a number
// (e.g. home_page). Returns an error string, or null if ok.
export function frameNameError(name) {
  const v = (name || '').trim();
  if (!v) return 'Name can’t be empty';
  if (/\s/.test(v)) return 'No spaces — use snake_case, e.g. home_page';
  if (/[A-Z]/.test(v)) return 'Lowercase only — use snake_case, e.g. home_page';
  if (/^[0-9]/.test(v)) return 'Can’t start with a number';
  if (!/^[a-z_][a-z0-9_]*$/.test(v)) return 'Use snake_case, e.g. home_page';
  return null;
}

// Nodes whose name becomes a code identifier: a frame (→ file + class) or a
// section (→ folder). Both are validated as snake_case in the panel.
function isIdentNode(node) {
  return node.type === 'frame' || node.type === 'section';
}

// True if any frame or section has an invalid name (or, for frames, route).
// Export is gated on this so screens can't generate into broken Dart / a broken
// folder name. Checks every such node, matching what the props panel flags.
export function anyFrameError() {
  return state.nodes.some(n =>
    (n.type === 'frame' && (frameNameError(n.name) !== null || routeError(routeOf(n)) !== null)) ||
    (n.type === 'section' && frameNameError(n.name) !== null));
}

// The page-level screen frame a node belongs to: the outermost ancestor frame
// that sits at the canvas root or directly inside a Section. (A frame nested in
// another frame is a component, so we keep climbing past it.)
function ownerScreenId(node) {
  let cur = node, screen = null;
  while (cur) {
    if (cur.type === 'frame') {
      const p = cur.parentId ? getNode(cur.parentId) : null;
      if (!p || p.type === 'section') screen = cur.id;
    }
    cur = cur.parentId ? getNode(cur.parentId) : null;
  }
  return screen;
}

// How many *other* screens have a layer whose tap navigates to this frame.
function incomingScreenCount(node) {
  const screens = new Set();
  state.nodes.forEach(n => {
    if (n.action && n.action.type === 'navigate' && n.action.targetFrameId === node.id) {
      const owner = ownerScreenId(n);
      if (owner && owner !== node.id) screens.add(owner);
    }
  });
  return screens.size;
}

// Route + start-screen controls, shown for frame nodes.
function screenSection(node) {
  const inbound = incomingScreenCount(node);
  const inboundText = inbound === 0
    ? 'No other screens navigate here.'
    : `${inbound} other screen${inbound === 1 ? '' : 's'} navigate${inbound === 1 ? 's' : ''} here.`;
  return `
    <div class="prop-section">
      <div class="prop-section-title">Screen</div>
      <div class="prop-row">
        <span class="prop-label" style="width:auto">Route</span>
        <input class="prop-input${routeError(routeOf(node)) ? ' invalid' : ''}" id="p-route" value="${esc(routeOf(node))}" placeholder="/home" style="flex:1">
      </div>
      <div class="prop-error" id="p-route-err" style="${routeError(routeOf(node)) ? '' : 'display:none'}">${routeError(routeOf(node)) || ''}</div>
      <label class="prop-check" style="margin-top:8px">
        <input type="checkbox" id="p-initial" ${node.isInitial ? 'checked' : ''}>
        <span>Start screen (app opens here)</span>
      </label>
      <div style="font-size:11px;color:var(--text3);margin-top:6px">${inboundText}</div>
    </div>`;
}

// ───────── Components ─────────
// An instance says what it's an instance of (it takes its size from there), with
// the way back to the component and the way out (detach). A master says it's a
// component and how many copies it has, and places another.
function componentSection(node) {
  if (node.type === 'instance') {
    const c = getComponent(node.componentId);
    const master = getMasterNode(node.componentId);
    return `<div class="prop-section">
      <div class="prop-section-title">Component</div>
      ${master ? `
      <div class="comp-line">Instance of <b>${esc(componentName(c))}</b></div>
      <div class="api-hint">Its design and size come from the component \u2014 edit the component to change every instance.</div>
      <div class="comp-actions">
        <button type="button" class="comp-btn" id="p-comp-go">Go to component</button>
        <button type="button" class="comp-btn" id="p-comp-detach" title="Turn into a regular, editable copy">Detach</button>
      </div>` : `
      <div class="comp-line">Its component was deleted.</div>`}
    </div>`;
  }
  if (isMaster(node)) {
    const c = getComponent(node.componentId);
    const n = instancesOf(node.componentId).length;
    return `<div class="prop-section">
      <div class="prop-section-title">Component</div>
      <div class="comp-line"><b>${esc(componentName(c))}</b> \u00b7 ${n} instance${n === 1 ? '' : 's'}</div>
      <div class="api-hint">Changes here show in every instance. Renaming this layer renames the component.</div>
      <div class="comp-actions"><button type="button" class="comp-btn" id="p-comp-place">Place an instance</button></div>
    </div>`;
  }
  return '';
}

function bindComponentButtons(node) {
  document.getElementById('p-comp-go')?.addEventListener('click', () => {
    const c = getComponent(node.componentId);
    if (c) goToNode(c.rootId);
  });
  document.getElementById('p-comp-detach')?.addEventListener('click', () => {
    if (detachInstance(node)) { saveHistory(); render(); }
  });
  document.getElementById('p-comp-place')?.addEventListener('click', () => {
    state.selected.clear(); // place on the canvas, not inside the master
    placeInstance(node.componentId);
  });
}

// ───────── Data (mock data in the design) ─────────
// Bind an element's text / image / fill / color to a mock-data field, show it only
// while a condition holds, or repeat a container's children once per list item.
// Rules and evaluation live in data.js; this is only the panel.

// A path picker for one slot, keeping a now-broken path visible (flagged).
function pathPicker(scope, slot, value, data) {
  const opts = [{ value: '', label: '—' }, ...pathOptions(scope, slot).map(o => ({
    value: o.path, label: o.source === 'provider' ? `${o.path} \u00b7 provider` : o.path,
  }))];
  if (value && !opts.some(o => o.value === value)) opts.push({ value, label: '\u26a0 ' + value });
  return ddTrigger({ value: value || '', options: opts, data, triggerClass: 'dd-block' });
}

// The value to compare against: the enum's values or true/false when the path
// has those types, free text otherwise. Unary ops (is set, is empty…) need none.
function condValueControl(scope, cond, data, inputId) {
  if (!cond.path || isUnary(cond.op || 'truthy')) return '';
  const t = pathType(scope, cond.path).type;
  const en = t && state.enums.find(e => e.name === t.base);
  if (en || (t && t.base === 'bool')) {
    const opts = en ? en.values.map(v => ({ value: v.name, label: v.name })) : [{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }];
    return ddTrigger({ value: cond.value == null ? '' : String(cond.value), options: [{ value: '', label: '—' }, ...opts], data, triggerClass: 'dd-block' });
  }
  return `<input class="prop-input" id="${inputId}" value="${esc(cond.value == null ? '' : cond.value)}" placeholder="value" spellcheck="false">`;
}

const opPicker = (op, data) => ddTrigger({ value: op || 'truthy', options: OPS.map(o => ({ value: o.value, label: o.label })), data, triggerClass: 'dd-block' });
const dataRow = (label, control) => `<div class="prop-row data-row"><span class="prop-label-wide">${label}</span>${control}</div>`;

// Behavior: what shapes the element's structure from data — repeated once per
// list item, or shown only while a condition holds. Near the top of the panel,
// since it decides whether (and how many times) the element exists at all.
function behaviorSection(node) {
  if (node.type === 'section') return '';
  const scope = scopeFor(node);
  if (!Object.keys(scope).length) {
    return canRepeat(node) ? `<div class="prop-section"><div class="prop-section-title">Behavior</div>
      <div class="api-hint">Add mock data in the Mock Data tab to repeat this for each item of a list, or show it only when a condition holds.</div></div>` : '';
  }
  const rows = [];
  if (canRepeat(node)) {
    rows.push(dataRow('Repeat', pathPicker(scope, 'list', node.repeat && node.repeat.source, { pp: 'repeat-src' })));
    if (node.repeat) rows.push(dataRow('Each as', `<input class="prop-input" id="p-repeat-as" value="${esc(aliasOf(node))}" spellcheck="false">`));
  }
  if (node.type !== 'frame') {
    const c = node.showIf || {};
    rows.push(dataRow('Show if', pathPicker(scope, 'cond', c.path, { pp: 'cond-path' })));
    if (c.path) {
      rows.push(dataRow('', opPicker(c.op, { pp: 'cond-op' })));
      const vc = condValueControl(scope, c, { pp: 'cond-value' }, 'p-cond-value');
      if (vc) rows.push(dataRow('', vc));
    }
  }
  if (!rows.length) return '';
  const item = Object.keys(scope).find(k => !state.mockSets.some(m => m.name === k) && !state.providers.some(pr => pr.name === k));
  return `<div class="prop-section"><div class="prop-section-title">Behavior</div>
    ${rows.join('')}
    ${node.repeat ? `<div class="api-hint" style="margin-top:6px">Design the first copy; the others follow it, one per item.</div>` : ''}
    ${!node.repeat && item && node.type !== 'frame' ? `<div class="api-hint" style="margin-top:6px">Inside a repeat \u2014 bind to its item (e.g. ${esc(item)}.\u2026) to show each copy's own data.</div>` : ''}
  </div>`;
}

// Binding one property to data, right under the property it drives: a small
// "Bind to data" button, which opens a picker of the mock-data / provider paths
// that fit; once bound, the picker shows the path ("—" unbinds). Nothing when
// there's no data in scope to bind to.
const LINK_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
const openBinds = new Set(); // "<node id>:<slot>" pickers opened but not bound yet
function bindControl(node, slot) {
  if (node.type === 'section') return '';
  const scope = scopeFor(node);
  if (!Object.keys(scope).length) return '';
  const path = node.bind && node.bind[slot];
  if (!path && !openBinds.has(node.id + ':' + slot)) {
    return `<button type="button" class="bind-btn" data-bind-open="${slot}" title="Take this from mock data or a provider">${LINK_ICON}Bind to data</button>`;
  }
  return `<div class="prop-row bind-row${path ? ' bound' : ''}">
    <span class="bind-ic" title="${path ? 'From data' : 'Pick the data to show'}">${LINK_ICON}</span>
    ${pathPicker(scope, slot, path, { pp: 'bind', slot })}
    ${path ? '' : `<button type="button" class="prop-del" data-bind-close="${slot}" title="Cancel">&times;</button>`}
  </div>`;
}

// Conditional routes: tried in order before the tap's own target.
function routesEditor(node) {
  const a = node.action || {};
  const scope = scopeFor(node);
  const screens = state.nodes.filter(n => n.type === 'frame' && (!n.parentId || getNode(n.parentId)?.type === 'section'));
  if (!Object.keys(scope).length || !screens.length || a.type === 'back') return '';
  const screenOpts = screens.map(f => ({ value: f.id, label: f.name }));
  const rows = (a.routes || []).map((r, i) => {
    const when = r.when || {};
    const vc = condValueControl(scope, when, { pp: 'route-value', route: i }, `p-route-value-${i}`);
    return `<div class="route-card">
      <div class="prop-row data-row"><span class="prop-label-wide">If</span>${pathPicker(scope, 'cond', when.path, { pp: 'route-path', route: i })}
        <button type="button" class="prop-del" data-del-route="${i}" title="Remove route">&times;</button></div>
      ${when.path ? dataRow('', opPicker(when.op, { pp: 'route-op', route: i })) : ''}
      ${vc ? dataRow('', vc) : ''}
      ${dataRow('Go to', ddTrigger({ value: r.target || '', options: [{ value: '', label: '—' }, ...screenOpts], data: { pp: 'route-target', route: i }, triggerClass: 'dd-block' }))}
    </div>`;
  }).join('');
  return `<div class="routes-block">
    <div class="prop-section-sub">Conditional routes</div>
    ${rows}
    <button type="button" class="prop-add" id="p-add-route">+ Add route</button>
    ${(a.routes || []).length ? `<div class="api-hint" style="margin-top:6px">Checked in order; if none match, the tap goes to the screen above${a.targetFrameId ? '' : ' (none chosen, so nothing happens)'}.</div>` : ''}
  </div>`;
}

// ───────── Prototype mode: the Interactions panel ─────────
// In Prototype (Connect) mode the right panel shows what tapping the selected
// layer does, and every part of it is edited here: the action (navigate to a
// screen, go back, or nothing), where it goes, how (stack mode, transition),
// and conditional routes. Dragging from a layer to a screen is the quick way to
// make a link; the arrow's popover edits the basics too.
const ACTIONS = [
  { value: 'none', label: 'Nothing' },
  { value: 'navigate', label: 'Navigate to screen' },
  { value: 'back', label: 'Go back' },
];
const NAV_MODES = [{ value: 'push', label: 'Push' }, { value: 'replace', label: 'Replace' }, { value: 'clear', label: 'Clear stack' }];
const TRANSITIONS = [{ value: 'platform', label: 'Platform' }, { value: 'fade', label: 'Fade' }, { value: 'slideRight', label: 'Slide' }, { value: 'none', label: 'None' }];
const NO_ACTION = () => ({ type: 'none', targetFrameId: null, mode: 'push', transition: 'platform' });
const actionType = (node) => (node.action && ['navigate', 'back'].includes(node.action.type) ? node.action.type : 'none');
const isScreen = (n) => n.type === 'frame' && (!n.parentId || getNode(n.parentId)?.type === 'section');

const panelTitle = () => document.querySelector('#props-panel .panel-title');
const NO_SELECTION_DESIGN = 'Select an element<br>to edit its properties';

function renderInteractionsPanel() {
  const title = panelTitle();
  if (title) title.textContent = 'Interactions';
  const node = state.selected.size === 1 ? getNode([...state.selected][0]) : null;
  if (!node || node.type === 'frame' || node.type === 'section') {
    noSelection.innerHTML = node
      ? 'Screens aren’t tapped — select a layer on one,<br>or drag from a layer to this screen to link it'
      : 'Select a layer to set what tapping it does,<br>or drag from a layer to a screen to link them';
    noSelection.style.display = '';
    propsFields.style.display = 'none';
    return;
  }
  noSelection.style.display = 'none';
  propsFields.style.display = '';

  const a = node.action || {};
  const type = actionType(node);
  const screens = state.nodes.filter(isScreen);
  const readonly = state.readonly;
  const dd = (pp, value, options) => ddTrigger({ value, options, data: { pp }, triggerClass: 'dd-block' });
  const hint = (text) => `<div class="api-hint" style="margin-top:6px">${text}</div>`;

  let details = '';
  if (type === 'navigate') {
    details = `
      ${dataRow('Go to', dd('act-target', a.targetFrameId || '', [{ value: '', label: '— choose a screen —' }, ...screens.map(f => ({ value: f.id, label: f.name }))]))}
      ${dataRow('Stack', dd('act-mode', a.mode || 'push', NAV_MODES))}
      ${dataRow('Transition', dd('act-trans', a.transition || 'platform', TRANSITIONS))}
      ${!screens.length ? hint('Add a screen to navigate to.') : ''}`;
  } else if (type === 'back') {
    details = hint('Returns to the previous screen — in Play, and as <code>AppRoutes.pop()</code> in the exported app.');
  } else {
    details = hint('Tapping does nothing. Pick an action, or drag from this layer to a screen.');
  }

  const routes = type === 'navigate' ? routesEditor(node) : '';
  propsFields.innerHTML = `
    <div class="prop-section">
      <div class="interaction-layer">${esc(node.name || node.type)}</div>
      ${node.parentId ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">in <span style="color:var(--accent)">${esc(getNode(node.parentId)?.name || '?')}</span></div>` : ''}
    </div>
    <div class="prop-section">
      <div class="prop-section-title">On tap</div>
      ${dataRow('Action', dd('act-type', type, ACTIONS))}
      ${details}
    </div>
    ${routes ? `<div class="prop-section">${routes}</div>` : ''}
    ${type !== 'none' && !readonly ? `<div class="prop-section"><button type="button" class="prop-add interaction-remove" id="p-act-remove">Remove interaction</button></div>` : ''}`;

  if (readonly) propsFields.querySelectorAll('.dd-trigger, button, input').forEach(el => { el.disabled = true; });
  document.getElementById('p-act-remove')?.addEventListener('click', () => {
    node.action = NO_ACTION();
    saveHistory();
    render();
  });
  bindDataInputs(node); // the conditional routes' inputs and buttons
}

// An action picked in the Interactions panel.
function setAction(node, field, v) {
  const a = node.action || {};
  if (field === 'act-type') {
    if (v === 'navigate') {
      node.action = { type: 'navigate', targetFrameId: a.targetFrameId || null, mode: a.mode || 'push', transition: a.transition || 'platform', ...(a.routes ? { routes: a.routes } : {}) };
    } else if (v === 'back') {
      node.action = { type: 'back', targetFrameId: null, mode: 'push', transition: 'platform' };
    } else {
      node.action = NO_ACTION();
    }
  } else {
    if (!node.action || node.action.type !== 'navigate') return;
    if (field === 'act-target') node.action.targetFrameId = v || null;
    if (field === 'act-mode') node.action.mode = v;
    if (field === 'act-trans') node.action.transition = v;
  }
  saveHistory();
  render(); // arrows, badges and this panel
}

// Container auto-layout choices, shown as a row of icon toggles. 'Stack' overlaps
// absolutely-positioned children, which can't scroll, so it's disabled while the
// container scrolls. Reuses the toolbar's row/column/wrap/stack glyphs.
const LAYOUT_CHOICES = [
  { value: 'none', icon: 'layout-none', title: 'None' },
  { value: 'row', icon: 'row', title: 'Row' },
  { value: 'column', icon: 'column', title: 'Column' },
  { value: 'wrap', icon: 'wrap', title: 'Wrap' },
  { value: 'stack', icon: 'stack', title: 'Stack' },
];

function layoutSection(node) {
  const cur = node.layout || 'none';
  // Scroll is a container-only on/off toggle; its axis follows the layout, so it's
  // only offered for Row (→ horizontal) and Column (→ vertical).
  const scrollable = node.type === 'container' && (cur === 'row' || cur === 'column');
  const scrollOn = !!node.scroll && node.scroll !== 'none';
  const btns = LAYOUT_CHOICES.map(c =>
    `<button class="layout-btn ${cur === c.value ? 'active' : ''}" data-layout="${c.value}" title="${c.title}"><img src="/assets/icons/${c.icon}.svg" alt="${c.title}"></button>`
  ).join('');
  return `
    <div class="prop-section">
      <div class="prop-section-title">Layout</div>
      <div class="layout-toggle">${btns}</div>
      ${cur === 'row' || cur === 'column' ? `
      <div class="prop-row" style="margin-top:8px">
        <span class="prop-label-wide">Gap</span>
        <input class="prop-input" id="p-gap" type="number" value="${node.gap}" min="0">
      </div>` : ''}
      ${cur === 'wrap' ? `
      <div class="prop-row" style="margin-top:8px">
        <span class="prop-label-wide">Gap H</span>
        <input class="prop-input" id="p-gaph" type="number" value="${node.gapH}" min="0">
        <span class="prop-label-wide">Gap V</span>
        <input class="prop-input" id="p-gapv" type="number" value="${node.gapV}" min="0">
      </div>` : ''}
      ${scrollable ? `
      <div class="prop-row" style="margin-top:8px">
        <span class="prop-label-wide">Scroll</span>
        <label class="switch" style="margin-left:auto"><input type="checkbox" id="p-scroll"${scrollOn ? ' checked' : ''}><span class="switch-track"></span></label>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:6px">${cur === 'row' ? 'Scrolls horizontally (hold Shift + wheel).' : 'Scrolls vertically.'} Needs a fixed ${cur === 'row' ? 'width' : 'height'} and overflowing content.</div>` : ''}
    </div>`;
}

// Switch a container's layout. A full render re-flows the children under the new
// layout (flex vs. absolute) and refreshes the panel. Scroll only takes effect on
// Row/Column layouts (see applyScroll), so no need to clear it here.
function setLayout(node, layout) {
  node.layout = layout;
  render();
  saveHistory();
}

// Node types whose width/height can be Fixed / Fill / Hug.
const SIZE_MODE_TYPES = ['container', 'image'];

// Apply a new sizing mode for one axis. Leaving a fluid mode for 'fixed' freezes
// the current rendered size, so the box stays put. A full re-render is needed so
// parents that hug / children that fill recompute, and the dropdown's option
// availability (which depends on parent/child modes) refreshes.
function setSizeMode(node, axis, mode) {
  const el = document.getElementById('node-' + node.id);
  if (el) { if (axis === 'w') node.w = el.offsetWidth; else node.h = el.offsetHeight; }
  if (node.type === 'text' && axis === 'w') {
    // For text, Hug == auto width (no wrap); Fixed/Fill are the wrapping modes.
    node.autoSize = (mode === 'hug');
    node.wMode = mode;
  } else if (axis === 'w') { node.wMode = mode; } else { node.hMode = mode; }
  render();
  saveHistory();
}

// The three sizing options for one axis, with Fill/Hug disabled (greyed, with a
// reason) when they'd be invalid:
//   Fill — needs a parent, and that parent must not be hugging this same axis.
//   Hug  — needs a child, and no child may be filling this same axis.
function sizeModeOptions(node, axis) {
  // Text width offers the same three modes as a container, but "Hug" means fit
  // the text (auto width) rather than hug children.
  if (node.type === 'text' && axis === 'w') {
    const parent = node.parentId ? getNode(node.parentId) : null;
    const parentHugs = parent && parent.wMode === 'hug';
    const fillOk = !!parent && !parentHugs;
    return [
      { value: 'fixed', label: 'Fixed' },
      { value: 'fill', label: 'Fill container', disabled: !fillOk,
        title: !parent ? 'Needs a parent' : (parentHugs ? 'Parent is hugging its width' : '') },
      { value: 'hug', label: 'Hug (auto width)' },
    ];
  }
  const key = axis === 'w' ? 'wMode' : 'hMode';
  const dim = axis === 'w' ? 'width' : 'height';
  const parent = node.parentId ? getNode(node.parentId) : null;
  const parentHugs = parent && parent[key] === 'hug';
  const fillOk = !!parent && !parentHugs;

  const kids = (node.children || []).map(getNode).filter(Boolean);
  const kidFills = kids.some(c => c[key] === 'fill');
  const hugOk = kids.length > 0 && !kidFills;

  return [
    { value: 'fixed', label: 'Fixed' },
    { value: 'fill', label: 'Fill container', disabled: !fillOk,
      title: !parent ? 'Needs a parent' : (parentHugs ? `Parent is hugging its ${dim}` : '') },
    { value: 'hug', label: 'Hug children', disabled: !hugOk,
      title: kids.length === 0 ? 'No children to hug' : (kidFills ? `A child is filling this ${dim}` : '') },
  ];
}

const SIZE_MODE_LABEL = { fill: 'Fill container', hug: 'Hug children' };

// One W/H field for a sizable node: label + value + a caret that opens the mode
// menu. Fixed → an editable number; Fill/Hug → the mode name (input disabled).
function sizeField(node, axis) {
  const mode = (axis === 'w' ? node.wMode : node.hMode) || 'fixed';
  const id = axis === 'w' ? 'p-w' : 'p-h';
  const px = Math.round(axis === 'w' ? node.w : node.h);
  const value = mode === 'fixed'
    ? `<input class="prop-input bare" id="${id}" type="number" value="${px}">`
    : `<span class="affix-modetext">${SIZE_MODE_LABEL[mode]}</span>`;
  // A bare .dd-trigger (icon only) — keeps the shared dropdown wiring but shows
  // the arrow-down.svg glyph instead of the tiny text caret.
  const opts = esc(JSON.stringify(sizeModeOptions(node, axis)));
  const caret = `<button type="button" class="dd-trigger affix-caret" data-dd-value="${esc(mode)}" data-dd-options="${opts}" data-pp="${axis === 'w' ? 'wmode' : 'hmode'}"><img class="affix-caret-icon" src="/assets/icons/arrow-down.svg" alt=""></button>`;
  return `<label class="input-affix sizemode"><span class="input-affix-label">${axis === 'w' ? 'W' : 'H'}</span>${value}${caret}</label>`;
}

// A plain read-only size input (frame, or text whose size is content-driven).
function plainSizeField(node, axis) {
  const id = axis === 'w' ? 'p-w' : 'p-h';
  const val = Math.round(axis === 'w' ? node.w : node.h);
  const title = node.type === 'frame' ? 'Frame size is fixed'
    : axis === 'w' ? 'Auto width fits the text' : 'Text height fits its content';
  return `<label class="input-affix disabled"><span class="input-affix-label">${axis === 'w' ? 'W' : 'H'}</span><input class="prop-input bare" id="${id}" type="number" value="${val}" readonly title="${title}"></label>`;
}

// A plain editable size input (section — freely resizable, no Fill/Hug modes).
function editSizeField(node, axis) {
  const id = axis === 'w' ? 'p-w' : 'p-h';
  const val = Math.round(axis === 'w' ? node.w : node.h);
  return `<label class="input-affix"><span class="input-affix-label">${axis === 'w' ? 'W' : 'H'}</span><input class="prop-input bare" id="${id}" type="number" value="${val}" min="1"></label>`;
}

// Width gains the Fixed/Fill/Hug dropdown for containers/images and for fixed-width
// text; height only for containers/images (text height always hugs its content).
function sizeWField(node) {
  if (node.type === 'section') return editSizeField(node, 'w');
  return (SIZE_MODE_TYPES.includes(node.type) || (node.type === 'text' && !node.autoSize))
    ? sizeField(node, 'w') : plainSizeField(node, 'w');
}
function sizeHField(node) {
  if (node.type === 'section') return editSizeField(node, 'h');
  return SIZE_MODE_TYPES.includes(node.type) ? sizeField(node, 'h') : plainSizeField(node, 'h');
}

// A swatch grid past two rows gets a "Show all" / "Show less" toggle that clamps
// it to two rows. Measured after render (scrollHeight reports the full height even
// while the grid is clamped), so the toggle only appears when needed. `get`/`set`
// read and write the caller's expanded flag so the choice survives re-render.
function setupShowAll(gridId, toggleId, get, set) {
  const grid = document.getElementById(gridId);
  const toggle = document.getElementById(toggleId);
  if (!grid || !toggle) return;
  // Two padded rows measure ~90px (80px of swatches + 10px padding); a third row
  // jumps past 120px. Anything at or under two rows needs no toggle.
  if (grid.scrollHeight <= 100) {
    toggle.hidden = true;
    grid.classList.remove('collapsed');
    return;
  }
  toggle.hidden = false;
  const sync = () => {
    grid.classList.toggle('collapsed', !get());
    toggle.textContent = get() ? 'Show less' : 'Show all';
  };
  sync();
  toggle.addEventListener('click', () => { set(!get()); sync(); });
}

export function renderProps() {
  if (state.tool === 'connect') { renderInteractionsPanel(); return; }
  const title = panelTitle();
  if (title && title.textContent !== 'Properties') title.textContent = 'Properties';
  if (noSelection.innerHTML !== NO_SELECTION_DESIGN) noSelection.innerHTML = NO_SELECTION_DESIGN;
  if (state.selected.size === 0) {
    noSelection.style.display = '';
    propsFields.style.display = 'none';
    return;
  }
  noSelection.style.display = 'none';
  propsFields.style.display = '';

  const node = getNode([...state.selected][0]);
  if (!node) return;

  propsFields.innerHTML = `
    <div class="prop-section">
      <div class="prop-row">
        <span class="prop-label-wide" style="width:100%;display:block">
          <input class="prop-input${isIdentNode(node) && frameNameError(node.name) ? ' invalid' : ''}" id="p-name" value="${esc(node.name)}" style="width:100%" placeholder="Layer name">
        </span>
      </div>
      ${isIdentNode(node) ? `<div class="prop-error" id="p-name-err" style="${frameNameError(node.name) ? '' : 'display:none'}">${frameNameError(node.name) || ''}</div>` : ''}
      ${node.parentId ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">in <span style="color:var(--accent)">${esc(getNode(node.parentId)?.name || '?')}</span></div>` : ''}
    </div>
    ${behaviorSection(node)}
    ${node.type === 'frame' ? screenSection(node) : ''}
    ${node.type === 'container' || node.type === 'frame' ? layoutSection(node) : ''}
    ${((node.type === 'container' || node.type === 'frame') && ['none', 'row', 'column'].includes(node.layout || 'none')) || node.type === 'row' || node.type === 'column' ? `
    <div class="prop-section">
      <div class="prop-section-title">Alignment</div>
      <div class="prop-row">
        <div class="align-row">
          <div class="align-group">
            <button class="align-btn ${node.alignment.h === 'left' ? 'active' : ''}" data-ah="left" title="Left"><img src="/assets/icons/alignment/left.svg" alt="Left"></button>
            <button class="align-btn ${node.alignment.h === 'center' ? 'active' : ''}" data-ah="center" title="Center"><img src="/assets/icons/alignment/center-horizontal.svg" alt="Center"></button>
            <button class="align-btn ${node.alignment.h === 'right' ? 'active' : ''}" data-ah="right" title="Right"><img src="/assets/icons/alignment/right.svg" alt="Right"></button>
          </div>
          <div class="align-group">
            <button class="align-btn ${node.alignment.v === 'top' ? 'active' : ''}" data-av="top" title="Top"><img src="/assets/icons/alignment/top.svg" alt="Top"></button>
            <button class="align-btn ${node.alignment.v === 'center' ? 'active' : ''}" data-av="center" title="Center"><img src="/assets/icons/alignment/center-vertical.svg" alt="Center"></button>
            <button class="align-btn ${node.alignment.v === 'bottom' ? 'active' : ''}" data-av="bottom" title="Bottom"><img src="/assets/icons/alignment/bottom.svg" alt="Bottom"></button>
          </div>
        </div>
      </div>
    </div>` : ''}
    <div class="prop-section">
      <div class="prop-section-title">Position</div>
      <div class="prop-row affix-row">
        <label class="input-affix"><span class="input-affix-label">X</span><input class="prop-input bare" id="p-x" type="number" value="${Math.round(node.x)}"></label>
        <label class="input-affix"><span class="input-affix-label">Y</span><input class="prop-input bare" id="p-y" type="number" value="${Math.round(node.y)}"></label>
      </div>
    </div>
    ${componentSection(node)}
    ${node.type === 'instance' ? '' : `
    <div class="prop-section">
      <div class="prop-section-title">Size</div>
      <div class="prop-row affix-row">
        ${sizeWField(node)}
        ${sizeHField(node)}
      </div>
    </div>`}
    ${node.type === 'container' || node.type === 'frame' ? boxSection('Padding', 'pad', node.padding) : ''}
    ${node.type === 'container' ? boxSection('Margin', 'mar', node.margin) : ''}
    ${node.type !== 'frame' && node.type !== 'section' ? `
    <div class="prop-section">
      <div class="prop-section-title">Appearance</div>
      <div class="prop-row affix-row">
        <label class="input-affix" title="Opacity"><span class="input-affix-label icon">${OPACITY_ICON}</span><input class="prop-input bare" id="p-opacity" type="number" value="${Math.round(node.opacity * 100)}" min="0" max="100"></label>
        ${node.type !== 'text' && node.type !== 'icon' && node.type !== 'instance' ? radiusField(node) : ''}
      </div>
      ${node.type !== 'text' && node.radiusMode === 'corners' && node.shape !== 'circle' ? `
      <div class="box-grid" style="margin-top:6px">
        ${cornerField(node, 'tl')}${cornerField(node, 'tr')}${cornerField(node, 'br')}${cornerField(node, 'bl')}
      </div>` : ''}
      <div class="prop-row" style="margin-top:6px">
        <label class="input-affix" style="flex:1" title="Rotation"><span class="input-affix-label icon">${ROTATION_ICON}</span><input class="prop-input bare" id="p-rotation" type="number" value="${Math.round(node.rotation || 0)}"></label>
        <button type="button" class="flip-btn" data-rotate="90" title="Rotate +90°">${ROTATE_CW_ICON}</button>
        <button type="button" class="flip-btn" data-rotate="-90" title="Rotate −90°">${ROTATE_CCW_ICON}</button>
        <button type="button" class="flip-btn ${node.flipH ? 'active' : ''}" style="margin-left:12px" data-flip="h" title="Flip horizontal">${FLIPH_ICON}</button>
        <button type="button" class="flip-btn ${node.flipV ? 'active' : ''}" data-flip="v" title="Flip vertical">${FLIPV_ICON}</button>
      </div>
    </div>` : ''}
    ${node.type === 'container' ? `
    <div class="prop-section">
      <div class="prop-section-title">Shape</div>
      <div class="shape-toggle">
        <button class="shape-btn ${node.shape !== 'circle' ? 'active' : ''}" data-shape="rect" title="Rectangle" aria-label="Rectangle">${SHAPE_RECT_ICON}</button>
        <button class="shape-btn ${node.shape === 'circle' ? 'active' : ''}" data-shape="circle" title="Circle" aria-label="Circle">${SHAPE_CIRCLE_ICON}</button>
      </div>
    </div>` : ''}
    ${node.type === 'row' || node.type === 'column' ? `
    <div class="prop-section">
      <div class="prop-section-title">Layout (${node.type})</div>
      <div class="prop-row">
        <span class="prop-label-wide">Gap</span>
        <input class="prop-input" id="p-gap" type="number" value="${node.gap}" min="0">
      </div>
    </div>` : ''}
    ${node.type === 'wrap' ? `
    <div class="prop-section">
      <div class="prop-section-title">Layout (wrap)</div>
      <div class="prop-row">
        <span class="prop-label-wide">Gap H</span>
        <input class="prop-input" id="p-gaph" type="number" value="${node.gapH}" min="0">
        <span class="prop-label-wide">Gap V</span>
        <input class="prop-input" id="p-gapv" type="number" value="${node.gapV}" min="0">
      </div>
    </div>` : ''}
    ${node.type === 'image' ? `
    <div class="prop-section">
      <div class="prop-section-title">Image</div>
      <div class="prop-row">
        <span class="prop-label-wide">Fit</span>
        ${ddTrigger({ value: node.fit || 'cover', options: FIT_OPTIONS, data: { pp: 'fit' }, triggerClass: 'dd-block' })}
      </div>
      ${bindControl(node, 'src')}
    </div>` : ''}
    ${node.type === 'icon' ? `
    <div class="prop-section">
      <div class="prop-section-title">Icon</div>
      <button class="goto-colors-btn" id="p-replace-icon">Replace icon…</button>
    </div>
    <div class="prop-section">
      <div class="prop-section-title">Color</div>
      ${state.colors.filter(c => c.fillType === 'solid').length === 0 ? `
      <div class="api-hint">No solid colors yet — icons show white.</div>` : `
      <div class="color-pick-grid">
        <button class="color-pick none ${!node.colorId ? 'selected' : ''}" data-iconcolor="" title="Default (white)"></button>
        ${state.colors.filter(c => c.fillType === 'solid').map(c => `<button class="color-pick ${node.colorId === c.id ? 'selected' : ''}" data-iconcolor="${c.id}" title="${esc(c.name)}" style="background:${swatchBg(c)}"></button>`).join('')}
      </div>`}
    </div>` : ''}
    ${node.type === 'frame' || node.type === 'container' || node.type === 'image' ? `
    <div class="prop-section">
      <div class="prop-section-title">Fill</div>
      ${state.colors.length === 0 ? `
      <div class="api-hint" style="margin-bottom:8px">No colors created yet.</div>
      <button class="goto-colors-btn" id="p-goto-colors">+ Create a color</button>` : `
      <div class="color-pick-grid${fillExpanded ? '' : ' collapsed'}" id="p-fill-grid">
        <button class="color-pick none ${!node.colorId ? 'selected' : ''}" data-pickcolor="" title="None"></button>
        ${state.colors.map(c => `<button class="color-pick ${node.colorId === c.id ? 'selected' : ''}" data-pickcolor="${c.id}" title="${esc(c.name)}" style="background:${swatchBg(c)}"></button>`).join('')}
      </div>
      <button type="button" class="color-show-all" id="p-fill-showall" hidden></button>`}
      ${node.type !== 'frame' ? bindControl(node, 'fill') : ''}
    </div>` : ''}
    ${node.type === 'container' || node.type === 'image' ? `
    <div class="prop-section">
      <div class="prop-section-title">Stroke</div>
      <div class="prop-section-title" style="font-size:11px;text-transform:none;letter-spacing:0;color:var(--text2);margin-bottom:6px">Color</div>
      <div class="color-pick-grid${strokeExpanded ? '' : ' collapsed'}" id="p-stroke-grid">
        <button class="color-pick none ${!node.strokeColorId ? 'selected' : ''}" data-strokecolor="" title="None"></button>
        ${state.colors.filter(c => c.fillType === 'solid').map(c => `<button class="color-pick ${node.strokeColorId === c.id ? 'selected' : ''}" data-strokecolor="${c.id}" title="${esc(c.name)}" style="background:${swatchBg(c)}"></button>`).join('')}
      </div>
      <button type="button" class="color-show-all" id="p-stroke-showall" hidden></button>
      <div class="prop-row" style="margin-top:10px">
        <span class="prop-label" style="width:auto">Size</span>
        <input class="prop-input" id="p-strokew" type="number" value="${node.strokeW}" min="0" style="width:50px;flex:0 0 auto">
        <span class="prop-label-wide" style="width:auto">Style</span>
        ${styleDropdown(node)}
      </div>
      <div class="prop-row" style="margin-top:8px">
        <span class="prop-label" style="width:auto">Sides</span>
        ${[['t', 'Top'], ['r', 'Right'], ['b', 'Bottom'], ['l', 'Left']].map(([k, label]) => `<button type="button" class="flip-btn side-btn ${!node.strokeSides || node.strokeSides[k] ? 'active' : ''}" data-sside="${k}" title="${label}">${SIDE_ICONS[k]}</button>`).join('')}
      </div>
    </div>` : ''}
    ${node.type === 'container' || node.type === 'image' || node.type === 'text' ? shadowSection(node) : ''}
    ${node.type !== 'frame' && node.type !== 'section' ? `
    <div class="prop-section">
      <div class="prop-section-title">Blur</div>
      <div class="prop-row affix-row">
        <label class="input-affix" title="Layer blur: blurs this element itself, in px (0 = off)"><span class="input-affix-label">L</span><input class="prop-input bare" id="p-lblur" type="number" min="0" max="200" value="${node.layerBlur || 0}"></label>
        ${node.type === 'container' || node.type === 'image' ? `<label class="input-affix" title="Background blur: blurs what's behind this, in px (0 = off)"><span class="input-affix-label">B</span><input class="prop-input bare" id="p-bblur" type="number" min="0" max="200" value="${node.backdropBlur || 0}"></label>` : ''}
      </div>
      <div class="api-hint" style="margin-top:6px">${node.type === 'container' || node.type === 'image'
        ? 'L blurs the element itself (soft glows, background shapes). B blurs what is behind it: for glass, use a see-through fill and a thin light stroke.'
        : 'Blurs the element itself.'}</div>
    </div>` : ''}
    ${node.type === 'text' ? `
    <div class="prop-section">
      <div class="prop-section-title">Text</div>
      <div class="prop-row">
        <textarea class="prop-input" id="p-text" rows="3" style="resize:vertical">${esc(node.text)}</textarea>
      </div>
      ${bindControl(node, 'text')}
      ${node.bind && node.bind.text ? `<div class="api-hint" style="margin-top:4px">The text above shows where the data has none.</div>` : ''}
      <div class="prop-row" style="margin-top:10px">
        <button type="button" class="flip-btn ${node.autoSize ? 'active' : ''}" data-textwidth="auto" title="Auto width — grows with the text, no wrapping">${AUTOWIDTH_ICON}</button>
        <button type="button" class="flip-btn ${!node.autoSize ? 'active' : ''}" data-textwidth="fixed" title="Auto height — fixed width, the text wraps and the height grows">${FIXEDWIDTH_ICON}</button>
      </div>
      ${!node.autoSize ? `<div style="font-size:11px;color:var(--text3);margin-top:6px">Drag the side handles to change the wrap width.</div>` : ''}
      <div class="prop-row" style="margin-top:10px">
        <button type="button" class="flip-btn ${node.italic ? 'active' : ''}" data-tdeco="italic" title="Italic">${ITALIC_ICON}</button>
        <button type="button" class="flip-btn ${node.decoration === 'underline' ? 'active' : ''}" data-tdeco="underline" title="Underline">${UNDERLINE_ICON}</button>
        <button type="button" class="flip-btn ${node.decoration === 'lineThrough' ? 'active' : ''}" data-tdeco="lineThrough" title="Strikethrough">${STRIKE_ICON}</button>
        <span style="width:8px"></span>
        <button type="button" class="flip-btn case-btn ${!node.textCase ? 'active' : ''}" data-tcase="" title="As typed">Aa</button>
        <button type="button" class="flip-btn case-btn ${node.textCase === 'upper' ? 'active' : ''}" data-tcase="upper" title="Uppercase">AA</button>
        <button type="button" class="flip-btn case-btn ${node.textCase === 'lower' ? 'active' : ''}" data-tcase="lower" title="Lowercase">aa</button>
      </div>
    </div>
    <div class="prop-section">
      <div class="prop-section-title">Style</div>
      ${state.typography.length === 0 ? `
      <div class="api-hint" style="margin-bottom:8px">No text styles yet.</div>
      <button class="goto-colors-btn" id="p-goto-typo">+ Create a style</button>` : `
      <div class="prop-row">${typoPicker(node)}</div>`}
      ${textOverrides(node)}
      ${bindControl(node, 'color')}
    </div>` : ''}
  `;

  // "Bind to data" buttons open a picker under their property; × closes an unused one.
  propsFields.querySelectorAll('[data-bind-open]').forEach(btn => btn.addEventListener('click', () => {
    openBinds.add(node.id + ':' + btn.dataset.bindOpen); renderProps();
  }));
  propsFields.querySelectorAll('[data-bind-close]').forEach(btn => btn.addEventListener('click', () => {
    openBinds.delete(node.id + ':' + btn.dataset.bindClose); renderProps();
  }));

  // Bind inputs
  bindProp('p-name', v => {
    node.name = v;
    if (isMaster(node)) renameComponent(node.componentId, v); // a component is named after its master
    if (isIdentNode(node)) {
      const err = frameNameError(v);
      const inp = document.getElementById('p-name');
      const errEl = document.getElementById('p-name-err');
      if (inp) inp.classList.toggle('invalid', !!err);
      if (errEl) { errEl.textContent = err || ''; errEl.style.display = err ? '' : 'none'; }
    }
    renderLayers();
  });
  if (node.type === 'frame') {
    bindProp('p-route', v => {
      let r = v.trim();
      if (r && !r.startsWith('/')) r = '/' + r;
      node.routePath = r;
      const err = routeError(r);
      const inp = document.getElementById('p-route');
      const errEl = document.getElementById('p-route-err');
      if (inp) inp.classList.toggle('invalid', !!err);
      if (errEl) { errEl.textContent = err || ''; errEl.style.display = err ? '' : 'none'; }
    });
    const routeEl = document.getElementById('p-route');
    if (routeEl) routeEl.addEventListener('change', () => saveHistory());
    const initEl = document.getElementById('p-initial');
    if (initEl) initEl.addEventListener('change', () => {
      // Only one screen can be the start screen.
      if (initEl.checked) state.nodes.forEach(n => { if (n.type === 'frame') n.isInitial = (n.id === node.id); });
      else node.isInitial = false;
      saveHistory();
    });
  }
  bindPropNum('p-x', v => { node.x = v; updateNodeEl(node); });
  bindPropNum('p-y', v => { node.y = v; updateNodeEl(node); });
  if (node.type !== 'frame') {
    bindPropNum('p-w', v => { node.w = Math.max(1, v); updateNodeEl(node); });
    bindPropNum('p-h', v => { node.h = Math.max(1, v); updateNodeEl(node); });
  }
  bindPropNum('p-opacity', v => { node.opacity = Math.min(1, Math.max(0, v / 100)); updateNodeEl(node); });
  bindPropNum('p-lblur', v => { node.layerBlur = Math.min(200, Math.max(0, v)) || undefined; updateNodeEl(node); });
  document.getElementById('p-lblur')?.addEventListener('change', () => saveHistory());
  bindPropNum('p-rotation', v => { node.rotation = v; updateNodeEl(node); });
  document.querySelectorAll('[data-rotate]').forEach(btn => btn.addEventListener('click', () => {
    node.rotation = (((node.rotation || 0) + Number(btn.dataset.rotate)) % 360 + 360) % 360;
    updateNodeEl(node); renderProps(); saveHistory();
  }));
  document.querySelectorAll('[data-flip]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.flip === 'h') node.flipH = !node.flipH; else node.flipV = !node.flipV;
    updateNodeEl(node); renderProps(); saveHistory();
  }));

  if (node.type !== 'text' && node.shape !== 'circle') {
    bindPropNum('p-radius', v => { node.radius = Math.max(0, v); updateNodeEl(node); });
    // Per-corner radius inputs (only present in independent-corners mode).
    ['tl', 'tr', 'br', 'bl'].forEach(c => bindPropNum('p-rad-' + c, v => {
      if (!node.radii) node.radii = { tl: 0, tr: 0, br: 0, bl: 0 };
      node.radii[c] = Math.max(0, v); updateNodeEl(node);
    }));
    // Toggle uniform ⇄ independent corners. Entering corner mode seeds all four
    // corners from the current uniform radius so the shape doesn't jump.
    const radToggle = document.querySelector('[data-radius-toggle]');
    if (radToggle) radToggle.addEventListener('click', () => {
      if (node.radiusMode === 'corners') {
        node.radiusMode = 'uniform';
      } else {
        node.radii = { tl: node.radius, tr: node.radius, br: node.radius, bl: node.radius };
        node.radiusMode = 'corners';
      }
      // Full render so the corner drag-handles on the canvas appear/disappear
      // with the mode (updateNodeEl alone won't rebuild them). render() also
      // refreshes the properties panel.
      render();
      saveHistory();
    });
  }

  if (node.type === 'container' || node.type === 'image' || node.type === 'text') {
    if (!node.shadows) node.shadows = [];
    const addBtn = document.querySelector('[data-shadow-add]');
    if (addBtn) addBtn.addEventListener('click', () => {
      node.shadows.push({ ...DEFAULT_SHADOW });
      updateNodeEl(node); renderProps(); saveHistory();
    });
    document.querySelectorAll('[data-shadow-del]').forEach(btn => btn.addEventListener('click', () => {
      node.shadows.splice(Number(btn.dataset.shadowDel), 1);
      updateNodeEl(node); renderProps(); saveHistory();
    }));
    node.shadows.forEach((s, i) => {
      bindPropNum(`p-sh-x-${i}`, v => { s.x = v; updateNodeEl(node); });
      bindPropNum(`p-sh-y-${i}`, v => { s.y = v; updateNodeEl(node); });
      bindPropNum(`p-sh-blur-${i}`, v => { s.blur = Math.max(0, v); updateNodeEl(node); });
      bindPropNum(`p-sh-spread-${i}`, v => { s.spread = v; updateNodeEl(node); });
      bindPropNum(`p-sh-alpha-${i}`, v => { s.alpha = Math.min(1, Math.max(0, v / 100)); updateNodeEl(node); });
    });
    document.querySelectorAll('[data-shkind]').forEach(btn => btn.addEventListener('click', () => {
      const s = node.shadows[Number(btn.dataset.shidx)];
      if (!s) return;
      const inset = btn.dataset.shkind === 'inner';
      if (!!s.inset === inset) return;
      if (inset) s.inset = true; else delete s.inset;
      updateNodeEl(node); renderProps(); saveHistory();
    }));
    document.querySelectorAll('[data-shadowcolor]').forEach(btn => btn.addEventListener('click', () => {
      const s = node.shadows[Number(btn.dataset.shidx)];
      if (!s) return;
      s.colorId = btn.dataset.shadowcolor || null;
      updateNodeEl(node); renderProps(); saveHistory();
    }));
  }

  if (node.type === 'container') {
    document.querySelectorAll('.shape-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        node.shape = btn.dataset.shape;
        render();        // re-render so radius handles appear/disappear with the shape
        renderLayers();
      });
    });
  }

  if (node.type === 'container' || node.type === 'frame') {
    bindBox('pad', node.padding, node);
    // One handler covers every side-toggle currently in the panel (padding + margin).
    document.querySelectorAll('[data-box-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const prefix = btn.dataset.boxToggle;
        const nowExpanded = !boxExpanded[prefix];
        boxExpanded[prefix] = nowExpanded;
        // Collapsing to Horizontal/Vertical flattens any per-side asymmetry to the
        // values shown (left → right, top → bottom), so the stored data matches
        // what the combined fields display.
        if (!nowExpanded) {
          const box = prefix === 'pad' ? node.padding : node.margin;
          box.r = box.l; box.b = box.t;
          updateNodeEl(node);
          saveHistory();
        }
        renderProps();
      });
    });
  }

  if (node.type === 'container') {
    bindBox('mar', node.margin, node);

    // Scroll on/off toggle (only rendered for Row/Column layouts). The axis is
    // derived from the layout at render time (see applyScroll).
    const scrollBtn = document.getElementById('p-scroll');
    if (scrollBtn) scrollBtn.addEventListener('change', () => {
      node.scroll = scrollBtn.checked;
      updateNodeEl(node);
      renderProps();
    });
  }

  // Icon: replace opens the picker (decoupled via an event); the color swatches
  // retint the glyph through its referenced solid Color variable.
  if (node.type === 'icon') {
    const replaceBtn = document.getElementById('p-replace-icon');
    if (replaceBtn) replaceBtn.addEventListener('click', () =>
      document.dispatchEvent(new CustomEvent('icon:replace', { detail: { id: node.id } })));
    document.querySelectorAll('[data-iconcolor]').forEach(btn => btn.addEventListener('click', () => {
      node.colorId = btn.dataset.iconcolor || null; updateNodeEl(node); renderProps();
    }));
  }

  // Layout icon toggles (container only). setLayout re-renders + snapshots.
  document.querySelectorAll('[data-layout]').forEach(btn => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    setLayout(node, btn.dataset.layout);
  }));

  // Flex gap controls — a container's/frame's chosen layout, or a legacy row/column/wrap node.
  const flexK = (node.type === 'container' || node.type === 'frame') ? node.layout
    : (node.type === 'row' || node.type === 'column' || node.type === 'wrap') ? node.type : null;
  if (flexK === 'row' || flexK === 'column') {
    bindPropNum('p-gap', v => { node.gap = Math.max(0, v); updateNodeEl(node); });
  }
  if (flexK === 'wrap') {
    bindPropNum('p-gaph', v => { node.gapH = Math.max(0, v); updateNodeEl(node); });
    bindPropNum('p-gapv', v => { node.gapV = Math.max(0, v); updateNodeEl(node); });
  }

  if (node.type !== 'text') {
    document.querySelectorAll('[data-pickcolor]').forEach(btn => {
      btn.addEventListener('click', () => { node.colorId = btn.dataset.pickcolor || null; updateNodeEl(node); renderProps(); });
    });
    setupShowAll('p-fill-grid', 'p-fill-showall', () => fillExpanded, v => { fillExpanded = v; });
    setupShowAll('p-stroke-grid', 'p-stroke-showall', () => strokeExpanded, v => { strokeExpanded = v; });
    (node.shadows || []).forEach((_, i) => setupShowAll(`p-shadow-grid-${i}`, `p-shadow-showall-${i}`,
      () => shadowExpanded.has(i), v => { if (v) shadowExpanded.add(i); else shadowExpanded.delete(i); }));
    const gotoColors = document.getElementById('p-goto-colors');
    if (gotoColors) gotoColors.addEventListener('click', () => document.querySelector('.mode-tab[data-mode="color"]')?.click());

    // Stroke color (container/image) is picked from the Color tab's solid colors.
    document.querySelectorAll('[data-strokecolor]').forEach(btn => {
      btn.addEventListener('click', () => { node.strokeColorId = btn.dataset.strokecolor || null; updateNodeEl(node); renderProps(); });
    });
    bindPropNum('p-strokew', v => { node.strokeW = Math.max(0, v); updateNodeEl(node); });
    // Stroke sides: toggle one; at least one stays on; all on is stored as "all".
    propsFields.querySelectorAll('[data-sside]').forEach(btn => btn.addEventListener('click', () => {
      const s = { t: true, r: true, b: true, l: true, ...(node.strokeSides || {}) };
      const k = btn.dataset.sside;
      s[k] = !s[k];
      if (!s.t && !s.r && !s.b && !s.l) return;
      if (s.t && s.r && s.b && s.l) delete node.strokeSides; else node.strokeSides = s;
      if (!(node.strokeW > 0)) node.strokeW = 1; // picking sides means wanting a stroke
      updateNodeEl(node); renderProps(); saveHistory();
    }));
    bindPropNum('p-bblur', v => { node.backdropBlur = Math.min(200, Math.max(0, v)); updateNodeEl(node); });
    document.getElementById('p-bblur')?.addEventListener('change', () => saveHistory());
  } else {
    // Italic / underline / strikethrough / case.
    propsFields.querySelectorAll('[data-tdeco]').forEach(btn => btn.addEventListener('click', () => {
      const k = btn.dataset.tdeco;
      if (k === 'italic') node.italic = !node.italic || undefined;
      else node.decoration = node.decoration === k ? undefined : k;
      updateNodeEl(node); renderProps(); saveHistory();
    }));
    propsFields.querySelectorAll('[data-tcase]').forEach(btn => btn.addEventListener('click', () => {
      node.textCase = btn.dataset.tcase || undefined;
      updateNodeEl(node); renderProps(); saveHistory();
    }));
    const ta = document.getElementById('p-text');
    if (ta) ta.addEventListener('input', () => { node.text = ta.value; updateNodeEl(node); });
    const sizeEl = document.getElementById('p-tsize');
    if (sizeEl) {
      sizeEl.addEventListener('input', () => {
        const v = parseFloat(sizeEl.value);
        if (node.typoId) node.fontSizeOverride = sizeEl.value === '' || !(v > 0) ? null : v;
        else if (v > 0) node.fontSize = v;
        updateNodeEl(node);
      });
      sizeEl.addEventListener('change', () => saveHistory());
    }
    const gotoTypo = document.getElementById('p-goto-typo');
    if (gotoTypo) gotoTypo.addEventListener('click', () => document.querySelector('.mode-tab[data-mode="typography"]')?.click());

    // Auto width ⇄ fixed width (wrap). Switching to fixed keeps the current width
    // but ensures it's wide enough to be a usable, draggable text box.
    document.querySelectorAll('[data-textwidth]').forEach(btn => btn.addEventListener('click', () => {
      const desiredAuto = btn.dataset.textwidth === 'auto';
      if (node.autoSize === desiredAuto) return;
      node.autoSize = desiredAuto;
      node.wMode = desiredAuto ? 'hug' : 'fixed'; // keep the Size-panel mode in sync
      if (!desiredAuto && node.w < 40) node.w = 200;
      render();       // rebuild handles (fixed width gains side handles) + panel
      saveHistory();
    }));
  }

  document.querySelectorAll('[data-ah]').forEach(b => b.addEventListener('click', () => { node.alignment.h = b.dataset.ah; updateNodeEl(node); renderProps(); }));
  document.querySelectorAll('[data-av]').forEach(b => b.addEventListener('click', () => { node.alignment.v = b.dataset.av; updateNodeEl(node); renderProps(); }));

  bindDataInputs(node);
  bindComponentButtons(node);

  // Viewer (read-only): make every control inert — values remain visible, but
  // nothing responds to clicks, typing, or the custom dropdowns.
  if (state.readonly) {
    propsFields.querySelectorAll('input, textarea, select, button').forEach(el => {
      el.disabled = true;
    });
    propsFields.querySelectorAll('.dd-trigger, [contenteditable]').forEach(el => {
      el.style.pointerEvents = 'none';
      el.setAttribute('tabindex', '-1');
      if (el.hasAttribute('contenteditable')) el.setAttribute('contenteditable', 'false');
    });
  }
}

// Border-style picker — the shared custom dropdown (selection handled by the
// delegated dd:change listener above via data-pp="sstyle").
// Size / weight / colour for a text. With a style they override it (blank = the
// style's value); without one they are the text's own. Colour is a variable.
const TEXT_WEIGHTS = ['300', '400', '500', '600', '700', '800'];
function textOverrides(node) {
  const t = node.typoId ? state.typography.find(s => s.id === node.typoId) : null;
  const size = t ? (node.fontSizeOverride ?? '') : (node.fontSize || 16);
  const weight = t ? (node.fontWeightOverride || '') : (node.fontWeight || '400');
  const weightOpts = [
    ...(t ? [{ value: '', label: `Style (${t.fontWeight})` }] : []),
    ...TEXT_WEIGHTS.map(w => ({ value: w, label: w })),
  ];
  const colorOpts = [
    { value: '', label: t ? 'Style color' : 'Default' },
    ...state.colors.map(c => ({ value: c.id, label: c.name })),
  ];
  return `
      <div class="prop-row" style="margin-top:10px">
        <span class="prop-label-wide" style="width:auto">Size</span>
        <input class="prop-input" id="p-tsize" type="number" min="1" value="${size}" placeholder="${t ? t.fontSize : ''}" style="width:56px;flex:0 0 auto">
        <span class="prop-label-wide" style="width:auto">Weight</span>
        ${ddTrigger({ value: weight, options: weightOpts, data: { pp: 'tweight' }, triggerClass: 'dd-block' })}
      </div>
      <div class="prop-row">
        <span class="prop-label-wide" style="width:auto">Color</span>
        ${ddTrigger({ value: node.colorId || '', options: colorOpts, data: { pp: 'tcolor' }, triggerClass: 'dd-block' })}
      </div>`;
}

// The text style, as one dropdown: each style previewed in its own font, with its
// size · weight alongside.
function typoPicker(node) {
  const cap = (n) => Math.min(Number(n) || 13, 18); // keep big headings list-sized
  const options = [
    { value: '', label: 'None', meta: 'own size' },
    ...state.typography.map(t => (ensureFontLoaded(t.fontFamily), {
      value: t.id, label: t.name, meta: `${t.fontSize} · ${t.fontWeight}`,
      font: `font-family:'${String(t.fontFamily).replace(/'/g, '')}',sans-serif;font-size:${cap(t.fontSize)}px;font-weight:${t.fontWeight}`,
    })),
  ];
  return ddTrigger({ value: node.typoId || '', options, data: { pp: 'typo' }, triggerClass: 'dd-block' });
}

function styleDropdown(node) {
  return ddTrigger({
    value: node.strokeStyle || 'solid',
    options: STROKE_STYLES.map(s => ({ value: s, label: s })),
    data: { pp: 'sstyle' },
    triggerClass: 'dd-block dd-cap',
  });
}

function bindProp(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => fn(el.value));
}

function bindPropNum(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => fn(parseFloat(el.value) || 0));
}
