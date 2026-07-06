import { state, getNode, makeNode } from './state.js';
import { canvasWrap, showToast } from './utils.js';
import { render, updateNodeEl, zoomAt, fitView } from './render.js';
import { renderProps } from './props.js';
import { undo, redo, saveHistory } from './history.js';
import { deleteSelected, duplicateSelected, copySelected, pasteClipboard } from './operations.js';
import { extractFigmaHtml } from './figkiwi.js';
import { importFigma } from './figpaste.js';
import { finalizeImages } from './images.js';

// Tool to restore after a temporary space-bar pan (null = not space-panning)
let spacePanPrev = null;

export function setTool(tool) {
  const prev = state.tool;
  state.tool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool)
  );
  document.body.classList.toggle('connect-mode', tool === 'connect');
  document.body.classList.toggle('comment-mode', tool === 'comment');
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
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); state.nodes.forEach(n => state.selected.add(n.id)); render(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
    if (e.key === 'Escape') { state.selected.clear(); setTool('select'); render(); return; }
    if (e.key === 'v' || e.key === 'V') setTool('select');
    if (e.key === 'h' || e.key === 'H') setTool('hand');
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); document.getElementById('tool-frame').click(); }
    if (e.key === 'r' || e.key === 'R') setTool('container');
    if (e.key === 's' || e.key === 'S') setTool('section');
    if (e.key === 't' || e.key === 'T') setTool('text');
    if (e.key === 'c' || e.key === 'C') setTool('comment');
    if (e.key === '0') fitView();
    if (e.key === '+' || e.key === '=') zoomAt(1.25);
    if (e.key === '-') zoomAt(0.8);

    // Arrow nudge
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      const d = e.shiftKey ? 10 : 1;
      state.selected.forEach(id => {
        const n = getNode(id);
        if (!n || n.locked) return;
        if (e.key === 'ArrowUp') n.y -= d;
        if (e.key === 'ArrowDown') n.y += d;
        if (e.key === 'ArrowLeft') n.x -= d;
        if (e.key === 'ArrowRight') n.x += d;
        updateNodeEl(n);
      });
      renderProps();
    }
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
      const src = await new Promise(res => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result);
        rd.readAsDataURL(file);
      });
      const dim = await new Promise(res => {
        const im = new Image();
        im.onload = () => res({ w: im.naturalWidth || 200, h: im.naturalHeight || 200 });
        im.onerror = () => res({ w: 200, h: 200 });
        im.src = src;
      });
      const scale = Math.min(1, 480 / Math.max(dim.w, dim.h)); // keep huge shots manageable
      const at = pasteWorldPoint();
      const node = makeNode('image', at.x, at.y, Math.round(dim.w * scale), Math.round(dim.h * scale));
      node.src = src;
      state.nodes.push(node);
      finishPaste([node.id]);
      showToast('Pasted image');
      return true;
    }
  }

  // 3) SVG markup (Figma "Copy as SVG") → an icon node rendered inline.
  const text = cb.getData('text/plain') || '';
  if (/^\s*<svg[\s>]/i.test(text)) {
    const vb = /viewBox\s*=\s*"[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(text);
    const wAttr = /\bwidth\s*=\s*"([\d.]+)/.exec(text);
    const hAttr = /\bheight\s*=\s*"([\d.]+)/.exec(text);
    const w = Math.round(+((wAttr && wAttr[1]) || (vb && vb[1]) || 100)) || 100;
    const h = Math.round(+((hAttr && hAttr[1]) || (vb && vb[2]) || 100)) || 100;
    const at = pasteWorldPoint();
    const node = makeNode('icon', at.x, at.y, Math.min(w, 512), Math.min(h, 512));
    node.svg = text.trim();
    node.colorId = null; // pasted SVGs carry their own colours — don't tint
    state.nodes.push(node);
    finishPaste([node.id]);
    showToast('Pasted SVG');
    return true;
  }

  return false; // not an external paste → internal element clipboard
}
