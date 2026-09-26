import { state, getNode, makeNode } from './state.js';
import { canvasWrap, selBox, closeMenus, ctxMenu, showToast } from './utils.js';
import { canvasToWorld, getWorldPos, findFrameAt, reparentNode, clearDropTargets, highlightDropTarget, isDescendant, isSingleChild, isStack,
  isFlex, flexKind, canAcceptChild, isScreenFrame } from './nodes.js';
import { saveHistory } from './history.js';
import { render, updateNodeEl, applyTransform, positionRadiusHandles, applyDragTransform } from './render.js';
import { renderProps } from './props.js';
import { setTool } from './tools.js';
import { duplicateSelected, deleteSelected, bringToFront, sendToBack, cloneNodeInPlace, createComponent,
  copySelected, pasteClipboard, hasClipboard, canReorder, detachInstance, goToNode } from './operations.js';
import { getComponent, getMasterNode } from './state.js';
import { isMaster, isInstance } from './state.js';
import { canBeComponent } from './nodes.js';
import { fitView } from './render.js';

let dragging = null;
let resizing = null;
let radiusDragging = null;
let panning = false;
// While dragging a node, its clipping ancestors (frames, scroll containers) are
// temporarily set to overflow:visible so the dragged item's translucent preview
// stays visible as it's pulled outside them. Saved here to restore on drop.
let dragUnclip = null;

function unclipDragAncestors(node) {
  const saved = [];
  let cur = node && node.parentId ? getNode(node.parentId) : null;
  while (cur) {
    const el = document.getElementById('node-' + cur.id);
    if (el) {
      saved.push({ el, overflow: el.style.overflow, overflowX: el.style.overflowX, overflowY: el.style.overflowY });
      el.style.overflow = el.style.overflowX = el.style.overflowY = 'visible';
    }
    cur = cur.parentId ? getNode(cur.parentId) : null;
  }
  return saved;
}
function restoreDragAncestors() {
  if (!dragUnclip) return;
  dragUnclip.forEach(s => { s.el.style.overflow = s.overflow; s.el.style.overflowX = s.overflowX; s.el.style.overflowY = s.overflowY; });
  dragUnclip = null;
}

// Drag moves are coalesced to one per animation frame (see onWrapMouseMove).
let dragRAF = null;
let dragEvent = null;

function cancelDragFrame() {
  if (dragRAF !== null) { cancelAnimationFrame(dragRAF); dragRAF = null; }
  dragEvent = null;
}

function flushDragMove() {
  dragRAF = null;
  const e = dragEvent;
  if (!dragging || !e) return;
  document.body.classList.add('dragging-node'); // show the move cursor only while moving
  if (!dragUnclip) dragUnclip = unclipDragAncestors(dragging.node); // let the preview escape its container
  const dx = (e.clientX - dragging.startX) / state.zoom;
  const dy = (e.clientY - dragging.startY) / state.zoom;
  if (dragging.multi) {
    dragging.multi.forEach(({ node: n, ox, oy }) => {
      n.x = ox + dx; n.y = oy + dy; updateNodeEl(n);
      const nel = document.getElementById('node-' + n.id);
      nel?.classList.add('drag-source');
      // Layout children ignore x/y, so translate them so the preview follows the cursor.
      if (nel && !isFreeNode(n)) applyDragTransform(nel, n, dx, dy);
    });
  } else {
    // First move of an Alt-drag: clone the node and drag the copy from here on
    if (dragging.altClone) {
      const copy = cloneNodeInPlace(dragging.altClone);
      dragging.altClone = null;
      if (copy) {
        dragging.node = copy;
        dragging.origX = copy.x; dragging.origY = copy.y;
        state.selected.clear(); state.selected.add(copy.id);
        render();
        if (isFreeNode(copy)) dragging.snapTargets = captureSnapTargets(copy);
      }
      clearGuides();
    }
    dragging.node.x = dragging.origX + dx;
    dragging.node.y = dragging.origY + dy;
    // Snapping uses the upright box; skip it for a rotated node, whose visible
    // bounds no longer line up with x/y/w/h. (Translation itself is unaffected.)
    if (dragging.snapTargets && !dragging.node.rotation) drawGuides(snapNode(dragging.node, dragging.snapTargets));
    else clearGuides();
    updateNodeEl(dragging.node);
    const del = document.getElementById('node-' + dragging.node.id);
    del?.classList.add('drag-source');
    // Layout children ignore x/y, so translate them so the preview follows the cursor.
    if (del && !isFreeNode(dragging.node)) applyDragTransform(del, dragging.node, dx, dy);
    showDrop(dropAt(e, dragging.node));
  }
  updateDragProps(); // cheap live X/Y update instead of rebuilding the whole panel each frame
}

// During a drag only the position changes, so just poke the X/Y inputs rather
// than re-running the (expensive) full renderProps() every animation frame.
function updateDragProps() {
  if (dragging.multi) return; // the multi-select panel doesn't show a single node's x/y
  const n = dragging.node;
  const xi = document.getElementById('p-x');
  const yi = document.getElementById('p-y');
  if (xi && document.activeElement !== xi) xi.value = Math.round(n.x);
  if (yi && document.activeElement !== yi) yi.value = Math.round(n.y);
}
let panStart = null;
let drawStart = null;
let selStart = null;
// The last click on a node (the element actually under the pointer), so a quick
// second click counts as a double-click. (The native dblclick event is unreliable
// here: selection re-renders the node element between clicks, breaking the
// browser's same-target requirement.)
let lastClick = null;
const DOUBLE_CLICK_MS = 350;

// ───────── Which element a click selects (Figma-style) ─────────
// A click selects the outermost element inside the screen; once something is
// selected, a click selects at that same level (a sibling of it, or of one of its
// ancestors); a double-click goes one level deeper; Ctrl/Cmd+click selects the
// innermost element straight away.

// The clicked element's ancestors, outermost first, from just inside its screen
// (or canvas root / section) down to the element itself.
function clickPath(node) {
  const path = [];
  for (let n = node; n; n = n.parentId ? getNode(n.parentId) : null) {
    if (n !== node && (isScreenFrame(n) || n.type === 'section')) break;
    path.unshift(n);
  }
  return path;
}

export function clickTarget(node, e) {
  if (e.ctrlKey || e.metaKey) return node;
  const path = clickPath(node);
  const sel = state.selected.size === 1 ? getNode([...state.selected][0]) : null;
  if (sel) {
    // Clicking the selection or something inside it keeps it (so it can be dragged).
    if (path.includes(sel)) return sel;
    // Otherwise stay at the selection's level: the deepest element of the path
    // whose parent also holds the selection.
    for (let i = path.length - 1; i >= 0; i--) {
      const p = path[i].parentId;
      if (p && (sel.parentId === p || isDescendant(sel.id, p))) return path[i];
    }
  }
  return path[0];
}

// A double-click: one level deeper than the selection, toward the clicked element.
export function drillTarget(node) {
  const sel = state.selected.size === 1 ? getNode([...state.selected][0]) : null;
  const path = clickPath(node);
  const i = sel ? path.indexOf(sel) : -1;
  return i >= 0 && i < path.length - 1 ? path[i + 1] : null;
}

// ───────── Where a dragged element lands ─────────
// Hit-tested against what's actually on screen (a row's or column's children are
// placed by the layout, not by their stored x/y). Inside a row / column / wrap
// the element goes between the children nearest the pointer, shown by a line.
function dropAt(e, dragged, fixed = null) {
  let target = fixed;
  if (!target) for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
    const nel = el.closest && el.closest('.node');
    const n = nel && getNode(nel.dataset.id);
    if (!n || n.id === dragged.id || isDescendant(n.id, dragged.id)) continue;
    // The innermost container under the pointer that can take the element.
    for (let c = n; c; c = c.parentId ? getNode(c.parentId) : null) {
      if (c.id !== dragged.id && !isDescendant(c.id, dragged.id) && canAcceptChild(c, dragged.id)) { target = c; break; }
    }
    break;
  }
  if (!target) return { parent: null };

  // Near the edge of a container that sits in a row/column: go beside it (into
  // the row/column) rather than inside it — that's how items are reordered.
  const outer = !fixed && target.parentId && getNode(target.parentId);
  if (outer && isFlex(outer) && canAcceptChild(outer, dragged.id)) {
    const r = document.getElementById('node-' + target.id)?.getBoundingClientRect();
    if (r) {
      const col = flexKind(outer) === 'column';
      const lo = col ? r.top : r.left, hi = col ? r.bottom : r.right, at = col ? e.clientY : e.clientX;
      const edge = Math.max(6, (hi - lo) * 0.25);
      if (at < lo + edge || at > hi - edge) target = outer;
    }
  }
  if (!isFlex(target)) return { parent: target };

  // Insert before the first child whose middle is past the pointer.
  const kind = flexKind(target);
  const order = (target.children || []).filter(id => id !== dragged.id);
  const kids = order
    .map(id => ({ id, el: document.getElementById('node-' + id) }))
    .filter(k => k.el && k.el.offsetParent !== null)
    .map(k => ({ id: k.id, r: k.el.getBoundingClientRect() }));
  const before = (r) => kind === 'column' ? e.clientY < (r.top + r.bottom) / 2
    : kind === 'row' ? e.clientX < (r.left + r.right) / 2
    : e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < (r.left + r.right) / 2); // wrap: by line, then x
  let pos = kids.findIndex(k => before(k.r));
  if (pos < 0) pos = kids.length;
  const index = pos < kids.length ? order.indexOf(kids[pos].id) : order.length;
  return { parent: target, index, line: dropLine(target, kind, kids, pos) };
}

// Screen coordinates of the insertion line: between the neighbours at `pos`.
function dropLine(target, kind, kids, pos) {
  const tr = document.getElementById('node-' + target.id).getBoundingClientRect();
  const prev = kids[pos - 1] && kids[pos - 1].r, next = kids[pos] && kids[pos].r;
  const ref = next || prev;
  if (kind === 'column') {
    const y = prev && next ? (prev.bottom + next.top) / 2 : next ? next.top - 2 : prev ? prev.bottom + 2 : tr.top + 4;
    return { x: ref ? ref.left : tr.left + 4, y, w: ref ? ref.width : tr.width - 8, h: 0 };
  }
  const x = prev && next && (kind === 'row' || prev.top === next.top) ? (prev.right + next.left) / 2
    : next ? next.left - 2 : prev ? prev.right + 2 : tr.left + 4;
  return { x, y: ref ? ref.top : tr.top + 4, w: 0, h: ref ? ref.height : tr.height - 8 };
}

// Where things are on screen, in world units — measured from the DOM, because a
// row's or column's children (and everything inside them) are placed by the
// layout, so their stored x/y are stale.
function pointerWorld(e) {
  const wr = canvasWrap.getBoundingClientRect();
  return canvasToWorld(e.clientX - wr.left, e.clientY - wr.top);
}
function centerWorld(n) {
  const r = nodeWorldRect(n);
  return { x: (r.L + r.R) / 2, y: (r.T + r.B) / 2 };
}
// The point a child's x/y count from: the parent's padding box.
export function worldOrigin(parent) {
  const el = document.getElementById('node-' + parent.id);
  if (!el) return getWorldPos(parent);
  const r = nodeWorldRect(parent);
  return { x: r.L + el.clientLeft - el.scrollLeft, y: r.T + el.clientTop - el.scrollTop };
}
// Give `n` x/y so its centre sits at world point `at` in its (new) parent.
function placeCenter(n, at) {
  const parent = n.parentId ? getNode(n.parentId) : null;
  if (parent && isSingleChild(parent)) { n.x = 0; n.y = 0; return; }
  if (parent && isFlex(parent)) return; // the layout places it
  const el = document.getElementById('node-' + n.id);
  const w = el ? el.offsetWidth : n.w, h = el ? el.offsetHeight : n.h;
  const o = parent ? worldOrigin(parent) : { x: 0, y: 0 };
  n.x = Math.round(at.x - w / 2 - o.x);
  n.y = Math.round(at.y - h / 2 - o.y);
}

// Where a new element drawn at a screen point goes: the outermost container
// under it that can take it (so drawing over nested boxes lands in the screen
// or section, not whatever sits on top), and — in a row / column — the index
// nearest the point.
export function drawTargetAt(clientX, clientY, type) {
  let best = null, bestDepth = Infinity;
  const depth = (n) => { let d = 0; for (let c = n; c && c.parentId; c = getNode(c.parentId)) d++; return d; };
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const nel = el.closest && el.closest('.node');
    const n = nel && getNode(nel.dataset.id);
    if (!n) continue;
    for (let c = n; c; c = c.parentId ? getNode(c.parentId) : null) {
      if (canAcceptChild(c, null, type) && depth(c) < bestDepth) { best = c; bestDepth = depth(c); }
    }
  }
  if (!best || !isFlex(best)) return { parent: best };
  return dropAt({ clientX, clientY }, { id: null }, best);
}

export function showDrop(drop) {
  clearDropTargets();
  let line = document.getElementById('drop-line');
  if (drop && drop.parent) document.getElementById('node-' + drop.parent.id)?.classList.add('drop-target');
  if (!drop || !drop.line) { if (line) line.style.display = 'none'; return; }
  if (!line) { line = document.createElement('div'); line.id = 'drop-line'; document.body.appendChild(line); }
  const { x, y, w, h } = drop.line;
  Object.assign(line.style, {
    display: 'block', left: x + 'px', top: y + 'px', width: Math.max(w, 2) + 'px', height: Math.max(h, 2) + 'px',
    transform: w ? 'translateY(-1px)' : 'translateX(-1px)',
  });
}

// ───────── Snapping / smart guides ─────────
const SNAP_PX = 6; // snap distance in screen pixels

// Only free-positioned nodes (canvas root or stack children) move by x/y, so only they snap.
function isFreeNode(n) {
  if (!n.parentId) return true;
  const p = getNode(n.parentId);
  return isStack(p);
}

// Capture other nodes' world rects once at drag start (they don't move while dragging one).
// Rects come from the DOM so they're accurate regardless of flex/absolute layout.
function captureSnapTargets(dragged) {
  const wrapRect = canvasWrap.getBoundingClientRect();
  const targets = [];
  state.nodes.forEach(n => {
    if (n.id === dragged.id || !n.visible || isDescendant(n.id, dragged.id)) return;
    const el = document.getElementById('node-' + n.id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const L = (r.left - wrapRect.left - state.panX) / state.zoom;
    const T = (r.top - wrapRect.top - state.panY) / state.zoom;
    const R = (r.right - wrapRect.left - state.panX) / state.zoom;
    const B = (r.bottom - wrapRect.top - state.panY) / state.zoom;
    targets.push({ L, T, R, B, CX: (L + R) / 2, CY: (T + B) / 2 });
  });
  return targets;
}

// Nudge node to the nearest matching edge/center (left/center/right & top/center/bottom)
// within tolerance, and return the guide line(s) to draw.
function snapNode(node, targets) {
  const tol = SNAP_PX / state.zoom;
  const wp = getWorldPos(node);
  const dX = [wp.x, wp.x + node.w / 2, wp.x + node.w];
  const dY = [wp.y, wp.y + node.h / 2, wp.y + node.h];
  let bestX = null, bestY = null;
  for (const r of targets) {
    for (const dv of dX) for (const tv of [r.L, r.CX, r.R]) {
      const delta = tv - dv;
      if (Math.abs(delta) <= tol && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, line: tv, r };
    }
    for (const dv of dY) for (const tv of [r.T, r.CY, r.B]) {
      const delta = tv - dv;
      if (Math.abs(delta) <= tol && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, line: tv, r };
    }
  }
  if (bestX) node.x += bestX.delta;
  if (bestY) node.y += bestY.delta;

  const guides = [];
  const w2 = getWorldPos(node);
  if (bestX) {
    const a = Math.min(w2.y, bestX.r.T), b = Math.max(w2.y + node.h, bestX.r.B);
    guides.push({ type: 'v', x: bestX.line, a, b, dist: rangeGap(w2.y, w2.y + node.h, bestX.r.T, bestX.r.B) });
  }
  if (bestY) {
    const a = Math.min(w2.x, bestY.r.L), b = Math.max(w2.x + node.w, bestY.r.R);
    guides.push({ type: 'h', y: bestY.line, a, b, dist: rangeGap(w2.x, w2.x + node.w, bestY.r.L, bestY.r.R) });
  }
  return guides;
}

// Gap between two 1-D ranges; negative (-1) when they overlap (no gap to show).
function rangeGap(aMin, aMax, bMin, bMax) {
  if (aMax <= bMin) return bMin - aMax;
  if (bMax <= aMin) return aMin - bMax;
  return -1;
}

// Snap the edge(s) being dragged by a resize handle to other elements'
// edges/centers, keeping the opposite (fixed) edge anchored. Mirrors snapNode
// but only the moving edges seek a match. Returns the guide line(s) to draw.
function snapResize(node, handle, targets) {
  const tol = SNAP_PX / state.zoom;
  const wp = getWorldPos(node);
  const L = wp.x, T = wp.y, R = wp.x + node.w, B = wp.y + node.h;
  const movingR = handle.includes('e'), movingL = handle.includes('w');
  const movingB = handle.includes('s'), movingT = handle.includes('n');

  let bestX = null, bestY = null;
  for (const r of targets) {
    const xLines = [r.L, r.CX, r.R], yLines = [r.T, r.CY, r.B];
    if (movingR) for (const tv of xLines) { const d = tv - R; if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.delta))) bestX = { edge: 'R', delta: d, line: tv, r }; }
    if (movingL) for (const tv of xLines) { const d = tv - L; if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.delta))) bestX = { edge: 'L', delta: d, line: tv, r }; }
    if (movingB) for (const tv of yLines) { const d = tv - B; if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.delta))) bestY = { edge: 'B', delta: d, line: tv, r }; }
    if (movingT) for (const tv of yLines) { const d = tv - T; if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.delta))) bestY = { edge: 'T', delta: d, line: tv, r }; }
  }

  // Apply the snap, but never shrink below the 10px minimum.
  if (bestX) {
    if (bestX.edge === 'R') { if (node.w + bestX.delta >= 10) node.w += bestX.delta; else bestX = null; }
    else { if (node.w - bestX.delta >= 10) { node.x += bestX.delta; node.w -= bestX.delta; } else bestX = null; }
  }
  if (bestY) {
    if (bestY.edge === 'B') { if (node.h + bestY.delta >= 10) node.h += bestY.delta; else bestY = null; }
    else { if (node.h - bestY.delta >= 10) { node.y += bestY.delta; node.h -= bestY.delta; } else bestY = null; }
  }

  const guides = [];
  const w2 = getWorldPos(node);
  if (bestX) {
    const a = Math.min(w2.y, bestX.r.T), b = Math.max(w2.y + node.h, bestX.r.B);
    guides.push({ type: 'v', x: bestX.line, a, b, dist: rangeGap(w2.y, w2.y + node.h, bestX.r.T, bestX.r.B) });
  }
  if (bestY) {
    const a = Math.min(w2.x, bestY.r.L), b = Math.max(w2.x + node.w, bestY.r.R);
    guides.push({ type: 'h', y: bestY.line, a, b, dist: rangeGap(w2.x, w2.x + node.w, bestY.r.L, bestY.r.R) });
  }
  return guides;
}

function drawGuides(guides) {
  const layer = document.getElementById('snap-guides');
  if (!layer) return;
  layer.innerHTML = '';
  for (const g of guides) {
    const d = document.createElement('div');
    const mid = (g.a + g.b) / 2;
    if (g.type === 'v') {
      d.className = 'snap-guide snap-v';
      d.style.left = (state.panX + g.x * state.zoom) + 'px';
      d.style.top = (state.panY + g.a * state.zoom) + 'px';
      d.style.height = ((g.b - g.a) * state.zoom) + 'px';
    } else {
      d.className = 'snap-guide snap-h';
      d.style.top = (state.panY + g.y * state.zoom) + 'px';
      d.style.left = (state.panX + g.a * state.zoom) + 'px';
      d.style.width = ((g.b - g.a) * state.zoom) + 'px';
    }
    layer.appendChild(d);

    // Distance badge at the line center (only when the items have a real gap)
    if (g.dist >= 0) {
      const label = document.createElement('div');
      label.className = 'snap-dist';
      label.textContent = Math.round(g.dist);
      if (g.type === 'v') {
        label.style.left = (state.panX + g.x * state.zoom) + 'px';
        label.style.top = (state.panY + mid * state.zoom) + 'px';
      } else {
        label.style.left = (state.panX + mid * state.zoom) + 'px';
        label.style.top = (state.panY + g.y * state.zoom) + 'px';
      }
      layer.appendChild(label);
    }
  }
}

function clearGuides() {
  const layer = document.getElementById('snap-guides');
  if (layer) layer.innerHTML = '';
}

// ───────── Rotation / flip aware geometry ─────────
// The node's local +X and +Y axes as unit vectors in world space, given its
// rotation and flips. These are the columns of the box→world linear map; because
// they're orthonormal, the same numbers (transposed) map world deltas → local.
function nodeAxes(node) {
  const t = (node.rotation || 0) * Math.PI / 180;
  const sx = node.flipH ? -1 : 1, sy = node.flipV ? -1 : 1;
  const cos = Math.cos(t), sin = Math.sin(t);
  return { axx: sx * cos, axy: sx * sin, ayx: -sy * sin, ayy: sy * cos };
}

// Project a world-space movement (dx, dy) onto a node's own axes, so dragging a
// rotated node's handle changes the dimension the user is actually pulling.
function toLocalDelta(node, dx, dy) {
  const a = nodeAxes(node);
  return { du: dx * a.axx + dy * a.axy, dv: dx * a.ayx + dy * a.ayy };
}

// World-space rect of a node, measured from the DOM (accurate for any layout).
function nodeWorldRect(n) {
  const el = document.getElementById('node-' + n.id);
  if (el) {
    const wrapRect = canvasWrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      L: (r.left - wrapRect.left - state.panX) / state.zoom,
      T: (r.top - wrapRect.top - state.panY) / state.zoom,
      R: (r.right - wrapRect.left - state.panX) / state.zoom,
      B: (r.bottom - wrapRect.top - state.panY) / state.zoom,
    };
  }
  const wp = getWorldPos(n);
  return { L: wp.x, T: wp.y, R: wp.x + n.w, B: wp.y + n.h };
}

// Figma-style measurement between two rects: edge insets when one contains the
// other, otherwise the gap on each axis where they're separated.
function measureBetween(a, b) {
  const segs = [];
  const aInB = a.L >= b.L && a.R <= b.R && a.T >= b.T && a.B <= b.B;
  const bInA = b.L >= a.L && b.R <= a.R && b.T >= a.T && b.B <= a.B;

  if (aInB || bInA) {
    const inner = aInB ? a : b;
    const outer = aInB ? b : a;
    const cy = (inner.T + inner.B) / 2;
    const cx = (inner.L + inner.R) / 2;
    segs.push({ type: 'h', y: cy, a: outer.L, b: inner.L, dist: inner.L - outer.L });
    segs.push({ type: 'h', y: cy, a: inner.R, b: outer.R, dist: outer.R - inner.R });
    segs.push({ type: 'v', x: cx, a: outer.T, b: inner.T, dist: inner.T - outer.T });
    segs.push({ type: 'v', x: cx, a: inner.B, b: outer.B, dist: outer.B - inner.B });
    return segs;
  }

  const vOverlap = Math.min(a.B, b.B) - Math.max(a.T, b.T);
  const hOverlap = Math.min(a.R, b.R) - Math.max(a.L, b.L);

  const measureY = vOverlap > 0 ? (Math.max(a.T, b.T) + Math.min(a.B, b.B)) / 2 : (a.T + a.B) / 2;
  if (a.R <= b.L) segs.push({ type: 'h', y: measureY, a: a.R, b: b.L, dist: b.L - a.R });
  else if (b.R <= a.L) segs.push({ type: 'h', y: measureY, a: b.R, b: a.L, dist: a.L - b.R });

  const measureX = hOverlap > 0 ? (Math.max(a.L, b.L) + Math.min(a.R, b.R)) / 2 : (a.L + a.R) / 2;
  if (a.B <= b.T) segs.push({ type: 'v', x: measureX, a: a.B, b: b.T, dist: b.T - a.B });
  else if (b.B <= a.T) segs.push({ type: 'v', x: measureX, a: b.B, b: a.T, dist: a.T - b.B });

  return segs;
}

export function attachNodeEvents(el, node) {
  el.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('radius-handle')) {
      e.stopPropagation();
      radiusDragging = { node, corner: e.target.dataset.radius };
      saveHistory();
      return;
    }
    if (e.target.classList.contains('handle')) {
      e.stopPropagation();
      resizing = {
        node,
        handle: e.target.dataset.handle,
        startX: e.clientX,
        startY: e.clientY,
        origX: node.x, origY: node.y,
        origW: node.w, origH: node.h,
        snapTargets: captureSnapTargets(node),
      };
      return;
    }

    if (!['select', 'hand'].includes(state.tool)) return;
    if (node.locked) return;
    e.stopPropagation();

    // Pressing the empty background of a screen that isn't selected starts a
    // selection box over its contents (a plain click still selects the screen);
    // a selected screen drags as usual.
    if (state.tool === 'select' && e.target === el && isScreenFrame(node) && !state.selected.has(node.id)
        && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const wr = canvasWrap.getBoundingClientRect();
      startMarquee(e.clientX - wr.left, e.clientY - wr.top, node.id);
      return;
    }

    if (state.tool === 'select') {
      const now = Date.now();
      const double = lastClick && lastClick.id === node.id && now - lastClick.t < DOUBLE_CLICK_MS;
      lastClick = double ? null : { id: node.id, t: now };
      if (double) {
        // A selected text starts editing; otherwise go one level deeper — and
        // straight into editing when that lands on the clicked text.
        if (node.type === 'text' && state.selected.has(node.id)) { startTextEdit(node, el, false, e); return; }
        const deeper = drillTarget(node);
        if (deeper === node && node.type === 'text' && !state.readonly) {
          // The pressed element is re-rendered away; stop the press's default
          // focus change, which would land on the page and end the edit at once.
          e.preventDefault();
          state.selected.clear(); state.selected.add(node.id); render();
          const fresh = document.getElementById('node-' + node.id);
          if (fresh) startTextEdit(node, fresh, false, e);
          return;
        }
        if (deeper) { state.selected.clear(); beginNodeDrag(deeper, e); return; }
      }
      beginNodeDrag(clickTarget(node, e), e);
    }
  });
}

// Select a node and arm the shared drag state for the mouse press `e`. Used by
// a node's own mousedown above and by its floating name label (render.js), so
// pressing/dragging the label behaves exactly like the frame body: click
// selects (shift adds), drag moves, Alt+drag duplicates.
export function beginNodeDrag(node, e) {
  // Viewers (read-only) can select a node to inspect it, but never move or Alt-duplicate.
  if (state.readonly) {
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) state.selected.clear();
    state.selected.add(node.id);
    render();
    return;
  }
  if (e.altKey) {
    // Alt+drag → duplicate; the copy is made on the first move (so Alt+click does nothing)
    state.selected.clear();
    state.selected.add(node.id);
  } else if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !state.selected.has(node.id)) {
    state.selected.clear();
    state.selected.add(node.id);
  } else {
    state.selected.add(node.id);
  }
  render();

  cancelDragFrame();       // drop any pending frame from an interrupted drag
  restoreDragAncestors();  // clear any leftover un-clip from an interrupted drag
  dragging = {
    node,
    startX: e.clientX,
    startY: e.clientY,
    origX: node.x,
    origY: node.y,
    altClone: e.altKey ? node : null,
    multi: (!e.altKey && state.selected.size > 1) ? [...state.selected].map(id => {
      const n = getNode(id);
      return n ? { node: n, ox: n.x, oy: n.y } : null;
    }).filter(Boolean) : null,
  };
  // Single free-node drags snap to other elements' edges/centers (deferred for Alt-clone)
  if (!dragging.multi && !dragging.altClone && isFreeNode(node)) dragging.snapTargets = captureSnapTargets(node);
  // Where in the element it was grabbed, so a drop can put it under the pointer
  // the same way.
  const p = pointerWorld(e), c = centerWorld(node);
  dragging.grab = { x: p.x - c.x, y: p.y - c.y };
  saveHistory();
}

// Start a selection box at canvas-wrap point (x, y); `frameId` scopes it to one
// screen's contents.
function startMarquee(x, y, frameId) {
  selStart = { x, y, frameId };
  selBox.style.display = 'block';
  selBox.style.left = x + 'px';
  selBox.style.top = y + 'px';
  selBox.style.width = '0';
  selBox.style.height = '0';
}

function onWrapMouseDown(e) {
  closeMenus();

  if (e.button === 1 || state.tool === 'hand') {
    panning = true;
    document.body.classList.add('panning'); // grabbing cursor over the whole canvas
    panStart = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
    canvasWrap.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  const wrapRect = canvasWrap.getBoundingClientRect();
  const cx = e.clientX - wrapRect.left;
  const cy = e.clientY - wrapRect.top;
  const world = canvasToWorld(cx, cy);

  if (['container', 'text', 'section'].includes(state.tool)) {
    drawStart = { cx, cy, x: world.x, y: world.y };
    e.preventDefault();
    return;
  }

  if (state.tool === 'select') {
    // This runs in the capture phase (before node/label handlers), so presses on
    // a node body or a frame name label must be exempted here — otherwise the
    // marquee starts underneath their drag and sweeps its own selection.
    const clickedNode = e.target.closest('.node, .frame-label');
    if (!clickedNode) {
      state.selected.clear();
      render();
      startMarquee(cx, cy, null);
    }
  }
}

function onWrapMouseMove(e) {
  if (panning && panStart) {
    state.panX = panStart.px + (e.clientX - panStart.x);
    state.panY = panStart.py + (e.clientY - panStart.y);
    applyTransform();
    return;
  }

  if (radiusDragging) {
    const n = radiusDragging.node;
    const el = document.getElementById('node-' + n.id);
    if (el) {
      // Map the cursor into the node's local box, accounting for rotation/flip.
      // getBoundingClientRect's centre is the node centre (rotation pivots there),
      // so we offset from the centre and project back onto the local axes.
      const rect = el.getBoundingClientRect();
      const a = nodeAxes(n);
      const ox = (e.clientX - (rect.left + rect.right) / 2) / state.zoom;
      const oy = (e.clientY - (rect.top + rect.bottom) / 2) / state.zoom;
      const localX = n.w / 2 + (ox * a.axx + oy * a.axy);
      const localY = n.h / 2 + (ox * a.ayx + oy * a.ayy);
      const c = radiusDragging.corner;
      const dx = Math.max(0, c.includes('w') ? localX : n.w - localX);
      const dy = Math.max(0, c.includes('n') ? localY : n.h - localY);
      const maxR = Math.min(n.w, n.h) / 2;
      n.radius = Math.round(Math.min(Math.hypot(dx, dy) / Math.SQRT2, maxR));
      updateNodeEl(n);
      positionRadiusHandles(el, n);
      renderProps();
    }
    return;
  }

  if (resizing) {
    const dxS = (e.clientX - resizing.startX) / state.zoom;
    const dyS = (e.clientY - resizing.startY) / state.zoom;
    const n = resizing.node;
    const h = resizing.handle;
    const rotated = !!(n.rotation || n.flipH || n.flipV);

    // Project the screen drag onto the node's own axes so a rotated/flipped node
    // grows the dimension the user is actually pulling (identity when upright).
    const { du, dv } = toLocalDelta(n, dxS, dyS);
    const mx = h.includes('e') ? 1 : h.includes('w') ? -1 : 0; // moving side,
    const my = h.includes('s') ? 1 : h.includes('n') ? -1 : 0; // in local axes
    let w = Math.max(10, resizing.origW + mx * du);
    let h2 = Math.max(10, resizing.origH + my * dv);

    // Hold Shift on a corner handle → keep the original aspect ratio
    const corner = mx !== 0 && my !== 0;
    if (e.shiftKey && corner) {
      const aspect = resizing.origW / resizing.origH;
      if (Math.abs(du) * resizing.origH >= Math.abs(dv) * resizing.origW) {
        h2 = Math.max(10, w / aspect); w = h2 * aspect;     // width drives
      } else {
        w = Math.max(10, h2 * aspect); h2 = w / aspect;     // height drives
      }
    }

    // Keep the opposite edge/corner anchored. The element rotates about its centre,
    // so hold the fixed point by shifting the centre, then derive x/y from it.
    const a = nodeAxes(n);
    const cx0 = resizing.origX + resizing.origW / 2;
    const cy0 = resizing.origY + resizing.origH / 2;
    const gx = (-mx) * (resizing.origW - w) / 2; // fixed-offset change, local axes
    const gy = (-my) * (resizing.origH - h2) / 2;
    n.x = cx0 + a.axx * gx + a.ayx * gy - w / 2;
    n.y = cy0 + a.axy * gx + a.ayy * gy - h2 / 2;
    n.w = w; n.h = h2;

    // Snapping assumes an axis-aligned box, so only for an upright node.
    if (resizing.snapTargets && !rotated && !(e.shiftKey && corner)) {
      drawGuides(snapResize(n, h, resizing.snapTargets));
    } else {
      clearGuides();
    }
    updateNodeEl(n);
    renderProps();
    return;
  }

  if (dragging) {
    // Coalesce rapid mousemove events into one update per animation frame — a
    // high-frequency mouse can otherwise fire several moves per paint, saturating
    // the main thread (heavy re-layout/repaint) so the drag appears to lag or stick.
    dragEvent = e;
    if (dragRAF === null) dragRAF = requestAnimationFrame(flushDragMove);
    return;
  }

  if (selStart) {
    const rect = canvasWrap.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const sx = Math.min(selStart.x, cx);
    const sy = Math.min(selStart.y, cy);
    const sw = Math.abs(cx - selStart.x);
    const sh = Math.abs(cy - selStart.y);
    selBox.style.left = sx + 'px';
    selBox.style.top = sy + 'px';
    selBox.style.width = sw + 'px';
    selBox.style.height = sh + 'px';
    return;
  }

  if (drawStart) {
    const rect = canvasWrap.getBoundingClientRect();
    const wx = e.clientX - rect.left;
    const wy = e.clientY - rect.top;
    const world = canvasToWorld(wx, wy);
    // Frames and sections are top-level, so they never highlight a drop target.
    if (!['frame', 'section'].includes(state.tool)) {
      const at = state.tool === 'text' ? { x: drawStart.cx, y: drawStart.cy } : { x: (drawStart.cx + wx) / 2, y: (drawStart.cy + wy) / 2 };
      showDrop(drawTargetAt(rect.left + at.x, rect.top + at.y, state.tool));
    }
    // Live preview of the rectangle being drawn (container/section) so it's visible
    // before the mouse is released. Text is auto-sized, so it gets no preview box.
    if (state.tool === 'container' || state.tool === 'section') {
      const sx = Math.min(drawStart.cx, wx);
      const sy = Math.min(drawStart.cy, wy);
      selBox.style.display = 'block';
      selBox.style.left = sx + 'px';
      selBox.style.top = sy + 'px';
      selBox.style.width = Math.abs(wx - drawStart.cx) + 'px';
      selBox.style.height = Math.abs(wy - drawStart.cy) + 'px';
    }
    return;
  }

  // Idle: hold Alt and hover another element to measure the distance to the selected one
  if (e.altKey && state.selected.size === 1) {
    const selNode = getNode([...state.selected][0]);
    const overEl = e.target.closest('.node');
    const overId = overEl && overEl.dataset.id;
    if (selNode && overId && overId !== selNode.id) {
      const overNode = getNode(overId);
      if (overNode) { drawGuides(measureBetween(nodeWorldRect(selNode), nodeWorldRect(overNode))); return; }
    }
  }
  clearGuides();
}

function onWrapMouseUp(e) {
  clearDropTargets();
  clearGuides();

  if (panning) {
    panning = false;
    document.body.classList.remove('panning');
    canvasWrap.style.cursor = state.tool === 'hand' ? 'grab' : 'default';
    return;
  }

  if (radiusDragging) { radiusDragging = null; saveHistory(); render(); return; }

  if (resizing) { resizing = null; saveHistory(); render(); return; }

  if (dragging) {
    if (dragEvent) flushDragMove(); // apply the final pending move so the drop lands exactly
    // Only a real drag reparents; a plain selection click must leave the node where
    // it is. Without this, releasing a click on a flex-row child re-runs the drop
    // test against its stale x/y and wrongly ejects it from the row.
    const moved = Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > 4;
    showDrop(null);
    let landed = null;
    if (!dragging.multi && moved) {
      const n = dragging.node;
      const drop = dropAt(e, n);
      const targetFrame = drop.parent;
      const targetId = targetFrame ? targetFrame.id : null;
      const p = pointerWorld(e);
      const at = { x: p.x - dragging.grab.x, y: p.y - dragging.grab.y }; // where its centre should land
      if (targetFrame && isFlex(targetFrame)) {
        // Into a row / column / wrap: at the spot the line showed. The layout
        // places it, so its stored x/y go back to what they were.
        const moving = targetId !== n.parentId;
        if (moving) reparentNode(n, targetId);
        const kids = targetFrame.children.filter(id => id !== n.id);
        kids.splice(drop.index, 0, n.id);
        targetFrame.children = kids;
        if (!moving) { n.x = dragging.origX; n.y = dragging.origY; }
        if (moving) showToast(`Moved into "${targetFrame.name}"`);
      } else if (targetId !== n.parentId) {
        reparentNode(n, targetId);
        placeCenter(n, at); // exactly where it was dropped
        landed = { n, at };
        showToast(targetFrame ? `Moved into "${targetFrame.name}"` : 'Moved to canvas');
      } else if (n.parentId) {
        // Stayed in the same parent: a single-child wrapper keeps its child pinned top-left
        const parent = getNode(n.parentId);
        if (isSingleChild(parent)) { n.x = 0; n.y = 0; }
      }
    }
    // Several items dragged together only move the free ones; items in a row /
    // column snap back, so their stored x/y go back too.
    if (dragging.multi) dragging.multi.forEach(({ node: m, ox, oy }) => { if (!isFreeNode(m)) { m.x = ox; m.y = oy; } });
    dragging = null;
    cancelDragFrame();
    restoreDragAncestors();
    document.body.classList.remove('dragging-node');
    render();
    // Out of a row / column its size can change (it was stretched there), so
    // re-centre it on the drop point now that it's drawn at its real size.
    if (landed) {
      const c = centerWorld(landed.n);
      landed.n.x = Math.round(landed.n.x + landed.at.x - c.x);
      landed.n.y = Math.round(landed.n.y + landed.at.y - c.y);
      updateNodeEl(landed.n);
      renderProps();
    }
    saveHistory();
    return;
  }

  if (selStart) {
    selBox.style.display = 'none';
    const rect = canvasWrap.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const sx = Math.min(selStart.x, cx);
    const sy = Math.min(selStart.y, cy);
    const sw = Math.abs(cx - selStart.x);
    const sh = Math.abs(cy - selStart.y);
    const inside = selStart.frameId ? getNode(selStart.frameId) : null;
    if (sw > 4 && sh > 4) {
      // One level at a time, like Figma: from empty canvas the top-level items;
      // from inside a screen, that screen's own children. Compared on screen, so
      // it's right for laid-out children too.
      const box = { L: rect.left + sx, T: rect.top + sy, R: rect.left + sx + sw, B: rect.top + sy + sh };
      const pool = inside ? (inside.children || []).map(getNode).filter(Boolean) : state.nodes.filter(n => !n.parentId);
      if (inside) state.selected.clear();
      pool.forEach(n => {
        if (n.locked || !n.visible) return; // locked/hidden layers aren't marquee-selectable
        const el = document.getElementById('node-' + n.id);
        const r = el && el.getBoundingClientRect();
        if (r && r.left < box.R && r.right > box.L && r.top < box.B && r.bottom > box.T) state.selected.add(n.id);
      });
      render();
    } else if (inside) {
      // A click (no drag) on a screen's background selects the screen.
      state.selected.clear();
      state.selected.add(inside.id);
      render();
    }
    selStart = null;
    return;
  }

  if (drawStart) {
    selBox.style.display = 'none'; // clear the live draw preview
    const rect = canvasWrap.getBoundingClientRect();
    const wx = e.clientX - rect.left;
    const wy = e.clientY - rect.top;
    const world = canvasToWorld(wx, wy);

    const worldX = Math.min(drawStart.x, world.x);
    const worldY = Math.min(drawStart.y, world.y);
    let w = Math.max(10, Math.abs(world.x - drawStart.x));
    let h = Math.max(10, Math.abs(world.y - drawStart.y));
    // Text is auto-sized (grows with its content), so the drawn box size is ignored
    // — we anchor it at the click point and let the content define width/height.
    const isText = state.tool === 'text';
    if (isText) { w = 10; h = 10; }

    const anchorX = isText ? drawStart.x : worldX;
    const anchorY = isText ? drawStart.y : worldY;
    const midX = (drawStart.x + world.x) / 2;
    const midY = (drawStart.y + world.y) / 2;
    // Frames and sections are top-level; everything else can nest into a frame.
    showDrop(null);
    const target = !['frame', 'section'].includes(state.tool)
      ? drawTargetAt(rect.left + (isText ? drawStart.cx : (drawStart.cx + wx) / 2),
          rect.top + (isText ? drawStart.cy : (drawStart.cy + wy) / 2), state.tool)
      : { parent: null };
    const parentFrame = target.parent;

    let localX = anchorX, localY = anchorY;
    if (parentFrame) {
      if (isSingleChild(parentFrame)) {
        // Single-child wrappers pin their child to the top-left corner
        localX = 0;
        localY = 0;
      } else {
        const pp = worldOrigin(parentFrame);
        localX = anchorX - pp.x;
        localY = anchorY - pp.y;
      }
    }

    const isSection = state.tool === 'section';
    const node = makeNode(state.tool, localX, localY, w, h, parentFrame ? parentFrame.id : null);
    if (parentFrame) {
      // In a row / column it goes where it was drawn, not at the end.
      if (target.index != null) parentFrame.children.splice(target.index, 0, node.id);
      else parentFrame.children.push(node.id);
    }
    state.nodes.push(node);
    // Drawing a Section over existing root frames adopts them (Figma-style), so
    // they become files under the section's folder. Only frames fully inside the
    // drawn box are captured; each keeps its on-screen spot (reparent converts
    // world→section-local coords).
    if (isSection) {
      const sx = node.x, sy = node.y, sr = node.x + node.w, sb = node.y + node.h;
      state.nodes
        .filter(n => n.type === 'frame' && !n.parentId)
        .forEach(fr => {
          if (fr.x >= sx && fr.y >= sy && fr.x + fr.w <= sr && fr.y + fr.h <= sb) {
            reparentNode(fr, node.id);
          }
        });
    }
    state.selected.clear();
    state.selected.add(node.id);
    setTool('select');
    drawStart = null;

    if (isText) {
      // Figma-style: start empty and drop straight into inline editing.
      node.text = '';
      render();
      const el = document.getElementById('node-' + node.id);
      if (el) startTextEdit(node, el, true);
      return;
    }

    saveHistory();
    render();
    return;
  }
}

// Walk up from the wheeled element to the nearest scroll-enabled container node
// that still has room to scroll in the wheel's direction, returning it plus the
// axis/amount to scroll. A vertical scroller (Column layout) takes a plain wheel;
// a horizontal scroller (Row layout) takes Shift+wheel — or a native horizontal
// (trackpad) delta. Returns null at the scroller's edge, so the scroll "chains"
// back out and the canvas pans instead.
function scrollableUnder(target, shift, dx, dy) {
  let el = target instanceof Element ? target : null;
  while (el && el !== canvasWrap) {
    if (el.classList && el.classList.contains('node')) {
      const cs = getComputedStyle(el);
      const canY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      const canX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth;
      if (canY && !shift) {
        const amt = dy || dx;
        const atTop = amt < 0 && el.scrollTop <= 0;
        const atBottom = amt > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        if (amt && !atTop && !atBottom) return { el, axis: 'y', amt };
      }
      if (canX) {
        const amt = dx || (shift ? dy : 0); // Shift maps the vertical wheel to horizontal
        const atLeft = amt < 0 && el.scrollLeft <= 0;
        const atRight = amt > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
        if (amt && !atLeft && !atRight) return { el, axis: 'x', amt };
      }
    }
    el = el.parentElement;
  }
  return null;
}

function onWheel(e) {
  // A hovered, scrollable container scrolls instead of panning the canvas.
  if (!(e.ctrlKey || e.metaKey)) {
    const sc = scrollableUnder(e.target, e.shiftKey, e.deltaX, e.deltaY);
    if (sc) {
      e.preventDefault();
      if (sc.axis === 'y') sc.el.scrollTop += sc.amt;
      else sc.el.scrollLeft += sc.amt;
      return;
    }
  }
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = canvasWrap.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const wx = (cx - state.panX) / state.zoom;
    const wy = (cy - state.panY) / state.zoom;
    state.zoom = Math.min(8, Math.max(0.05, state.zoom * factor));
    state.panX = cx - wx * state.zoom;
    state.panY = cy - wy * state.zoom;
  } else {
    state.panX -= e.deltaX;
    state.panY -= e.deltaY;
  }
  applyTransform();
}

function onDblClick(e) {
  const nodeEl = e.target.closest('.node');
  if (!nodeEl) return;
  const node = getNode(nodeEl.dataset.id);
  if (!node || node.type !== 'text' || !state.selected.has(node.id)) return;
  startTextEdit(node, nodeEl, false, e);
}

let editingTextId = null;
export const isEditingText = () => editingTextId !== null;

// Inline, Figma-style text editing: the node element itself becomes editable so
// it grows live as the user types. `isNew` marks a freshly-created node so it is
// removed if the user leaves it empty.
function startTextEdit(node, el, isNew = false, ev = null) {
  if (editingTextId || state.readonly) return; // viewers can't edit text
  editingTextId = node.id;
  editingTextId = node.id;

  // Remove any selection handles, then make the box editable and auto-growing.
  el.querySelectorAll('.handle, .radius-handle').forEach(h => h.remove());
  el.classList.add('editing');
  el.style.height = 'auto';
  if (node.autoSize) {
    el.style.whiteSpace = 'pre'; el.style.width = 'auto'; el.style.wordBreak = '';
  } else {
    // Fixed-width: keep the box width and wrap as the user types.
    el.style.whiteSpace = 'pre-wrap'; el.style.width = node.w + 'px'; el.style.wordBreak = 'break-word';
  }
  el.setAttribute('contenteditable', 'plaintext-only');
  el.textContent = node.text;

  el.focus();
  // Place the caret rather than selecting everything, so typing inserts instead
  // of replacing the whole text. Re-edits drop the caret where the user clicked;
  // otherwise it goes to the end (and a new, empty node just gets the caret).
  const sel = window.getSelection();
  sel.removeAllRanges();
  let range = null;
  if (!isNew && ev && document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // caret at the end of the content
  }
  sel.addRange(range);

  const onInput = () => {
    node.text = el.innerText;
    node.h = el.offsetHeight;
    if (node.autoSize) node.w = el.offsetWidth; // fixed-width keeps its width
  };

  const finish = () => {
    el.removeEventListener('input', onInput);
    el.removeEventListener('blur', finish);
    el.removeEventListener('keydown', onKey);
    el.removeAttribute('contenteditable');
    el.classList.remove('editing');
    editingTextId = null;
    node.text = el.innerText;
    // Drop an empty text node (nothing was typed).
    if (!node.text.trim()) {
      deleteNode(node);
    } else {
      saveHistory();
    }
    render();
  };

  const onKey = (e) => {
    // Keep canvas shortcuts (delete, arrows, tool keys) from firing while typing.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
  };

  el.addEventListener('input', onInput);
  el.addEventListener('blur', finish);
  el.addEventListener('keydown', onKey);
}

// Remove a node (and its subtree) from state — used when an empty text node is abandoned.
function deleteNode(node) {
  const ids = new Set();
  const collect = (n) => { ids.add(n.id); (n.children || []).forEach(cid => { const c = getNode(cid); if (c) collect(c); }); };
  collect(node);
  if (node.parentId) {
    const p = getNode(node.parentId);
    if (p) p.children = p.children.filter(id => id !== node.id);
  }
  state.nodes = state.nodes.filter(n => !ids.has(n.id));
  state.selected.delete(node.id);
}

// The right-click menu offers only what applies to what's under the pointer:
// on an element, actions on it (and the rest of the selection); on empty canvas,
// actions on the canvas. Items that would do nothing aren't shown.
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318' : 'Ctrl+';

function menuItems(nodes) {
  const items = [];
  const add = (action, label, shortcut, extra = '') => items.push({ action, label, shortcut, extra });
  const sep = () => { if (items.length && items[items.length - 1] !== 'sep') items.push('sep'); };

  if (!nodes.length) {
    // Empty canvas.
    if (hasClipboard()) add('paste', 'Paste', MOD + 'V');
    if (state.nodes.length) {
      add('select-all', 'Select all', MOD + 'A');
      add('fit', 'Zoom to fit', '0');
    }
    return items;
  }

  add('copy', 'Copy', MOD + 'C');
  if (hasClipboard()) add('paste', 'Paste', MOD + 'V');
  add('duplicate', 'Duplicate', MOD + 'D');
  if (nodes.length === 1 && nodes[0].parentId) add('select-parent', 'Select parent');
  sep();
  if (nodes.length === 1 && canBeComponent(nodes[0]) && !isMaster(nodes[0]) && !isInstance(nodes[0])) {
    add('component', 'Create component');
  }
  if (nodes.length === 1 && isInstance(nodes[0]) && getMasterNode(nodes[0].componentId)) {
    add('go-component', 'Go to component');
    add('detach', 'Detach instance');
  }
  if (nodes.some(canReorder)) { add('front', 'Bring to front'); add('back', 'Send to back'); }
  sep();
  add('delete', 'Delete', 'Del', 'ctx-danger');
  return items;
}

function onContextMenu(e) {
  e.preventDefault();
  if (state.readonly) return; // viewers get no editing menu
  const nodeEl = e.target.closest('.node:not(.ghost)');
  const node = nodeEl && getNode(nodeEl.dataset.id);
  if (node) {
    if (!state.selected.has(node.id)) { state.selected = new Set([node.id]); render(); }
  } else if (state.selected.size) {
    state.selected.clear(); // right-clicking empty canvas deselects, as a left click does
    render();
  }
  const nodes = node ? [...state.selected].map(getNode).filter(Boolean) : [];
  const items = menuItems(nodes);
  if (!items.length) { ctxMenu.style.display = 'none'; return; }
  ctxMenu.innerHTML = items.map(it => it === 'sep' ? '<div class="ctx-sep"></div>'
    : `<div class="ctx-item ${it.extra}" data-action="${it.action}"><span>${it.label}</span>${it.shortcut ? `<span class="shortcut">${it.shortcut}</span>` : ''}</div>`).join('');
  // Keep the menu on screen near the window edges.
  ctxMenu.style.display = 'block';
  const w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(e.clientX, window.innerWidth - w - 8) + 'px';
  ctxMenu.style.top = Math.min(e.clientY, window.innerHeight - h - 8) + 'px';
}

export function initCanvasEvents() {
  // Suppress the browser's native right-click menu everywhere, in every tab.
  document.addEventListener('contextmenu', e => e.preventDefault());

  // Canvas interaction (select/drag/pan/zoom/context-menu) is design-only;
  // the model board shares #canvas-wrap, so skip these in other modes.
  const designOnly = (fn) => (e) => { if (document.body.classList.contains('design-mode')) fn(e); };
  canvasWrap.addEventListener('mousedown', designOnly(onWrapMouseDown), true);
  canvasWrap.addEventListener('mousemove', designOnly(onWrapMouseMove));
  canvasWrap.addEventListener('mouseup', designOnly(onWrapMouseUp));
  canvasWrap.addEventListener('wheel', designOnly(onWheel), { passive: false });
  // Kill the browser's ctrl/⌘ + wheel page zoom everywhere — the canvas does its
  // own zoom (onWheel above); over any other panel we still never want the browser
  // default. Must be non-passive so preventDefault takes effect.
  window.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  }, { passive: false });
  canvasWrap.addEventListener('contextmenu', designOnly(onContextMenu));
  canvasWrap.addEventListener('dblclick', designOnly(onDblClick));

  // Releasing Alt clears any Alt-hover measurement guides
  document.addEventListener('keyup', e => { if (e.key === 'Alt' && !dragging) clearGuides(); });

  // Context menu actions
  ctxMenu.addEventListener('click', e => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    const action = item.dataset.action;
    closeMenus();
    if (action === 'copy') copySelected();
    if (action === 'paste') pasteClipboard();
    if (action === 'duplicate') duplicateSelected();
    if (action === 'select-parent') {
      const n = getNode([...state.selected][0]);
      if (n && n.parentId) { state.selected = new Set([n.parentId]); render(); }
    }
    if (action === 'component') createComponent();
    if (action === 'go-component') {
      const c = getComponent((getNode([...state.selected][0]) || {}).componentId);
      if (c) goToNode(c.rootId);
    }
    if (action === 'detach') {
      const n = getNode([...state.selected][0]);
      if (n && detachInstance(n)) { saveHistory(); render(); }
    }
    if (action === 'front') bringToFront();
    if (action === 'back') sendToBack();
    if (action === 'delete') deleteSelected();
    if (action === 'select-all') { state.selected = new Set(state.nodes.filter(n => !n.parentId).map(n => n.id)); render(); }
    if (action === 'fit') fitView();
  });

  // Close menus on outside click
  document.addEventListener('click', e => {
    if (!ctxMenu.contains(e.target)) ctxMenu.style.display = 'none';
    const frameMenu = document.getElementById('frame-menu');
    if (!frameMenu.contains(e.target) && !e.target.closest('#tool-frame')) frameMenu.style.display = 'none';
  });
}
