import { state, getNode, makeNode } from './state.js';
import { canvasWrap, selBox, closeMenus, ctxMenu, showToast } from './utils.js';
import { canvasToWorld, getWorldPos, findFrameAt, reparentNode, clearDropTargets, highlightDropTarget, isDescendant, isSingleChild, isStack } from './nodes.js';
import { saveHistory } from './history.js';
import { render, updateNodeEl, applyTransform, positionRadiusHandles } from './render.js';
import { renderProps } from './props.js';
import { setTool } from './tools.js';
import { duplicateSelected, groupSelected, deleteSelected, bringToFront, sendToBack, cloneNodeInPlace } from './operations.js';

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
let panStart = null;
let drawStart = null;
let selStart = null;
// Tracks the last text-node click so a quick second click re-opens inline editing.
// (The native dblclick event is unreliable here because selection re-renders the
// node element between clicks, breaking the browser's same-target requirement.)
let lastTextClick = null;

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

    if (state.tool === 'select') {
      // Double-click a text node → re-enter inline editing (manual detection,
      // since render() between clicks defeats the native dblclick event).
      if (node.type === 'text') {
        const now = Date.now();
        if (lastTextClick && lastTextClick.id === node.id && now - lastTextClick.t < 350) {
          lastTextClick = null;
          startTextEdit(node, el, false, e);
          return;
        }
        lastTextClick = { id: node.id, t: now };
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

      restoreDragAncestors(); // clear any leftover un-clip from an interrupted drag
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
      saveHistory();
    }
  });
}

function onWrapMouseDown(e) {
  closeMenus();

  if (e.button === 1 || state.tool === 'hand') {
    panning = true;
    panStart = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
    canvasWrap.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }

  const wrapRect = canvasWrap.getBoundingClientRect();
  const cx = e.clientX - wrapRect.left;
  const cy = e.clientY - wrapRect.top;
  const world = canvasToWorld(cx, cy);

  if (['container', 'text'].includes(state.tool)) {
    drawStart = { cx, cy, x: world.x, y: world.y };
    e.preventDefault();
    return;
  }

  if (state.tool === 'select') {
    const clickedNode = e.target.closest('.node');
    if (!clickedNode) {
      state.selected.clear();
      render();
      selStart = { x: cx, y: cy };
      selBox.style.display = 'block';
      selBox.style.left = cx + 'px';
      selBox.style.top = cy + 'px';
      selBox.style.width = '0';
      selBox.style.height = '0';
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
    document.body.classList.add('dragging-node'); // show the move cursor only while moving
    if (!dragUnclip) dragUnclip = unclipDragAncestors(dragging.node); // let the preview escape its container
    const dx = (e.clientX - dragging.startX) / state.zoom;
    const dy = (e.clientY - dragging.startY) / state.zoom;
    if (dragging.multi) {
      dragging.multi.forEach(({ node: n, ox, oy }) => {
        n.x = ox + dx; n.y = oy + dy; updateNodeEl(n);
        document.getElementById('node-' + n.id)?.classList.add('drag-source');
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
      document.getElementById('node-' + dragging.node.id)?.classList.add('drag-source');
      const wp = getWorldPos(dragging.node);
      highlightDropTarget(wp.x + dragging.node.w / 2, wp.y + dragging.node.h / 2, dragging.node.id);
    }
    renderProps();
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
    if (state.tool !== 'frame') highlightDropTarget(world.x, world.y);
    // Live preview of the rectangle being drawn (container) so it's visible
    // before the mouse is released. Text is auto-sized, so it gets no preview box.
    if (state.tool === 'container') {
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
    canvasWrap.style.cursor = state.tool === 'hand' ? 'grab' : 'default';
    return;
  }

  if (radiusDragging) { radiusDragging = null; saveHistory(); render(); return; }

  if (resizing) { resizing = null; saveHistory(); render(); return; }

  if (dragging) {
    if (!dragging.multi) {
      const n = dragging.node;
      const wp = getWorldPos(n);
      const centerX = wp.x + n.w / 2;
      const centerY = wp.y + n.h / 2;
      const targetFrame = findFrameAt(centerX, centerY, n.id);
      const targetId = targetFrame ? targetFrame.id : null;
      if (targetId !== n.parentId) {
        reparentNode(n, targetId);
        showToast(targetFrame ? `Moved into "${targetFrame.name}"` : 'Moved to canvas');
      } else if (n.parentId) {
        // Stayed in the same parent: a single-child wrapper keeps its child pinned top-left
        const parent = getNode(n.parentId);
        if (isSingleChild(parent)) { n.x = 0; n.y = 0; }
      }
    }
    dragging = null;
    restoreDragAncestors();
    document.body.classList.remove('dragging-node');
    saveHistory();
    render();
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
    if (sw > 4 && sh > 4) {
      const w1 = canvasToWorld(sx, sy);
      const w2 = canvasToWorld(sx + sw, sy + sh);
      state.nodes.forEach(n => {
        if (n.locked || !n.visible) return; // locked/hidden layers aren't marquee-selectable
        if (n.x < w2.x && n.x + n.w > w1.x && n.y < w2.y && n.y + n.h > w1.y) {
          state.selected.add(n.id);
        }
      });
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
    const parentFrame = state.tool !== 'frame' ? findFrameAt(isText ? drawStart.x : midX, isText ? drawStart.y : midY) : null;

    let localX = anchorX, localY = anchorY;
    if (parentFrame) {
      if (isSingleChild(parentFrame)) {
        // Single-child wrappers pin their child to the top-left corner
        localX = 0;
        localY = 0;
      } else {
        const pp = getWorldPos(parentFrame);
        localX = anchorX - pp.x;
        localY = anchorY - pp.y;
      }
    }

    const node = makeNode(state.tool, localX, localY, w, h, parentFrame ? parentFrame.id : null);
    if (parentFrame) {
      parentFrame.children.push(node.id);
    }
    state.nodes.push(node);
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

function onWheel(e) {
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
  if (!node || node.type !== 'text') return;
  startTextEdit(node, nodeEl, false, e);
}

let editingTextId = null;
export const isEditingText = () => editingTextId !== null;

// Inline, Figma-style text editing: the node element itself becomes editable so
// it grows live as the user types. `isNew` marks a freshly-created node so it is
// removed if the user leaves it empty.
function startTextEdit(node, el, isNew = false, ev = null) {
  if (editingTextId) return;
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

function onContextMenu(e) {
  e.preventDefault();
  const nodeEl = e.target.closest('.node');
  if (nodeEl) {
    const node = getNode(nodeEl.dataset.id);
    if (node && !state.selected.has(node.id)) {
      state.selected.clear();
      state.selected.add(node.id);
      render();
    }
  }
  ctxMenu.style.left = e.clientX + 'px';
  ctxMenu.style.top = e.clientY + 'px';
  ctxMenu.style.display = 'block';
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
  canvasWrap.addEventListener('contextmenu', designOnly(onContextMenu));
  canvasWrap.addEventListener('dblclick', designOnly(onDblClick));

  // Releasing Alt clears any Alt-hover measurement guides
  document.addEventListener('keyup', e => { if (e.key === 'Alt' && !dragging) clearGuides(); });

  // Context menu actions
  ctxMenu.addEventListener('click', e => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    const action = item.dataset.action;
    if (action === 'duplicate') duplicateSelected();
    if (action === 'group') groupSelected();
    if (action === 'delete') deleteSelected();
    if (action === 'front') bringToFront();
    if (action === 'back') sendToBack();
    closeMenus();
  });

  // Close menus on outside click
  document.addEventListener('click', e => {
    if (!ctxMenu.contains(e.target)) ctxMenu.style.display = 'none';
    const addMenu = document.getElementById('add-menu');
    if (!addMenu.contains(e.target) && e.target.id !== 'btn-add-layer') addMenu.style.display = 'none';
    const frameMenu = document.getElementById('frame-menu');
    if (!frameMenu.contains(e.target) && !e.target.closest('#tool-frame')) frameMenu.style.display = 'none';
  });
}
