import { state, getNode } from './state.js';
import { showToast } from './utils.js';
import { saveHistory } from './history.js';
import { render } from './render.js';
import { canAcceptChild, getWorldPos } from './nodes.js';

// ───────── Copy / paste ─────────
let clipboard = null;   // array of serialized node subtrees
let pasteCount = 0;     // grows per paste so repeats don't stack exactly

// Serialize a node and its whole subtree into a detached tree (children embedded).
function serializeSubtree(id) {
  const n = getNode(id);
  if (!n) return null;
  const t = JSON.parse(JSON.stringify(n));
  t._children = (n.children || []).map(serializeSubtree).filter(Boolean);
  return t;
}

export function copySelected() {
  if (state.selected.size === 0) return;
  clipboard = [...state.selected].map(id => {
    const t = serializeSubtree(id);
    if (t) { const wp = getWorldPos(getNode(id)); t._world = { x: wp.x, y: wp.y }; }
    return t;
  }).filter(Boolean);
  pasteCount = 0;
  // Overwrite the system clipboard too, so a stale external copy (e.g. from
  // Figma) doesn't shadow this internal one on the next Ctrl+V.
  navigator.clipboard?.writeText('frameforge:elements').catch(() => {});
  showToast(clipboard.length + (clipboard.length === 1 ? ' element copied' : ' elements copied'));
}

// Recreate a serialized subtree as real nodes with fresh ids under `parentId`.
function instantiate(tree, parentId, x, y) {
  const childTrees = tree._children || [];
  const node = JSON.parse(JSON.stringify(tree));
  delete node._children;
  delete node._world;
  node.id = 'n' + (state.nextId++);
  node.parentId = parentId || null;
  node.x = x;
  node.y = y;
  // Fresh children array (clearing any stale ids copied from the source); an
  // image is a leaf, so it carries none.
  if (node.type === 'image') delete node.children;
  else node.children = [];
  state.nodes.push(node);
  if (parentId) {
    const p = getNode(parentId);
    if (p && !p.children.includes(node.id)) p.children.push(node.id);
  }
  // Children keep their own relative positions
  childTrees.forEach(ct => instantiate(ct, node.id, ct.x, ct.y));
  return node.id;
}

// Deep-clone a node (and its subtree) at the same position/parent; returns the
// new root node. Used for Alt-drag duplication.
export function cloneNodeInPlace(node) {
  if (!node) return null;
  const tree = serializeSubtree(node.id);
  const id = instantiate(tree, node.parentId, node.x, node.y);
  return getNode(id);
}

export function pasteClipboard() {
  if (!clipboard || !clipboard.length) return;
  pasteCount++;
  const off = 20 * pasteCount;
  const newSel = new Set();
  clipboard.forEach(tree => {
    let parentId = tree.parentId || null;
    const parent = parentId ? getNode(parentId) : null;
    let x, y;
    if (parent && canAcceptChild(parent)) {
      x = tree.x + off; y = tree.y + off;           // same parent, local offset
    } else {
      parentId = null;                              // can't nest → drop on the canvas
      const w = tree._world || { x: tree.x, y: tree.y };
      x = w.x + off; y = w.y + off;
    }
    newSel.add(instantiate(tree, parentId, x, y));
  });
  state.selected = newSel;
  saveHistory();
  render();
}

export function deleteSelected() {
  const toDelete = new Set();
  function collectDescendants(id) {
    toDelete.add(id);
    const n = getNode(id);
    if (n && n.children) n.children.forEach(collectDescendants);
  }
  state.selected.forEach(collectDescendants);

  toDelete.forEach(id => {
    const n = getNode(id);
    if (n && n.parentId) {
      const parent = getNode(n.parentId);
      if (parent) parent.children = parent.children.filter(c => c !== id);
    }
  });

  state.nodes = state.nodes.filter(n => !toDelete.has(n.id));
  state.selected.clear();
  saveHistory();
  render();
}

export function duplicateSelected() {
  const newSel = new Set();
  state.selected.forEach(id => {
    const n = getNode(id);
    if (!n) return;
    const clone = JSON.parse(JSON.stringify(n));
    clone.id = 'n' + (state.nextId++);
    clone.x += 20; clone.y += 20;
    clone.name += ' copy';
    clone.children = [];
    state.nodes.push(clone);
    if (clone.parentId) {
      const parent = getNode(clone.parentId);
      if (parent) parent.children.push(clone.id);
    }
    newSel.add(clone.id);
  });
  state.selected = newSel;
  saveHistory();
  render();
}

export function bringToFront() {
  state.selected.forEach(id => {
    const i = state.nodes.findIndex(n => n.id === id);
    if (i !== -1) { const [n] = state.nodes.splice(i, 1); state.nodes.push(n); }
  });
  render();
}

export function sendToBack() {
  state.selected.forEach(id => {
    const i = state.nodes.findIndex(n => n.id === id);
    if (i !== -1) { const [n] = state.nodes.splice(i, 1); state.nodes.unshift(n); }
  });
  render();
}
