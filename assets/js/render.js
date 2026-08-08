import { state, getNode, getColorById, getTypoById, getMasterNode, isMaster } from './state.js';
import { colorCss } from './colors.js';
import { SINGLE_CHILD_TYPES, MULTI_CHILD_TYPES, flexKind, isFlex, isSingleChild } from './nodes.js';
import { canvas, zoomLabel, canvasWrap } from './utils.js';
import { drawRulers } from './rulers.js';
import { renderLayers } from './layers.js';
import { renderProps } from './props.js';
import { attachNodeEvents, beginNodeDrag } from './canvas.js';
import { ensureFontLoaded } from './google-fonts.js';
import { resolvedSrc } from './images.js';
import { saveViewportSoon } from './viewport.js';

export function applyTransform() {
  canvas.style.transform = `translate(${state.panX}px,${state.panY}px) scale(${state.zoom})`;
  canvas.style.setProperty('--zoom', state.zoom); // overlays (comment pins) counter-scale off this
  if (zoomLabel) zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
  drawRulers();
  saveViewportSoon(); // persist pan/zoom (per project, localStorage only)
}

export function render() {
  canvas.querySelectorAll('.node, .frame-label').forEach(e => e.remove());
  // Sections are big region backdrops that group frames, so paint them first
  // (behind) — any root frame not inside a section still sits on top of them.
  const roots = state.nodes.filter(n => !n.parentId)
    .sort((a, b) => (a.type === 'section' ? 0 : 1) - (b.type === 'section' ? 0 : 1));
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

// While dragging a layout child (which is positioned by its parent, not by x/y),
// offset it visually with a translate so the item follows the cursor. Composed
// with the node's own rotation/flip. dx/dy are in world (unscaled) px.
export function applyDragTransform(el, node, dx, dy) {
  const parts = [`translate(${dx}px, ${dy}px)`];
  if (node.rotation) parts.push(`rotate(${node.rotation}deg)`);
  if (node.flipH) parts.push('scaleX(-1)');
  if (node.flipV) parts.push('scaleY(-1)');
  el.style.transform = parts.join(' ');
}

// Paint an image node's picture as its background (call after setting the fill)
const IMAGE_FIT = { cover: 'cover', contain: 'contain', fill: '100% 100%', fitWidth: '100% auto', fitHeight: 'auto 100%' };

// A solid fill as CSS, honoring its alpha channel. `transparent` (and missing
// fills) pass through; a fully-opaque color stays as its plain hex.
function solidFillCss(fill, alpha) {
  if (!fill || fill === 'transparent') return fill || 'transparent';
  const a = alpha == null ? 1 : alpha;
  if (a >= 1) return fill;
  let h = fill.replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  const n = parseInt(h.slice(0, 6) || '0', 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function stopColorCss(s) { return solidFillCss(s.color, s.alpha); }
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
    // node.src may be an `img:` ref → resolved to a blob URL (or '' while it loads).
    const picUrl = resolvedSrc(node.src);
    const pic = picUrl ? `url("${picUrl}")` : '';
    const fit = IMAGE_FIT[node.fit] || 'cover';
    if (isGrad) {
      el.style.backgroundColor = 'transparent';
      el.style.backgroundImage = pic ? `${pic}, ${gradientCss(src)}` : gradientCss(src);
      el.style.backgroundSize = pic ? `${fit}, 100% 100%` : '100% 100%';
    } else {
      el.style.backgroundColor = solidFillCss(src.fill, src.alpha);
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
    el.style.backgroundColor = solidFillCss(src.fill, src.alpha);
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

// Whether a container has scrolling enabled. Stored as a boolean; older docs may
// still carry the legacy 'horizontal'/'vertical' strings, which also count as on.
export function scrollEnabled(node) {
  return !!node && !!node.scroll && node.scroll !== 'none';
}

// Scroll (container only) — lets oversized content scroll. The axis follows the
// auto-layout: a Row scrolls horizontally, a Column vertically; any other layout
// can't scroll (nothing to lay content out along a single overflowing axis).
function applyScroll(el, node) {
  const on = scrollEnabled(node);
  const kind = flexKind(node);
  if (on && kind === 'row') { el.style.overflowX = 'auto'; el.style.overflowY = 'hidden'; }
  else if (on && kind === 'column') { el.style.overflowY = 'auto'; el.style.overflowX = 'hidden'; }
  else { el.style.overflowX = ''; el.style.overflowY = ''; }
  // Keep the content scrollable but hide the native scrollbar (see .scrolls in canvas.css)
  el.classList.toggle('scrolls', on && (kind === 'row' || kind === 'column'));
}

// Border radius: a circle shape is fully round; otherwise either one uniform
// radius or four independent corners (TL TR BR BL).
function applyRadius(el, node) {
  if (node.shape === 'circle') { el.style.borderRadius = '50%'; return; }
  if (node.radiusMode === 'corners') {
    const r = node.radii || { tl: 0, tr: 0, br: 0, bl: 0 };
    el.style.borderRadius = `${r.tl}px ${r.tr}px ${r.br}px ${r.bl}px`;
  } else {
    el.style.borderRadius = (node.radius || 0) + 'px';
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
  if (isMaster(node)) el.classList.add('is-component');       // reusable component master
  if (node.type === 'instance') el.classList.add('is-instance');
  el.id = 'node-' + node.id;
  el.dataset.id = node.id;

  applyPosition(el, node);
  applySize(el, node);
  applyNodeTransform(el, node);
  el.style.opacity = node.opacity != null ? node.opacity : 1;
  el.style.display = node.visible ? '' : 'none';
  applyWrapperAlignment(el, node);

  if (node.type === 'text') {
    applyTextStyle(el, node);
    el.textContent = node.text;
  } else if (node.type === 'icon') {
    applyIcon(el, node, true);
  } else if (node.type === 'section') {
    // Section chrome (faint fill + outline) is styled entirely in CSS (.node.section);
    // it deliberately carries no fill/stroke/radius so its frames show through.
  } else if (node.type === 'instance') {
    renderInstanceBody(el, node); // live-mirror the component master's subtree
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
    if (!node.locked && state.tool !== 'connect' && !state.readonly) {
      // Frames (screens) resize from the bottom only — you extend the screen
      // downward for scrollable content, never sideways. Auto-size text is
      // content-driven, so it gets no resize handles (just the outline).
      const frameResize = node.type === 'frame';
      const wantResize = frameResize || (node.type !== 'instance' && !(node.type === 'text' && node.autoSize));
      const wantRadius = (node.type === 'container' || node.type === 'image') && node.shape !== 'circle' && node.radiusMode !== 'corners';
      if (wantResize || wantRadius) {
        // Handles live in a non-scrolling overlay pinned over the node, not among
        // its children — otherwise a scroll container would drag them along with
        // its content. The overlay is counter-translated to cancel the scroll.
        const layer = document.createElement('div');
        layer.className = 'sel-handles';
        el.appendChild(layer);
        if (wantResize) addHandles(layer, node, frameResize ? ['s'] : null);
        if (wantRadius) { addRadiusHandles(layer, node); positionRadiusHandles(el, node); }
        el.addEventListener('scroll', () => {
          layer.style.transform = `translate(${el.scrollLeft}px, ${el.scrollTop}px)`;
        });
      }
    }
  }

  if (node.children && node.children.length) {
    node.children.forEach(childId => {
      const child = getNode(childId);
      if (child) renderNode(child, el);
    });
  }

  if (node.type === 'frame') applyScreenFold(el, node);

  parent.appendChild(el);
  syncTextSize(el, node);
  attachNodeEvents(el, node);

  // Frames (and Sections) show their name on a small label above the top-left
  // corner (Figma style). It lives beside the node — not inside it — and
  // counter-scales off --zoom so it stays a constant on-screen size.
  if (node.type === 'frame' || node.type === 'section') addFrameLabel(node, parent);
}

// ── Component instances: a read-only live mirror of the master's subtree ──
// Ghosts carry no id/events/handles and are pointer-events:none (the instance box
// is the interactive unit), so one master can appear many times without clashing.
function renderInstanceBody(el, node, depth = 0) {
  const master = getMasterNode(node.componentId);
  if (!master || depth > 16) { el.classList.add('instance-missing'); return; }
  applyGhostStyle(el, master, depth); // style the instance box as the master root
}

function renderGhost(node, parentEl, depth) {
  const el = document.createElement('div');
  el.className = 'node ghost ' + (node.type === 'text' ? 'text-node' : node.type);
  applyPosition(el, node);
  applySize(el, node);
  applyNodeTransform(el, node);
  el.style.opacity = node.opacity != null ? node.opacity : 1;
  el.style.display = node.visible ? '' : 'none';
  applyWrapperAlignment(el, node);
  applyGhostStyle(el, node, depth);
  parentEl.appendChild(el);
  syncTextSize(el, node);
}

// Apply a node's type-appropriate visuals to `el`, then ghost-render its children.
// Position/size are set by the caller (the instance box, or renderGhost).
function applyGhostStyle(el, node, depth) {
  if (node.type === 'text') {
    applyTextStyle(el, node);
    el.textContent = node.text;
  } else if (node.type === 'icon') {
    applyIcon(el, node, true);
  } else if (node.type === 'section') {
    // no chrome
  } else if (node.type === 'instance') {
    renderInstanceBody(el, node, depth + 1); // nested instance
    return;
  } else {
    applyFill(el, node);
    applyStroke(el, node);
    applyRadius(el, node);
    if (SINGLE_CHILD_TYPES.includes(node.type)) applyPadding(el, node);
    if (node.type === 'container') { applyMargin(el, node); applyScroll(el, node); }
    if (node.type === 'container' || node.type === 'image') applyShadow(el, node);
    if (isFlex(node)) applyFlexLayout(el, node);
  }
  (node.children || []).forEach(cid => {
    const c = getNode(cid);
    if (c) renderGhost(c, el, depth);
  });
}

// A constant-size name tag above a frame/section. Pressing it acts on the node
// exactly like pressing the node body: click selects (shift adds), drag moves,
// Alt+drag duplicates — so a frame can be grabbed by its name, Figma-style.
function addFrameLabel(node, parent) {
  const label = document.createElement('div');
  label.className = 'frame-label' + (node.type === 'section' ? ' section-label' : '') + (state.selected.has(node.id) ? ' selected' : '');
  label.id = 'frame-label-' + node.id;
  label.textContent = node.name || 'Frame';
  label.style.left = node.x + 'px';
  label.style.top = node.y + 'px';
  label.addEventListener('mousedown', e => {
    if (state.tool !== 'select' || node.locked) return;
    e.stopPropagation();
    beginNodeDrag(node, e);
  });
  parent.appendChild(label);
}

// Frame screen fold: once a frame is dragged taller than its screen height, a
// dotted line marks where the visible device screen ends (everything below is
// scrollable content). Purely a visual guide — non-interactive, not laid out, and
// never emitted to generated code. Kept in sync on both full render and live resize.
function applyScreenFold(el, node) {
  if (node.screenH == null) node.screenH = node.h; // legacy frames: adopt current height
  let fold = el.querySelector(':scope > .screen-fold');
  if (node.h > node.screenH + 0.5) {
    if (!fold) {
      fold = document.createElement('div');
      fold.className = 'screen-fold';
      el.appendChild(fold);
    }
    fold.style.top = node.screenH + 'px';
  } else if (fold) {
    fold.remove();
  }
}

// Append the eight resize handles into `layer` (a non-scrolling overlay pinned
// over the node — see the selection block in renderNode).
function addHandles(layer, node, only) {
  // A non-resizable axis (fill/hug, or a text node's content-driven height) hides
  // that axis's side handles — and any corner that touches it, since a corner
  // can't resize a locked axis.
  // An explicit `only` list means the caller has already chosen the exact handles
  // (e.g. a frame's bottom-only handle), so skip the fluid-axis filtering below.
  const wFluid = !only && node.wMode && node.wMode !== 'fixed';
  const hFluid = !only && ((node.hMode && node.hMode !== 'fixed') || node.type === 'text');
  (only || ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']).forEach(pos => {
    if ((pos === 'w' || pos === 'e') && wFluid) return;       // width locked
    if ((pos === 'n' || pos === 's') && hFluid) return;       // height locked
    if (pos.length === 2 && (wFluid || hFluid)) return;       // corner touches a locked axis
    const h = document.createElement('div');
    h.className = `handle handle-${pos}`;
    h.dataset.handle = pos;
    layer.appendChild(h);
  });
}

// Figma-style corner-radius handles: a small circle near each corner. Dragging
// any of them sets the (uniform) border radius. Container & image only.
// Appended into `layer`; positioned separately via positionRadiusHandles.
function addRadiusHandles(layer, node) {
  ['nw', 'ne', 'sw', 'se'].forEach(corner => {
    const h = document.createElement('div');
    h.className = 'radius-handle';
    h.dataset.radius = corner;
    layer.appendChild(h);
  });
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
  // Keep a frame's/section's floating name tag glued to it while it moves.
  if (node.type === 'frame' || node.type === 'section') {
    const label = document.getElementById('frame-label-' + node.id);
    if (label) { label.style.left = node.x + 'px'; label.style.top = node.y + 'px'; }
  }
  if (node.type === 'frame') applyScreenFold(el, node); // live-update the fold on resize
  applyPosition(el, node);
  applySize(el, node);
  applyNodeTransform(el, node);
  applyWrapperAlignment(el, node);
  el.style.opacity = node.opacity != null ? node.opacity : 1;
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
