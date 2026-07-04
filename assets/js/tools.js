import { state, getNode } from './state.js';
import { canvasWrap } from './utils.js';
import { render, updateNodeEl, zoomAt, fitView } from './render.js';
import { renderProps } from './props.js';
import { undo, redo } from './history.js';
import { deleteSelected, duplicateSelected, copySelected, pasteClipboard } from './operations.js';

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
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') { e.preventDefault(); pasteClipboard(); return; }
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
}
