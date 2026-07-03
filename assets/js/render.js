import { state, getNode, getColorById, getTypoById } from './state.js';
import { colorCss } from './colors.js';
import { SINGLE_CHILD_TYPES, MULTI_CHILD_TYPES, flexKind, isFlex, isSingleChild } from './nodes.js';
import { canvas, zoomLabel, canvasWrap } from './utils.js';
import { drawRulers } from './rulers.js';
import { renderLayers } from './layers.js';
import { renderProps } from './props.js';
import { attachNodeEvents } from './canvas.js';
import { ensureFontLoaded } from './google-fonts.js';

export function applyTransform() {
  canvas.style.transform = `translate(${state.panX}px,${state.panY}px) scale(${state.zoom})`;
  canvas.style.setProperty('--zoom', state.zoom); // overlays (comment pins) counter-scale off this
  if (zoomLabel) zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
  drawRulers();
}

export function render() {
  canvas.querySelectorAll('.node, .frame-label').forEach(e => e.remove());
  const roots = state.nodes.filter(n => !n.parentId);
  roots.forEach(n => renderNode(n, canvas));
  syncMeasuredSizes(); // fold fill/hug rendered sizes back into the model
  renderLayers();
  renderProps();
  document.dispatchEvent(new Event('flow:render')); // let Connect mode redraw its arrows
}

export const FLEX_TYPES = ['row', 'column', 'wrap'];

// Lay out a node's children with flexbox (auto-layout) instead of absolute positions.
// Row/column also honour the node's `alignment` (Horiz/Vert) — mapped onto the
// main/cross axis depending on the flex direction.
function applyFlexLayout(el, node) {
  const kind = flexKind(node);
  el.style.display = node.visible ? 'flex' : 'none';
  el.style.alignContent = 'flex-start';
  const a = node.alignment || { h: 'left', v: 'top' };
  if (kind === 'row') {
    el.style.flexDirection = 'row'; el.style.flexWrap = 'nowrap'; el.style.gap = node.gap + 'px';
    el.style.justifyContent = ALIGN_H[a.h] || 'flex-start';   // horizontal = main axis
    el.style.alignItems = ALIGN_V[a.v] || 'flex-start';       // vertical   = cross axis
  } else if (kind === 'column') {
    el.style.flexDirection = 'column'; el.style.flexWrap = 'nowrap'; el.style.gap = node.gap + 'px';
    el.style.justifyContent = ALIGN_V[a.v] || 'flex-start';   // vertical   = main axis
    el.style.alignItems = ALIGN_H[a.h] || 'flex-start';       // horizontal = cross axis
  } else if (kind === 'wrap') {
    el.style.flexDirection = 'row'; el.style.flexWrap = 'wrap'; el.style.gap = node.gapV + 'px ' + node.gapH + 'px';
    el.style.justifyContent = ''; el.style.alignItems = '';
  }
}

const ALIGN_H = { left: 'flex-start', center: 'center', right: 'flex-end' };
const ALIGN_V = { top: 'flex-start', center: 'center', bottom: 'flex-end' };

// Single-child wrappers (frame/container) align their child via flexbox,
// driven by the wrapper's `alignment` property.
function applyWrapperAlignment(el, node) {
  if (!isSingleChild(node)) return;
  const a = node.alignment || { h: 'left', v: 'top' };
  el.style.display = node.visible ? 'flex' : 'none';
  el.style.justifyContent = ALIGN_H[a.h] || 'flex-start';
  el.style.alignItems = ALIGN_V[a.v] || 'flex-start';
}

// Place a node based on its parent:
//  - flex parent (row/column/wrap)   → flex item, auto-laid-out
//  - single-child wrapper (frame/container) → flex item, aligned by the wrapper
//  - stack or canvas root             → free absolute positioning (x/y)
function applyPosition(el, node) {
  const parentNode = node.parentId ? getNode(node.parentId) : null;
  if (isFlex(parentNode)) {
    el.style.position = 'relative';
    el.style.left = '';
    el.style.top = '';
    el.style.flex = '0 0 auto';
  } else if (isSingleChild(parentNode)) {
    el.style.position = 'relative';
    el.style.flex = '0 0 auto';
    el.style.left = '';
    el.style.top = '';
  } else {
    el.style.position = 'absolute';
    el.style.flex = '';
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
  }
}

// Visual transform: rotation (degrees) and horizontal/vertical mirroring.
function applyNodeTransform(el, node) {
  const parts = [];
  if (node.rotation) parts.push(`rotate(${node.rotation}deg)`);
  if (node.flipH) parts.push('scaleX(-1)');
  if (node.flipV) parts.push('scaleY(-1)');
  el.style.transform = parts.join(' ');
}

// Paint an image node's picture as its background (call after setting the fill)
const IMAGE_FIT = { cover: 'cover', contain: 'contain', fill: '100% 100%', fitWidth: '100% auto', fitHeight: 'auto 100%' };

function stopColorCss(s) {
  const a = s.alpha == null ? 1 : s.alpha;
  if (a >= 1) return s.color;
  let h = (s.color || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  const n = parseInt(h.slice(0, 6) || '0', 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function gradientStops(stops) {
  return [...stops].sort((a, b) => a.pos - b.pos).map(s => `${stopColorCss(s)} ${s.pos}%`).join(', ');
}
export function gradientCss(node) {
  const g = node.gradient || { angle: 90, stops: [] };
  if (node.fillType === 'radial') return `radial-gradient(circle at center, ${gradientStops(g.stops)})`;
  return `linear-gradient(${g.angle}deg, ${gradientStops(g.stops)})`;
}

// Paint a node's fill: solid color, linear/radial gradient, or image.
// Frame/container take their fill from a referenced Color variable when set.
function applyFill(el, node) {
  if (node.type === 'image') {
    // Fill comes from a referenced Color variable (same as container); the
    // picture is layered on top of that fill.
    let src = node;
    if (node.colorId) { const c = getColorById(node.colorId); if (c) src = c; }
    const isGrad = src.fillType === 'linear' || src.fillType === 'radial';
    const pic = node.src ? `url("${node.src}")` : '';
    const fit = IMAGE_FIT[node.fit] || 'cover';
    if (isGrad) {
      el.style.backgroundColor = 'transparent';
      el.style.backgroundImage = pic ? `${pic}, ${gradientCss(src)}` : gradientCss(src);
      el.style.backgroundSize = pic ? `${fit}, 100% 100%` : '100% 100%';
    } else {
      el.style.backgroundColor = src.fill === 'transparent' ? 'transparent' : src.fill;
      el.style.backgroundImage = pic;
      el.style.backgroundSize = pic ? fit : '';
    }
    el.style.backgroundPosition = 'center';
    el.style.backgroundRepeat = 'no-repeat';
    return;
  }
  let src = node;
  if ((node.type === 'frame' || node.type === 'container') && node.colorId) {
    const c = getColorById(node.colorId);
    if (c) src = c;
  }
  if (src.fillType === 'linear' || src.fillType === 'radial') {
    el.style.backgroundColor = 'transparent';
    el.style.backgroundImage = gradientCss(src);
    el.style.backgroundSize = ''; el.style.backgroundRepeat = '';
  } else {
    el.style.backgroundColor = src.fill;
    el.style.backgroundImage = '';
  }
}

// The tint for an icon: its referenced solid Color variable, or a white fallback.
// (Iconify monochrome icons paint with `currentColor`, so setting the element's
// `color` recolors the whole glyph.)
function iconTint(node) {
  if (node.colorId) { const c = getColorById(node.colorId); if (c && c.fillType === 'solid') return c.fill; }
  return '#ffffff'; // no color variable → default (matches the "Default (white)" swatch)
}

// Render an icon node: inject the SVG once (on a full render), stretch it to the
// box, and tint it. `injectSvg` is false on lightweight updates (drag/resize) so
// the selection handles already appended aren't wiped.
function applyIcon(el, node, injectSvg) {
  if (injectSvg) {
    el.innerHTML = node.svg || '';
    const svg = el.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width'); svg.removeAttribute('height');
      svg.style.width = '100%'; svg.style.height = '100%';
      svg.style.display = 'block'; svg.style.pointerEvents = 'none';
    }
  }
  el.style.color = iconTint(node);
}

// Resolve one axis of a node to a CSS size string from its sizing mode:
//  fill → 100% of the parent, hug → fit-content (shrink to children), else fixed px.
function axisSize(mode, px) {
  if (mode === 'fill') return '100%';
  if (mode === 'hug') return 'fit-content';
  return px + 'px';
}

// Size a node: layout types (row/column/wrap/stack) fill their single-child wrapper parent
function applySize(el, node) {
  const parentNode = node.parentId ? getNode(node.parentId) : null;
  // A legacy multi-child layout node fills its single-child wrapper parent.
  // (Containers-with-layout keep their own explicit width/height instead.)
  if (isSingleChild(parentNode) && MULTI_CHILD_TYPES.includes(node.type)) {
    el.style.width = '100%';
    el.style.height = '100%';
  } else if (node.type === 'text') {
    // Text height always fits its content. Auto-width grows sideways with no wrap;
    // otherwise it wraps, with the width driven by its sizing mode (fill = parent
    // width, fixed = node.w).
    el.style.height = 'auto';
    if (node.autoSize) {
      el.style.width = 'auto';
      el.style.whiteSpace = 'pre';
      el.style.wordBreak = '';
    } else {
      el.style.width = node.wMode === 'fill' ? '100%' : node.w + 'px';
      el.style.whiteSpace = 'pre-wrap';
      el.style.wordBreak = 'break-word';
    }
  } else {
    el.style.width = axisSize(node.wMode, node.w);
    el.style.height = axisSize(node.hMode, node.h);
  }
}

// After the whole tree is in the DOM, copy the rendered box of any fill/hug node
// back into its w/h so selection, snapping, hit-testing and the props panel agree.
// (Can't be done during the recursive build: a fill child's 100% resolves to 0
// while its parent is still detached.)
export function syncMeasuredSizes() {
  state.nodes.forEach(n => {
    const fluid = n.wMode === 'fill' || n.wMode === 'hug' || n.hMode === 'fill' || n.hMode === 'hug';
    if (!fluid) return;
    const el = document.getElementById('node-' + n.id);
    if (!el) return;
    if (n.wMode === 'fill' || n.wMode === 'hug') n.w = el.offsetWidth;
    if (n.hMode === 'fill' || n.hMode === 'hug') n.h = el.offsetHeight;
    // The radius handles were placed using the pre-fill size; reposition them now.
    if (el.querySelector('.radius-handle')) positionRadiusHandles(el, n);
  });
}

// After an auto-size text element is in the DOM, copy its rendered box back into
// the node's w/h so selection, snapping, hit-testing and the props panel agree.
export function syncTextSize(el, node) {
  if (node.type !== 'text') return;
  node.h = el.offsetHeight;                 // height always tracks content
  if (node.autoSize) node.w = el.offsetWidth; // auto-width also tracks content
}

// Container/image stroke comes from a referenced solid Color variable; others use their own stroke.
function strokeColor(node) {
  if (node.type === 'container' || node.type === 'image') {
    const cv = node.strokeColorId ? getColorById(node.strokeColorId) : null;
    if (cv && cv.fillType === 'solid') {
      return applyStrokeOpacity(cv.fill, cv.alpha == null ? 1 : cv.alpha);
    }
    return 'transparent';
  }
  return applyStrokeOpacity(node.stroke, node.strokeOpacity);
}
function applyStroke(el, node) {
  if (node.strokeW > 0) el.style.border = `${node.strokeW}px ${node.strokeStyle || 'solid'} ${strokeColor(node)}`;
  else el.style.border = 'none';
}

// Outer margin (container only) — space around the box. Pushes flex siblings
// apart in row/column/wrap parents; offsets free/absolute containers.
function applyMargin(el, node) {
  const m = node.margin || { t: 0, r: 0, b: 0, l: 0 };
  el.style.margin = `${m.t}px ${m.r}px ${m.b}px ${m.l}px`;
}

// Scroll axis (container only) — lets oversized content scroll on one axis.
// Only one axis scrolls at a time; the cross axis is clipped.
function applyScroll(el, node) {
  const s = node.scroll || 'none';
  if (s === 'horizontal') { el.style.overflowX = 'auto'; el.style.overflowY = 'hidden'; }
  else if (s === 'vertical') { el.style.overflowY = 'auto'; el.style.overflowX = 'hidden'; }
  else { el.style.overflowX = ''; el.style.overflowY = ''; }
}

// Border radius: a circle shape is fully round; otherwise either one uniform
// radius or four independent corners (TL TR BR BL).
function applyRadius(el, node) {
  if (node.shape === 'circle') { el.style.borderRadius = '50%'; return; }
  if (node.radiusMode === 'corners') {
    const r = node.radii || { tl: 0, tr: 0, br: 0, bl: 0 };
    el.style.borderRadius = `${r.tl}px ${r.tr}px ${r.br}px ${r.bl}px`;
  } else {
    el.style.borderRadius = node.radius + 'px';
  }
}

// Drop shadow (container/image) → CSS box-shadow. Colour comes from a referenced
// solid Color variable (or black by default), tinted by the shadow's alpha.
function applyShadow(el, node) {
  const list = node.shadows;
  if (!list || !list.length) { el.style.boxShadow = ''; return; }
  el.style.boxShadow = list.map(s => {
    let hex = '#000000';
    if (s.colorId) { const c = getColorById(s.colorId); if (c && c.fillType === 'solid') hex = c.fill; }
    const color = applyStrokeOpacity(hex, s.alpha == null ? 1 : s.alpha);
    return `${s.x || 0}px ${s.y || 0}px ${s.blur || 0}px ${s.spread || 0}px ${color}`;
  }).join(', ');
}

// Inner padding (frame + container) — insets its single child from the edges.
function applyPadding(el, node) {
  const p = node.padding || { t: 0, r: 0, b: 0, l: 0 };
  el.style.padding = `${p.t}px ${p.r}px ${p.b}px ${p.l}px`;
}

// A text node takes all its typography (family/size/weight/line-height/spacing
// and colour) from a referenced Typography style variable. With no style
// selected it falls back to a plain default so the text stays legible.
export function applyTextStyle(el, node) {
  const t = node.typoId ? getTypoById(node.typoId) : null;
  if (t) {
    ensureFontLoaded(t.fontFamily);
    el.style.fontFamily = /\s/.test(t.fontFamily) ? `'${t.fontFamily}'` : t.fontFamily;
    el.style.fontSize = t.fontSize + 'px';
    el.style.fontWeight = t.fontWeight;
    el.style.lineHeight = t.lineHeight;
    el.style.letterSpacing = t.letterSpacing + 'px';
    const c = t.colorId ? getColorById(t.colorId) : null;
    el.style.color = c && c.fillType === 'solid' ? colorCss(c) : '#1a1a1a';
  } else {
    el.style.fontFamily = '';
    el.style.fontSize = (node.fontSize || 16) + 'px';
    el.style.fontWeight = node.fontWeight || '400';
    el.style.lineHeight = '1.4';
    el.style.letterSpacing = '';
    el.style.color = node.color || '#1a1a1a';
  }
  el.style.textAlign = (node.alignment && node.alignment.h) || 'left';
}

export function renderNode(node, parent) {
  const el = document.createElement('div');
  el.className = 'node ' + (node.type === 'text' ? 'text-node' : node.type);
  // A node with a tap interaction gets a small corner badge (see .node.has-action).
  if (node.action && node.action.type && node.action.type !== 'none') el.classList.add('has-action');
  el.id = 'node-' + node.id;
  el.dataset.id = node.id;

  applyPosition(el, node);
  applySize(el, node);
  applyNodeTransform(el, node);
  el.style.opacity = node.opacity;
  el.style.display = node.visible ? '' : 'none';
  applyWrapperAlignment(el, node);

  if (node.type === 'text') {
    applyTextStyle(el, node);
    el.textContent = node.text;
  } else if (node.type === 'icon') {
    applyIcon(el, node, true);
  } else {
    applyFill(el, node);
    applyStroke(el, node);
    applyRadius(el, node);
    if (SINGLE_CHILD_TYPES.includes(node.type)) applyPadding(el, node);
    if (node.type === 'container') applyMargin(el, node);
    if (node.type === 'container') applyScroll(el, node);
    if (node.type === 'container' || node.type === 'image') applyShadow(el, node);
    if (isFlex(node)) applyFlexLayout(el, node);
  }

  if (state.selected.has(node.id) && state.tool !== 'comment') {
    el.classList.add('selected');
    // Locked nodes — and every node in Connect mode — show only the selection
    // outline, no resize/radius handles. Comment mode shows no selection at all.
    if (!node.locked && state.tool !== 'connect') {
      // Auto-size text is content-driven, so it gets no resize handles (just the outline).
      if (node.type !== 'frame' && !(node.type === 'text' && node.autoSize)) addHandles(el, node);
      if ((node.type === 'container' || node.type === 'image') && node.shape !== 'circle' && node.radiusMode !== 'corners') addRadiusHandles(el, node);
    }
  }

  if (node.children && node.children.length) {
    node.children.forEach(childId => {
      const child = getNode(childId);
      if (child) renderNode(child, el);
    });
  }

  parent.appendChild(el);
  syncTextSize(el, node);
  attachNodeEvents(el, node);

  // Frames show their name on a small label above the top-left corner (Figma
  // style). It lives beside the frame — not inside it — because frames clip
  // their overflow, and counter-scales off --zoom so it stays a constant size.
  if (node.type === 'frame') addFrameLabel(node, parent);
}

// A constant-size name tag above a frame; clicking it selects the frame.
function addFrameLabel(node, parent) {
  const label = document.createElement('div');
  label.className = 'frame-label' + (state.selected.has(node.id) ? ' selected' : '');
  label.id = 'frame-label-' + node.id;
  label.textContent = node.name || 'Frame';
  label.style.left = node.x + 'px';
  label.style.top = node.y + 'px';
  label.addEventListener('pointerdown', e => {
    if (state.tool !== 'select') return;
    e.stopPropagation();
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) state.selected.clear();
    state.selected.add(node.id);
    render();
  });
  parent.appendChild(label);
}

function addHandles(el, node) {
  // A non-resizable axis (fill/hug, or a text node's content-driven height) hides
  // that axis's side handles — and any corner that touches it, since a corner
  // can't resize a locked axis.
  const wFluid = node.wMode && node.wMode !== 'fixed';
  const hFluid = (node.hMode && node.hMode !== 'fixed') || node.type === 'text';
  ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].forEach(pos => {
    if ((pos === 'w' || pos === 'e') && wFluid) return;       // width locked
    if ((pos === 'n' || pos === 's') && hFluid) return;       // height locked
    if (pos.length === 2 && (wFluid || hFluid)) return;       // corner touches a locked axis
    const h = document.createElement('div');
    h.className = `handle handle-${pos}`;
    h.dataset.handle = pos;
    el.appendChild(h);
  });
}

// Figma-style corner-radius handles: a small circle near each corner. Dragging
// any of them sets the (uniform) border radius. Container & image only.
function addRadiusHandles(el, node) {
  ['nw', 'ne', 'sw', 'se'].forEach(corner => {
    const h = document.createElement('div');
    h.className = 'radius-handle';
    h.dataset.radius = corner;
    el.appendChild(h);
  });
  positionRadiusHandles(el, node);
}

// Place each radius handle inset from its corner by the current radius (clamped
// so it stays grabbable on small/large nodes).
export function positionRadiusHandles(el, node) {
  const maxR = Math.min(node.w, node.h) / 2;
  const inset = Math.min(Math.max(node.radius, 10), maxR);
  el.querySelectorAll('.radius-handle').forEach(h => {
    const c = h.dataset.radius;
    h.style.left = (c.includes('w') ? inset : node.w - inset) + 'px';
    h.style.top = (c.includes('n') ? inset : node.h - inset) + 'px';
  });
}

export function updateNodeEl(node) {
  const el = document.getElementById('node-' + node.id);
  if (!el) return;
  // Keep a frame's floating name tag glued to it while it's being dragged/moved.
  if (node.type === 'frame') {
    const label = document.getElementById('frame-label-' + node.id);
    if (label) { label.style.left = node.x + 'px'; label.style.top = node.y + 'px'; }
  }
  applyPosition(el, node);
  applySize(el, node);
  applyNodeTransform(el, node);
  applyWrapperAlignment(el, node);
  el.style.opacity = node.opacity;
  if (node.type === 'text') {
    applyTextStyle(el, node);
    el.textContent = node.text;
    syncTextSize(el, node);
  } else if (node.type === 'icon') {
    applyIcon(el, node, false);
  } else {
    applyFill(el, node);
    applyStroke(el, node);
    applyRadius(el, node);
    if (SINGLE_CHILD_TYPES.includes(node.type)) applyPadding(el, node);
    if (node.type === 'container') applyMargin(el, node);
    if (node.type === 'container') applyScroll(el, node);
    if (node.type === 'container' || node.type === 'image') applyShadow(el, node);
    if (isFlex(node)) applyFlexLayout(el, node);
    if (el.querySelector('.radius-handle')) positionRadiusHandles(el, node);
  }
}

export function zoomAt(f) {
  const cx = canvasWrap.offsetWidth / 2;
  const cy = canvasWrap.offsetHeight / 2;
  const wx = (cx - state.panX) / state.zoom;
  const wy = (cy - state.panY) / state.zoom;
  state.zoom = Math.min(8, Math.max(0.05, state.zoom * f));
  state.panX = cx - wx * state.zoom;
  state.panY = cy - wy * state.zoom;
  applyTransform();
}

export function fitView() {
  if (!state.nodes.length) return;
  const minX = Math.min(...state.nodes.map(n => n.x));
  const minY = Math.min(...state.nodes.map(n => n.y));
  const maxX = Math.max(...state.nodes.map(n => n.x + n.w));
  const maxY = Math.max(...state.nodes.map(n => n.y + n.h));
  const pad = 60;
  const cw = canvasWrap.offsetWidth, ch = canvasWrap.offsetHeight;
  const z = Math.min((cw - pad * 2) / (maxX - minX), (ch - pad * 2) / (maxY - minY), 4);
  state.zoom = z;
  state.panX = cw / 2 - (minX + (maxX - minX) / 2) * z;
  state.panY = ch / 2 - (minY + (maxY - minY) / 2) * z;
  applyTransform();
}

function applyStrokeOpacity(hex, opacity) {
  if (opacity >= 1 || hex === 'transparent') return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}
