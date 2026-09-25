import { state, getNode, getComponent, getMasterNode, isMaster, isInstance, nextNodeId } from './state.js';
import { showToast } from './utils.js';
import { saveHistory } from './history.js';
import { render } from './render.js';
import { canAcceptChild, getWorldPos, canBeComponent } from './nodes.js';

// ───────── Components ─────────
// The component a node stamps as an instance when duplicated/pasted: a master (or an
// existing instance) → its component; anything else → null (deep-copied as usual).
function componentRefOf(node) {
  if (isInstance(node) || isMaster(node)) return node.componentId;
  return null;
}

// A fresh instance node of a component at (x,y) under `parentId`, fixed to the
// master's size (v1: instances aren't resized). Instances are leaves — they carry
// no children; render.js live-mirrors the master's subtree inside them.
function makeInstance(componentId, x, y, parentId) {
  const master = getMasterNode(componentId);
  const node = {
    id: nextNodeId(),
    type: 'instance',
    componentId,
    x, y,
    w: master ? master.w : 100,
    h: master ? master.h : 100,
    parentId: parentId || null,
    visible: true,
    locked: false,
    name: (getComponent(componentId) || {}).name || 'Instance',
    opacity: 1,
    rotation: 0, flipH: false, flipV: false,
    wMode: 'fixed', hMode: 'fixed',
    action: { type: 'none', targetFrameId: null, mode: 'push', transition: 'platform' },
  };
  state.nodes.push(node);
  if (parentId) { const p = getNode(parentId); if (p && p.children) p.children.push(node.id); }
  return node;
}

// Promote the single selected node into a reusable component (its subtree becomes
// the master). Copying/duplicating it then stamps live instances.
export function createComponent() {
  if (state.readonly) return;
  if (state.selected.size !== 1) { showToast('Select one element to make a component'); return; }
  const node = getNode([...state.selected][0]);
  if (!node) return;
  if (isInstance(node)) { showToast('That’s already an instance of a component'); return; }
  if (isMaster(node)) { showToast('This is already a component'); return; }
  if (!canBeComponent(node)) { showToast('Frames and sections can’t be components'); return; }
  const id = 'cmp' + (state.nextComponentId++);
  node.componentId = id;
  state.components.push({ id, name: node.name || 'Component', rootId: node.id });
  saveHistory();
  render();
  showToast('Component created — copy it to place instances');
}

// ───────── Copy / paste ─────────
let clipboard = null;   // array of serialized node subtrees (or component refs)
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
    const n = getNode(id);
    const ref = componentRefOf(n);
    if (ref) { const wp = getWorldPos(n); return { _componentId: ref, x: n.x, y: n.y, parentId: n.parentId, _world: { x: wp.x, y: wp.y } }; }
    const t = serializeSubtree(id);
    if (t) { const wp = getWorldPos(n); t._world = { x: wp.x, y: wp.y }; }
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
  delete node.componentId; // a deep copy is a plain node, never a component master
  node.id = nextNodeId();
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
  if (!node || state.readonly) return null;
  const ref = componentRefOf(node);
  if (ref) return makeInstance(ref, node.x, node.y, node.parentId); // stamp an instance
  const tree = serializeSubtree(node.id);
  const id = instantiate(tree, node.parentId, node.x, node.y);
  return getNode(id);
}

export function pasteClipboard() {
  if (state.readonly || !clipboard || !clipboard.length) return;
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
    if (tree._componentId) { newSel.add(makeInstance(tree._componentId, x, y, parentId).id); return; }
    newSel.add(instantiate(tree, parentId, x, y));
  });
  state.selected = newSel;
  saveHistory();
  render();
}

export function deleteSelected() {
  if (state.readonly) return;
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
  // Drop component definitions whose master was deleted (their instances orphan,
  // rendering as a "missing" placeholder until re-pointed or removed).
  state.components = state.components.filter(c => !toDelete.has(c.rootId));
  state.selected.clear();
  saveHistory();
  render();
}

export function duplicateSelected() {
  if (state.readonly) return;
  const newSel = new Set();
  state.selected.forEach(id => {
    const n = getNode(id);
    if (!n) return;
    const ref = componentRefOf(n);
    if (ref) { newSel.add(makeInstance(ref, n.x + 20, n.y + 20, n.parentId).id); return; }
    const clone = JSON.parse(JSON.stringify(n));
    clone.id = nextNodeId();
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
