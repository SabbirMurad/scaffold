import { state, getNode } from './state.js';
import { layersList, showToast } from './utils.js';
import { isDescendant, reparentNode, canAcceptChild } from './nodes.js';
import { saveHistory } from './history.js';
import { render } from './render.js';

let layerFlatList = [];
// Transient UI state — which tree nodes are collapsed in the layers panel.
// Kept out of the node model so it isn't saved to history or exported.
const collapsed = new Set();

// Inline row controls (stroke=currentColor so CSS colours them).
const EYE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9.9 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.8 3.6M6.5 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.2-1M3 3l18 18"/></svg>`;
const LOCK_CLOSED = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>`;
const LOCK_OPEN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.5-1.8"/></svg>`;

export function renderLayers() {
  layersList.innerHTML = '';
  layerFlatList = [];

  function walk(nodeId, depth) {
    const node = getNode(nodeId);
    if (!node) return;
    const el = buildLayerItem(node, depth);
    layersList.appendChild(el);
    layerFlatList.push({ node, depth, el });
    if (node.children && node.children.length && !collapsed.has(node.id)) {
      [...node.children].reverse().forEach(cid => walk(cid, depth + 1));
    }
  }

  const roots = [...state.nodes].filter(n => !n.parentId).reverse();
  roots.forEach(n => walk(n.id, 0));
  initLayerDnd();
}

// The row icon for a layer. Frame/container/image use the SVGs in /icons/layers/
// (masked to the text colour); a section uses the open/closed folder icon; other
// types keep a unicode glyph.
function layerIconHtml(node) {
  let svg = { frame: 'frame', container: 'container', image: 'image' }[node.type];
  if (node.type === 'section') svg = collapsed.has(node.id) ? 'folder-close' : 'folder-open';
  if (svg) {
    const url = `/assets/icons/layers/${svg}.svg`;
    return `<span class="layer-icon layer-icon-svg" style="-webkit-mask-image:url(${url});mask-image:url(${url})"></span>`;
  }
  const glyph = { row: '\u2630', column: '\u2637', wrap: '\u25A6', stack: '\u29C9', icon: '\u2726', text: 'T' }[node.type] || '\u25AD';
  return `<span class="layer-icon">${glyph}</span>`;
}

function buildLayerItem(node, depth) {
  const item = document.createElement('div');
  item.className = 'layer-item' +
    (state.selected.has(node.id) ? ' selected' : '') +
    (!node.visible ? ' hidden' : '') +
    (node.locked ? ' locked' : '');
  item.dataset.id = node.id;
  item.draggable = true;

  const hasChildren = node.children && node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const caret = hasChildren
    ? `<span class="layer-caret${isCollapsed ? ' collapsed' : ''}" title="${isCollapsed ? 'Expand' : 'Collapse'}"><img src="/assets/icons/arrow-down.svg" alt=""></span>`
    : `<span class="layer-caret layer-caret-empty"></span>`;

  item.innerHTML = `
    <span class="layer-grip">\u2807</span>
    <div class="layer-indent" style="padding-left:${depth * 14}px;display:flex;align-items:center;gap:6px;flex:1;overflow:hidden">
      ${caret}
      ${layerIconHtml(node)}
      <span class="layer-name">${node.name}</span>
    </div>
    <span class="layer-ctrl layer-lock ${node.locked ? 'active' : ''}" title="${node.locked ? 'Unlock' : 'Lock'}">${node.locked ? LOCK_CLOSED : LOCK_OPEN}</span>
    <span class="layer-ctrl layer-vis ${node.visible ? '' : 'active'}" title="${node.visible ? 'Hide' : 'Show'}">${node.visible ? EYE : EYE_OFF}</span>
  `;

  item.addEventListener('click', (e) => {
    if (e.target.closest('.layer-caret')) {
      if (hasChildren) {
        if (collapsed.has(node.id)) collapsed.delete(node.id);
        else collapsed.add(node.id);
        renderLayers();
      }
      return;
    }
    if (e.target.closest('.layer-lock')) {
      node.locked = !node.locked;
      if (node.locked) state.selected.delete(node.id); // a locked layer can't stay selected
      saveHistory();
      render();
      return;
    }
    if (e.target.closest('.layer-vis')) {
      node.visible = !node.visible;
      saveHistory();
      render();
      return;
    }
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (state.selected.has(node.id)) state.selected.delete(node.id);
      else state.selected.add(node.id);
    } else {
      state.selected.clear();
      state.selected.add(node.id);
    }
    render();
  });

  return item;
}

// Layer drag-and-drop
let layerDrag = null;
let containerDndInit = false;

function initLayerDnd() {
  layerFlatList.forEach(({ node, el }) => {
    el.addEventListener('dragstart', e => {
      layerDrag = { nodeId: node.id };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.id);
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      clearLayerDndUI();
      layerDrag = null;
    });

    el.addEventListener('dragover', e => {
      e.preventDefault();
      if (!layerDrag || layerDrag.nodeId === node.id) return;
      if (isDescendant(node.id, layerDrag.nodeId)) return;
      clearLayerDndUI();
      const zone = getDndZone(e, el, node);
      el.classList.add(zone === 'into' ? 'drag-into' : zone === 'above' ? 'drag-above' : 'drag-below');
      e.dataTransfer.dropEffect = 'move';
    });

    // Only clear when the cursor actually leaves the item (not when crossing its child spans)
    el.addEventListener('dragleave', e => {
      if (!el.contains(e.relatedTarget)) {
        el.classList.remove('drag-above', 'drag-below', 'drag-into');
      }
    });

    el.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation(); // prevent the list-level "move to root" handler from also firing
      if (!layerDrag || layerDrag.nodeId === node.id) return;
      if (isDescendant(node.id, layerDrag.nodeId)) return;
      const srcNode = getNode(layerDrag.nodeId);
      if (!srcNode) return;
      const zone = getDndZone(e, el, node);
      clearLayerDndUI();
      applyLayerDrop(srcNode, node, zone);
    });
  });

  // Attach the list-level listeners once — layersList persists across renders,
  // so re-adding them every renderLayers() would stack duplicate handlers.
  if (!containerDndInit) {
    containerDndInit = true;
    layersList.addEventListener('dragover', e => { e.preventDefault(); });
    layersList.addEventListener('drop', e => {
      e.preventDefault();
      if (e.target !== layersList) return; // only handle drops on empty list area
      if (!layerDrag) return;
      const srcNode = getNode(layerDrag.nodeId);
      if (!srcNode) return;
      reparentNode(srcNode, null);
      const i = state.nodes.findIndex(n => n.id === srcNode.id);
      if (i !== -1) { state.nodes.splice(i, 1); state.nodes.unshift(srcNode); }
      saveHistory();
      render();
    });
  }
}

function getDndZone(e, el, targetNode) {
  const rect = el.getBoundingClientRect();
  const relY = e.clientY - rect.top;
  const pct = relY / rect.height;
  const draggedId = layerDrag ? layerDrag.nodeId : null;
  if (canAcceptChild(targetNode, draggedId)) {
    if (pct < 0.25) return 'above';
    if (pct > 0.75) return 'below';
    return 'into';
  }
  return pct < 0.5 ? 'above' : 'below';
}

function clearLayerDndUI() {
  layerFlatList.forEach(({ el }) => {
    el.classList.remove('drag-above', 'drag-below', 'drag-into');
  });
}

function applyLayerDrop(srcNode, targetNode, zone) {
  if (zone === 'into' && canAcceptChild(targetNode, srcNode.id)) {
    // reparentNode positions the child per parent type (pinned for frame/container)
    reparentNode(srcNode, targetNode.id);
    targetNode.children = targetNode.children.filter(id => id !== srcNode.id);
    targetNode.children.push(srcNode.id);
  } else {
    const newParentId = targetNode.parentId || null;
    reparentNode(srcNode, newParentId);

    if (newParentId) {
      const parent = getNode(newParentId);
      const children = parent.children.filter(id => id !== srcNode.id);
      const tIdx = children.indexOf(targetNode.id);
      if (zone === 'above') children.splice(tIdx + 1, 0, srcNode.id);
      else children.splice(tIdx, 0, srcNode.id);
      parent.children = children;
    } else {
      const nodesWithoutSrc = state.nodes.filter(n => n.id !== srcNode.id);
      const tIdx = nodesWithoutSrc.findIndex(n => n.id === targetNode.id);
      if (zone === 'above') nodesWithoutSrc.splice(tIdx + 1, 0, srcNode);
      else nodesWithoutSrc.splice(tIdx, 0, srcNode);
      state.nodes = nodesWithoutSrc;
    }
  }

  saveHistory();
  render();
  showToast(zone === 'into' ? `Moved into "${targetNode.name}"` : 'Reordered');
}
