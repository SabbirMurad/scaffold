import { state, getNode, makeNode } from './state.js';
import { isFlex, flexKind } from './nodes.js';
import { canvasWrap, showToast } from './utils.js';
import { render, updateNodeEl, zoomAt, fitView } from './render.js';
import { renderProps } from './props.js';
import { undo, redo, saveHistory } from './history.js';
import { deleteSelected, duplicateSelected, copySelected, pasteClipboard } from './operations.js';
import { extractFigmaHtml } from './figkiwi.js';
import { importFigma } from './figpaste.js';
import { finalizeImages } from './images.js';
import { canvasToWorld, isSingleChild } from './nodes.js';
import { drawTargetAt, worldOrigin, showDrop } from './canvas.js';

// Tool to restore after a temporary space-bar pan (null = not space-panning)
let spacePanPrev = null;

// Tools a viewer (read-only) may use — inspect, pan, prototype, comment. The
// creation tools (frame/section/container/text/image/icon) are off-limits.
const VIEWER_TOOLS = ['select', 'hand', 'connect', 'comment'];

export function setTool(tool) {
  if (state.readonly && !VIEWER_TOOLS.includes(tool)) return;
  const prev = state.tool;
  state.tool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool)
  );
  document.body.classList.toggle('connect-mode', tool === 'connect');
  document.body.classList.toggle('comment-mode', tool === 'comment');
  document.body.classList.toggle('hand-mode', tool === 'hand');
  canvasWrap.style.cursor = tool === 'hand' ? 'grab' : (tool === 'select' ? 'default' : 'crosshair');
  document.dispatchEvent(new CustomEvent('tool:change', { detail: tool }));
  // Connect/Comment modes change how (or whether) the selection renders, so
  // re-render whenever we enter or leave one of them.
  const overlay = t => t === 'connect' || t === 'comment';
  if (overlay(prev) || overlay(tool)) render();
}

export function initToolEvents() {
  // Tool buttons
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement.isContentEditable) return;
    // Text selected on the page (a Claude reply, a comment): copy and select-all
    // work on the text, as anywhere else, instead of on canvas elements.
    const sel = window.getSelection();
    const textSelected = sel && !sel.isCollapsed && sel.toString().trim() !== '';
    if (textSelected && (e.metaKey || e.ctrlKey) && ['c', 'a'].includes(e.key.toLowerCase())) return;

    // Undo/redo apply in every tab (Design, Model, API, Color). Normalise the
    // key case: with Shift held the browser reports 'Z' (uppercase), so a raw
    // e.key === 'z' test would miss the Ctrl+Shift+Z redo shortcut.
    const undoKey = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && undoKey === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.metaKey || e.ctrlKey) && (undoKey === 'y' || (undoKey === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }

    // Remaining shortcuts (tools, delete, group, zoom…) only apply in the Design tab
    if (!document.body.classList.contains('design-mode')) return;

    // Hold space → temporary hand/pan tool
    if (e.code === 'Space') {
      e.preventDefault();
      if (spacePanPrev === null && state.tool !== 'hand') {
        spacePanPrev = state.tool;
        setTool('hand');
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') { e.preventDefault(); copySelected(); return; }
    // Ctrl+V is handled by the 'paste' event below (a keydown can't read the
    // system clipboard, and we want Figma/image/SVG pastes to just work).
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); selectAllAtLevel(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
    // Esc / Shift+Enter: up to the parent. Enter: down to the children. (Figma)
    if (e.key === 'Escape' || (e.key === 'Enter' && e.shiftKey)) {
      if (state.tool !== 'select') { setTool('select'); return; }
      selectParent(); return;
    }
    if (e.key === 'Enter' && tag !== 'BUTTON') { e.preventDefault(); selectChildren(); return; }
    if (e.key === 'v' || e.key === 'V') setTool('select');
    if (e.key === 'h' || e.key === 'H') setTool('hand');
    if ((e.key === 'f' || e.key === 'F') && !state.readonly) { e.preventDefault(); document.getElementById('tool-frame').click(); }
    if (e.key === 'r' || e.key === 'R') setTool('container');
    if (e.key === 's' || e.key === 'S') setTool('section');
    if (e.key === 't' || e.key === 'T') setTool('text');
    if (e.key === 'c' || e.key === 'C') setTool('comment');
    if (e.key === '0') fitView();
    if (e.key === '+' || e.key === '=') zoomAt(1.25);
    if (e.key === '-') zoomAt(0.8);

    // Arrows: nudge free items; in a row / column, move the item one place
    // along it. Saved as one undo step when the key is let go.
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      if (state.readonly) return; // viewers can't move nodes
      e.preventDefault();
      if (arrowKey(e)) nudged = true;
    }
  });

  document.addEventListener('keyup', e => {
    if (nudged && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { nudged = false; saveHistory(); }
  });

  // Release space → restore the tool that was active before space-panning
  document.addEventListener('keyup', e => {
    if (e.code === 'Space' && spacePanPrev !== null) {
      setTool(spacePanPrev);
      spacePanPrev = null;
    }
  });

  // Safety: if focus is lost while space is held, restore the tool
  window.addEventListener('blur', () => {
    if (spacePanPrev !== null) {
      setTool(spacePanPrev);
      spacePanPrev = null;
    }
  });

  // ── System paste (Ctrl+V) ──
  // One handler for every clipboard flavour: a Figma copy (its HTML carries the
  // full binary design — decoded by figkiwi/figpaste), a raw image, an SVG, and
  // finally the internal element clipboard as the fallback.
  document.addEventListener('paste', e => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement.isContentEditable) return;
    if (!document.body.classList.contains('design-mode')) return;
    e.preventDefault();
    handleSystemPaste(e.clipboardData).then(handled => { if (!handled) pasteClipboard(); });
  });
}

let nudged = false; // arrows moved something since the last save

// Returns whether anything moved.
function arrowKey(e) {
  const d = e.shiftKey ? 10 : 1;
  const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
  const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  let moved = false, reordered = false;
  state.selected.forEach(id => {
    const n = getNode(id);
    if (!n || n.locked) return;
    const parent = n.parentId ? getNode(n.parentId) : null;
    if (parent && isFlex(parent)) {
      // Only the arrows along the layout's direction reorder (both, in a wrap).
      const kind = flexKind(parent);
      if ((kind === 'column' && !vertical) || (kind === 'row' && vertical)) return;
      const kids = parent.children, i = kids.indexOf(n.id), j = back ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= kids.length) return;
      [kids[i], kids[j]] = [kids[j], kids[i]];
      moved = reordered = true;
      return;
    }
    if (e.key === 'ArrowUp') n.y -= d;
    if (e.key === 'ArrowDown') n.y += d;
    if (e.key === 'ArrowLeft') n.x -= d;
    if (e.key === 'ArrowRight') n.x += d;
    updateNodeEl(n);
    moved = true;
  });
  if (reordered) render(); else renderProps();
  return moved;
}

// Ctrl+A: everything at the selection's level (its siblings), or every
// top-level item when nothing is selected.
function selectAllAtLevel() {
  const first = getNode([...state.selected][0]);
  const parentId = first ? first.parentId : null;
  const pool = parentId ? (getNode(parentId).children || []).map(getNode) : state.nodes.filter(n => !n.parentId);
  state.selected = new Set(pool.filter(n => n && n.visible !== false && !n.locked).map(n => n.id));
  render();
}

function selectParent() {
  const parents = new Set([...state.selected].map(id => getNode(id)).filter(n => n && n.parentId).map(n => n.parentId));
  // Up from a screen's top level lands on the screen; up from a screen clears.
  state.selected = parents.size ? new Set([...parents].filter(id => getNode(id).type !== 'section')) : new Set();
  render();
}

function selectChildren() {
  const kids = [...state.selected].flatMap(id => (getNode(id) || {}).children || []).map(getNode)
    .filter(n => n && n.visible !== false && !n.locked);
  if (!kids.length) return;
  state.selected = new Set(kids.map(n => n.id));
  render();
}

// The world-space point pastes land at: the centre of the current viewport.
function pasteWorldPoint() {
  return {
    x: (canvasWrap.clientWidth / 2 - state.panX) / state.zoom,
    y: (canvasWrap.clientHeight / 2 - state.panY) / state.zoom,
  };
}

// Select the freshly pasted roots and commit the whole paste as one undo step.
function finishPaste(ids) {
  state.selected = new Set(ids);
  saveHistory();
  render();
  renderProps();
  // A pasted image (raw clipboard, or nested inside a Figma paste) arrives as an
  // inline data URI — upload it to the backend and swap in a ref.
  finalizeImages();
}

async function handleSystemPaste(cb) {
  if (!cb) return false;

  // 1) Figma: the pasted HTML embeds the copied selection in binary form.
  const figBytes = extractFigmaHtml(cb.getData('text/html'));
  if (figBytes) {
    try {
      const at = pasteWorldPoint();
      const r = await importFigma(figBytes, at.x, at.y);
      finishPaste(r.rootIds);
      const extras = [];
      if (r.newColors) extras.push(`${r.newColors} color${r.newColors > 1 ? 's' : ''}`);
      if (r.newTypos) extras.push(`${r.newTypos} text style${r.newTypos > 1 ? 's' : ''}`);
      if (r.icons) extras.push(`${r.icons} icon${r.icons > 1 ? 's' : ''}`);
      if (r.vectors) extras.push(`${r.vectors} vector${r.vectors > 1 ? 's' : ''} as boxes`);
      showToast(`Pasted ${r.count} layer${r.count > 1 ? 's' : ''} from Figma${extras.length ? ' — ' + extras.join(', ') : ''}`);
    } catch (err) {
      console.error('Figma paste failed:', err);
      showToast('Couldn’t import the Figma clipboard — try Copy as SVG/PNG');
    }
    return true;
  }

  // 2) A raw image (screenshot, Figma "Copy as PNG", …) → an image node.
  const imgItem = [...(cb.items || [])].find(it => it.type && it.type.startsWith('image/'));
  if (imgItem) {
    const file = imgItem.getAsFile();
    if (file) {
      const at = pasteWorldPoint();
      const part = await imagePart(file);
      const node = makeNode('image', at.x, at.y, part.w, part.h);
      node.src = part.src;
      state.nodes.push(node);
      finishPaste([node.id]);
      showToast('Pasted image');
      return true;
    }
  }

  // 3) SVG markup (Figma "Copy as SVG") → an icon node rendered inline.
  const text = cb.getData('text/plain') || '';
  if (isSvg(text)) {
    const at = pasteWorldPoint();
    const part = svgPart(text);
    const node = makeNode('icon', at.x, at.y, part.w, part.h);
    node.svg = part.svg;
    node.colorId = null; // pasted SVGs carry their own colours — don't tint
    state.nodes.push(node);
    finishPaste([node.id]);
    showToast('Pasted SVG');
    return true;
  }

  return false; // not an external paste → internal element clipboard
}

// ── Images / SVGs: shared by paste and drop ──
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']; // what the image store accepts
const isSvg = (text) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text || '');

const readFile = (file, as) => new Promise((res, rej) => {
  const rd = new FileReader();
  rd.onload = () => res(rd.result);
  rd.onerror = () => rej(rd.error);
  if (as === 'text') rd.readAsText(file); else rd.readAsDataURL(file);
});

// An image file → its data URI and a manageable size (huge shots are scaled down).
async function imagePart(file) {
  const src = await readFile(file, 'url');
  const dim = await new Promise(res => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth || 200, h: im.naturalHeight || 200 });
    im.onerror = () => res({ w: 200, h: 200 });
    im.src = src;
  });
  const scale = Math.min(1, 480 / Math.max(dim.w, dim.h));
  return { src, w: Math.round(dim.w * scale), h: Math.round(dim.h * scale) };
}

// SVG markup → the markup (declarations and comments before <svg> dropped) and its size.
function svgPart(text) {
  const svg = text.slice(text.search(/<svg[\s>]/i)).trim();
  const vb = /viewBox\s*=\s*["'][\d.\s,-]*?([\d.]+)[\s,]+([\d.]+)["']/.exec(svg);
  const wAttr = /\bwidth\s*=\s*["']([\d.]+)/.exec(svg);
  const hAttr = /\bheight\s*=\s*["']([\d.]+)/.exec(svg);
  const w = Math.round(+((wAttr && wAttr[1]) || (vb && vb[1]) || 100)) || 100;
  const h = Math.round(+((hAttr && hAttr[1]) || (vb && vb[2]) || 100)) || 100;
  const k = Math.min(1, 512 / Math.max(w, h));
  return { svg, w: Math.round(w * k), h: Math.round(h * k) };
}

// ── Drag & drop from the computer ──
// PNG / JPG / GIF / WebP files become image layers, SVG files icon layers (keeping
// their own colours), placed where they're dropped: inside the screen or container
// under the pointer (at the pointer; in a row / column, at the spot the line
// shows), or on the canvas.
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const canDropHere = () => document.body.classList.contains('design-mode') && !state.readonly;

export function initFileDrop() {
  // Anywhere else in the window a dropped file would make the page open it and
  // leave the editor — so files are only ever taken by the canvas.
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (hasFiles(e)) e.preventDefault(); });

  canvasWrap.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!canDropHere()) { e.dataTransfer.dropEffect = 'none'; return; }
    e.dataTransfer.dropEffect = 'copy';
    showDrop(drawTargetAt(e.clientX, e.clientY, 'image'));
  });
  canvasWrap.addEventListener('dragleave', e => {
    if (!canvasWrap.contains(e.relatedTarget)) showDrop(null);
  });
  canvasWrap.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    showDrop(null);
    if (canDropHere()) dropFiles([...e.dataTransfer.files], e.clientX, e.clientY);
  });
}

async function dropFiles(files, clientX, clientY) {
  const ids = [];
  let skipped = 0;
  for (const file of files) {
    const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    if (!svg && !IMAGE_TYPES.includes(file.type)) { skipped++; continue; }
    let node;
    try {
      if (svg) {
        const text = await readFile(file, 'text');
        if (!isSvg(text)) { skipped++; continue; }
        const part = svgPart(text);
        node = makeNode('icon', 0, 0, part.w, part.h);
        node.svg = part.svg;
        node.colorId = null; // an SVG file keeps its own colours
      } else {
        const part = await imagePart(file);
        node = makeNode('image', 0, 0, part.w, part.h);
        node.src = part.src;
      }
    } catch { skipped++; continue; }
    node.name = file.name.replace(/\.[^.]+$/, '') || node.name;
    placeDropped(node, clientX, clientY, ids.length);
    ids.push(node.id);
  }
  if (ids.length) {
    finishPaste(ids);
    showToast(`Added ${ids.length} ${ids.length === 1 ? 'file' : 'files'}` + (skipped ? ` — ${skipped} skipped (PNG, JPG, GIF, WebP or SVG only)` : ''));
  } else if (skipped) {
    showToast('Only PNG, JPG, GIF, WebP and SVG files can be added');
  }
}

// Put a new node where it was dropped. Several files fan out a little.
function placeDropped(node, clientX, clientY, i) {
  const target = drawTargetAt(clientX, clientY, node.type);
  const parent = target.parent;
  const wr = canvasWrap.getBoundingClientRect();
  const at = canvasToWorld(clientX - wr.left, clientY - wr.top);
  if (parent) {
    // No wider than the container it lands in.
    const pel = document.getElementById('node-' + parent.id);
    const cs = pel && getComputedStyle(pel);
    const room = pel ? pel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : 0;
    if (room && node.w > room) { node.h = Math.round(node.h * room / node.w); node.w = room; }
  }
  let x = at.x - node.w / 2 + i * 20, y = at.y - node.h / 2 + i * 20;
  if (parent) {
    if (isSingleChild(parent)) { x = 0; y = 0; }
    else { const o = worldOrigin(parent); x -= o.x; y -= o.y; }
    node.parentId = parent.id;
    if (target.index != null) parent.children.splice(target.index + i, 0, node.id);
    else parent.children.push(node.id);
  }
  node.x = Math.round(x); node.y = Math.round(y);
  state.nodes.push(node);
}
