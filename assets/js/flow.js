// Connect mode (Figma-style prototype wiring). With the Connect tool active the
// canvas becomes a wiring surface: drag from any layer to a frame (screen) to set
// that layer's onTap → navigate action. Existing links are drawn as arrows; click
// an arrow to select it and edit its mode/transition or remove it. This is an
// alternative UI over the same `node.action` model — no code generation here.

import { state, getNode } from './state.js';
import { canvas, canvasWrap } from './utils.js';
import { saveHistory } from './history.js';
import { render } from './render.js';
import { renderProps } from './props.js';
import { ddTrigger } from './dropdown.js';

const SVG = 'http://www.w3.org/2000/svg';
const OFF = 10000; // the overlay spans a large box offset by OFF so world coords (incl. negatives) are hit-testable
const ACCENT = '#1ECC7A';

const NAV_MODES = [{ value: 'push', label: 'Push' }, { value: 'replace', label: 'Replace' }, { value: 'clear', label: 'Clear stack' }];
const TRANSITIONS = [{ value: 'platform', label: 'Platform' }, { value: 'fade', label: 'Fade' }, { value: 'slideRight', label: 'Slide' }, { value: 'none', label: 'None' }];
const MODE_LABEL = Object.fromEntries(NAV_MODES.map(o => [o.value, o.label]));
const TRANS_LABEL = Object.fromEntries(TRANSITIONS.map(o => [o.value, o.label]));

const DRAG_THRESHOLD = 4;  // px the pointer must move before it counts as a drag (not a click)
let layer;                 // <svg> overlay (persists across render())
let dragFrom = null;       // source node id while a wire gesture is in progress
let dragStart = null;      // {x,y} world center of the source
let downClient = null;     // {x,y} screen pos of the press, to tell a click from a drag
let moved = false;         // has the pointer moved past the threshold this gesture?
let tempPath = null;       // the dashed <path> shown during a drag
let selectedSrc = null;    // source node id of the currently-selected connection
let pop, popTarget, popMode, popTrans, popDel;

// ── coordinate helpers (in #canvas-local / "world" units) ──
function localOf(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: (clientX - r.left) / state.zoom, y: (clientY - r.top) / state.zoom };
}
function nodeRect(id) {
  const el = document.getElementById('node-' + id);
  if (!el) return null;
  const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
  return { x: (r.left - c.left) / state.zoom, y: (r.top - c.top) / state.zoom, w: r.width / state.zoom, h: r.height / state.zoom };
}
function centerOf(rect) { return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }; }
// Where the segment from a rect's center toward (tx,ty) exits the rect.
function edgePoint(rect, tx, ty) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const s = Math.min(dx ? (rect.w / 2) / Math.abs(dx) : Infinity, dy ? (rect.h / 2) / Math.abs(dy) : Infinity);
  return { x: cx + dx * s, y: cy + dy * s };
}
// Cubic path (in SVG space = world + OFF) with horizontal control handles.
function pathD(ax, ay, bx, by) {
  ax += OFF; ay += OFF; bx += OFF; by += OFF;
  const k = Math.max(40, Math.min(160, Math.abs(bx - ax) * 0.5));
  const dir = bx >= ax ? 1 : -1;
  return `M ${ax} ${ay} C ${ax + dir * k} ${ay} ${bx - dir * k} ${by} ${bx} ${by}`;
}

function ensureLayer() {
  if (!layer || !layer.isConnected) {
    layer = document.createElementNS(SVG, 'svg');
    layer.id = 'flow-layer';
    layer.setAttribute('width', OFF * 2);
    layer.setAttribute('height', OFF * 2);
    layer.style.left = -OFF + 'px';
    layer.style.top = -OFF + 'px';
    const defs = document.createElementNS(SVG, 'defs');
    const marker = document.createElementNS(SVG, 'marker');
    marker.setAttribute('id', 'flow-arrow');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8'); marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    const mp = document.createElementNS(SVG, 'path');
    mp.setAttribute('d', 'M0 0 L10 5 L0 10 z'); mp.setAttribute('fill', ACCENT);
    marker.appendChild(mp); defs.appendChild(marker); layer.appendChild(defs);
    canvas.appendChild(layer);
  }
  canvas.appendChild(layer); // keep it above the (re-rendered) nodes
  return layer;
}

function line(cls, d, srcId) {
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('class', cls); p.setAttribute('d', d);
  p.setAttribute('marker-end', 'url(#flow-arrow)');
  if (srcId) p.dataset.src = srcId;
  return p;
}

export function drawFlow() {
  if (state.tool !== 'connect') { if (layer) layer.style.display = 'none'; return; }
  const el = ensureLayer();
  el.style.display = '';
  el.querySelectorAll('.flow-line, .flow-dot, .flow-temp').forEach(n => n.remove());
  state.nodes.forEach(n => {
    if (!n.action || n.action.type !== 'navigate' || !n.action.targetFrameId) return;
    const tgt = getNode(n.action.targetFrameId);
    if (!tgt) return;
    const sr = nodeRect(n.id), tr = nodeRect(tgt.id);
    if (!sr || !tr) return;
    const a = edgePoint(sr, centerOf(tr).x, centerOf(tr).y);
    const b = edgePoint(tr, centerOf(sr).x, centerOf(sr).y);
    el.appendChild(line('flow-line' + (selectedSrc === n.id ? ' selected' : ''), pathD(a.x, a.y, b.x, b.y), n.id));
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('class', 'flow-dot'); dot.setAttribute('r', 4);
    dot.setAttribute('cx', a.x + OFF); dot.setAttribute('cy', a.y + OFF);
    dot.dataset.src = n.id;
    el.appendChild(dot);
  });
  if (dragFrom != null && tempPath) el.appendChild(tempPath);
  positionPopover();
}

// ── the topmost frame under a screen point (a navigation target) ──
function frameUnder(cx, cy) {
  for (const el of document.elementsFromPoint(cx, cy)) {
    const nEl = el.closest && el.closest('.node.frame');
    if (nEl) {
      const n = getNode(nEl.dataset.id);
      // A page frame (root, or directly inside a Section) is a navigation target.
      if (n && (!n.parentId || getNode(n.parentId)?.type === 'section')) return n;
    }
  }
  return null;
}

function onDown(e) {
  if (state.tool !== 'connect' || e.button !== 0) return;
  const wire = e.target.closest && e.target.closest('.flow-line, .flow-dot');
  if (wire) { e.stopPropagation(); e.preventDefault(); selectConn(wire.dataset.src); return; }
  const nodeEl = e.target.closest && e.target.closest('.node');
  const n = nodeEl && getNode(nodeEl.dataset.id);
  if (n && n.type !== 'frame' && n.type !== 'section') {
    e.stopPropagation(); e.preventDefault();
    dragFrom = n.id;
    dragStart = centerOf(nodeRect(n.id));
    downClient = { x: e.clientX, y: e.clientY };
    moved = false;
    tempPath = line('flow-temp', pathD(dragStart.x, dragStart.y, dragStart.x, dragStart.y));
    deselectConn();
    ensureLayer().appendChild(tempPath);
    return;
  }
  e.stopPropagation();
  deselectConn();
}

function onMove(e) {
  if (dragFrom == null) return;
  if (!moved && Math.hypot(e.clientX - downClient.x, e.clientY - downClient.y) > DRAG_THRESHOLD) moved = true;
  if (!moved) return; // still a potential click — don't draw a wire yet
  const p = localOf(e.clientX, e.clientY);
  tempPath.setAttribute('d', pathD(dragStart.x, dragStart.y, p.x, p.y));
  document.querySelectorAll('.node.flow-target').forEach(el => el.classList.remove('flow-target'));
  const fr = frameUnder(e.clientX, e.clientY);
  if (fr && fr.id !== dragFrom) document.getElementById('node-' + fr.id)?.classList.add('flow-target');
}

function onUp(e) {
  if (dragFrom == null) return;
  const src = getNode(dragFrom);
  const wasDrag = moved;
  document.querySelectorAll('.node.flow-target').forEach(el => el.classList.remove('flow-target'));
  tempPath?.remove(); tempPath = null;
  const from = dragFrom; dragFrom = null; moved = false; downClient = null;

  // A plain click never changes a link — it just selects an existing one (or clears).
  if (!wasDrag) {
    if (src && src.action && src.action.type === 'navigate' && src.action.targetFrameId) selectConn(src.id);
    else deselectConn();
    return;
  }

  if (state.readonly) return; // viewers can view the prototype flow, not edit links
  const fr = frameUnder(e.clientX, e.clientY);
  if (src && fr && fr.id !== from) {
    src.action = src.action || {};
    src.action.type = 'navigate';
    src.action.targetFrameId = fr.id;
    src.action.mode = src.action.mode || 'push';
    src.action.transition = src.action.transition || 'platform';
    saveHistory();
    selectedSrc = src.id;
    render();            // refresh node badge; also redraws arrows via flow:render
    selectConn(src.id);  // open the editor popover on the new link
  } else {
    drawFlow();          // dragged, but not onto a valid frame → cancel
  }
}

// ── connection selection + editor popover ──
function selectConn(id) {
  const n = getNode(id);
  if (!n || !n.action || n.action.type !== 'navigate') { deselectConn(); return; }
  selectedSrc = id;
  const tgt = getNode(n.action.targetFrameId);
  popTarget.textContent = '→ ' + (tgt ? tgt.name : 'screen');
  popMode.innerHTML = ddTrigger({ value: n.action.mode || 'push', options: NAV_MODES, data: { fp: 'mode' }, triggerClass: 'dd-block' });
  popTrans.innerHTML = ddTrigger({ value: n.action.transition || 'platform', options: TRANSITIONS, data: { fp: 'trans' }, triggerClass: 'dd-block' });
  pop.hidden = false;
  drawFlow();
}
function deselectConn() { selectedSrc = null; if (pop) pop.hidden = true; drawFlow(); }

function positionPopover() {
  if (!pop || pop.hidden || selectedSrc == null) return;
  const n = getNode(selectedSrc);
  const srEl = n && document.getElementById('node-' + selectedSrc);
  const tgEl = n && n.action && document.getElementById('node-' + n.action.targetFrameId);
  if (!srEl || !tgEl) { pop.hidden = true; return; }
  const a = srEl.getBoundingClientRect(), b = tgEl.getBoundingClientRect();
  pop.style.left = ((a.left + a.width / 2 + b.left + b.width / 2) / 2) + 'px';
  pop.style.top = ((a.top + a.height / 2 + b.top + b.height / 2) / 2) + 'px';
}

export function initFlow() {
  if (!canvas) return;
  pop = document.getElementById('flow-popover');
  popTarget = document.getElementById('flow-pop-target');
  popMode = document.getElementById('flow-pop-mode');
  popTrans = document.getElementById('flow-pop-trans');
  popDel = document.getElementById('flow-pop-del');

  canvasWrap.addEventListener('mousedown', onDown, true); // capture so node/wrap handlers don't also fire
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  pop?.addEventListener('dd:change', e => {
    if (state.readonly) return;
    const n = getNode(selectedSrc); if (!n || !n.action) return;
    const lbl = e.target.closest('.dd-trigger')?.querySelector('.dd-label');
    if (e.target.dataset.fp === 'mode') { n.action.mode = e.detail.value; if (lbl) lbl.textContent = MODE_LABEL[e.detail.value]; saveHistory(); }
    if (e.target.dataset.fp === 'trans') { n.action.transition = e.detail.value; if (lbl) lbl.textContent = TRANS_LABEL[e.detail.value]; saveHistory(); }
    renderProps(); // keep the panel's read-only interaction summary in sync
  });
  popDel?.addEventListener('click', () => {
    if (state.readonly) return;
    const n = getNode(selectedSrc); if (!n) return;
    n.action = { type: 'none', targetFrameId: null, mode: 'push', transition: 'platform' };
    saveHistory(); selectedSrc = null; pop.hidden = true; render();
  });

  // Delete/Escape act on the selected connection (capture, to beat the global tool shortcuts).
  document.addEventListener('keydown', e => {
    if (state.tool !== 'connect' || selectedSrc == null) return;
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); popDel.click(); }
    else if (e.key === 'Escape') { e.stopPropagation(); deselectConn(); }
  }, true);

  document.addEventListener('flow:render', drawFlow);
  document.addEventListener('tool:change', e => { if (e.detail !== 'connect') deselectConn(); drawFlow(); });

  // Keep the popover glued to the link's midpoint through pan/zoom.
  (function tick() { positionPopover(); requestAnimationFrame(tick); })();
}
