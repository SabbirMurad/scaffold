import { state, getNode, getComponent, getMasterNode, isMaster, isInstance, nextNodeId } from './state.js';
import { showToast, canvasWrap } from './utils.js';
import { saveHistory } from './history.js';
import { render, applyTransform } from './render.js';
import { canAcceptChild, getWorldPos, canBeComponent, isStack, canvasToWorld } from './nodes.js';

// ───────── Components ─────────
// The component a node stamps as an instance when duplicated/pasted: a master (or an
// existing instance) → its component; anything else → null (deep-copied as usual).
function componentRefOf(node) {
  if (isInstance(node) || isMaster(node)) return node.componentId;
  return null;
}

// A fresh instance node of a component at (x,y) under `parentId`. Instances are
// leaves — they carry no children; render.js live-mirrors the master's subtree
// inside them, and gives them the master's size and sizing modes.
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
    wMode: master ? master.wMode : 'fixed', hMode: master ? master.hMode : 'fixed',
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
  showToast('Component created — place copies from Components in the left panel');
}

// ───────── Component management ─────────
// A component's name is its master's name (renaming either renames both).
export function componentName(c) {
  const m = c && getNode(c.rootId);
  return (m && m.name) || (c && c.name) || 'Component';
}
export const instancesOf = (componentId) => state.nodes.filter(n => n.type === 'instance' && n.componentId === componentId);

export function renameComponent(componentId, name) {
  const c = getComponent(componentId);
  const v = String(name || '').trim();
  if (!c || !v) return false;
  c.name = v;
  const m = getNode(c.rootId);
  if (m) m.name = v;
  return true;
}

// Replace an instance with a plain, editable copy of its master's design, in the
// same place (same parent, position and order), keeping what the instance itself
// set: its name, tap action, visibility and opacity. Returns the new node.
export function detachInstance(inst) {
  const master = inst && getMasterNode(inst.componentId);
  if (!master) return null;
  const parent = inst.parentId ? getNode(inst.parentId) : null;
  const index = parent ? parent.children.indexOf(inst.id) : state.nodes.indexOf(inst);
  const id = instantiate(serializeSubtree(master.id), inst.parentId, inst.x, inst.y);
  const copy = getNode(id);
  copy.name = inst.name || copy.name;
  ['action', 'opacity', 'visible', 'locked', 'showIf', 'rotation', 'flipH', 'flipV'].forEach(k => {
    if (inst[k] !== undefined) copy[k] = JSON.parse(JSON.stringify(inst[k]));
  });
  // Take the instance's place, then drop the instance.
  if (parent) {
    parent.children = parent.children.filter(c => c !== id && c !== inst.id);
    parent.children.splice(index, 0, id);
  } else {
    state.nodes.splice(state.nodes.indexOf(copy), 1);
    state.nodes.splice(index, 0, copy);
  }
  state.nodes = state.nodes.filter(n => n.id !== inst.id);
  if (state.selected.delete(inst.id)) state.selected.add(id);
  return copy;
}

// Before a component's master goes, turn its instances (outside `doomed`, the
// nodes being deleted with it) into plain copies, so nothing on the canvas breaks.
export function detachInstancesOf(componentIds, doomed = new Set()) {
  let n = 0;
  componentIds.forEach(cid => instancesOf(cid).forEach(inst => {
    if (!doomed.has(inst.id) && detachInstance(inst)) n++;
  }));
  return n;
}

// Select a node and bring it to the middle of the view (e.g. a component's master).
export function goToNode(id) {
  const n = getNode(id);
  if (!n) return;
  state.selected = new Set([n.id]);
  const wp = getWorldPos(n);
  state.panX = canvasWrap.clientWidth / 2 - (wp.x + n.w / 2) * state.zoom;
  state.panY = canvasWrap.clientHeight / 2 - (wp.y + n.h / 2) * state.zoom;
  applyTransform();
  render();
}

// Place an instance: into the selected container if it can take it, else at the
// centre of the view. One undo step; the new instance is selected.
export function placeInstance(componentId) {
  if (state.readonly || !getMasterNode(componentId)) return null;
  const sel = state.selected.size === 1 ? getNode([...state.selected][0]) : null;
  const parent = sel && canAcceptChild(sel, null, 'container') ? sel : null;
  const master = getMasterNode(componentId);
  let x = 0, y = 0;
  if (!parent) {
    const c = canvasToWorld(canvasWrap.clientWidth / 2, canvasWrap.clientHeight / 2);
    x = Math.round(c.x - master.w / 2); y = Math.round(c.y - master.h / 2);
  }
  const node = makeInstance(componentId, x, y, parent ? parent.id : null);
  state.selected = new Set([node.id]);
  saveHistory();
  render();
  return node;
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
  // A deep copy is a plain node, never a component master — but an instance
  // inside it stays an instance of its component.
  if (node.type !== 'instance') delete node.componentId;
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

  // A deleted master takes its component with it; its instances elsewhere
  // become plain copies of its design first, so nothing on the canvas breaks.
  const gone = state.components.filter(c => toDelete.has(c.rootId));
  const detached = detachInstancesOf(gone.map(c => c.id), toDelete);

  state.nodes = state.nodes.filter(n => !toDelete.has(n.id));
  state.components = state.components.filter(c => !toDelete.has(c.rootId));
  state.selected.clear();
  saveHistory();
  render();
  if (detached) showToast(`${gone.length === 1 ? `Component "${componentName(gone[0])}"` : 'Components'} deleted \u2014 ${detached} instance${detached === 1 ? ' is' : 's are'} now regular copies`);
}

// Duplicate the selection with everything inside it, beside the original.
export function duplicateSelected() {
  if (state.readonly) return;
  const newSel = new Set();
  state.selected.forEach(id => {
    const n = getNode(id);
    if (!n) return;
    const copy = cloneNodeInPlace(n); // a whole subtree (or a new instance of a component)
    if (!copy) return;
    // Laid-out parents place the copy after its siblings; elsewhere it's offset.
    const parent = copy.parentId && getNode(copy.parentId);
    if (!parent || isStack(parent)) { copy.x += 20; copy.y += 20; }
    if (!isInstance(copy)) copy.name = (n.name || '') + ' copy';
    newSel.add(copy.id);
  });
  state.selected = newSel;
  saveHistory();
  render();
}

// Whether a node's stacking order means anything: it sits on the canvas, or in
// a stack or section — laid-out parents order their children by layout instead.
export function canReorder(node) {
  if (!node || node.type === 'section') return false;
  const parent = node.parentId && getNode(node.parentId);
  return !parent || isStack(parent);
}

// Move each reorderable selected node above (front) or below (back) its
// siblings: in its parent's children for nested nodes, among the canvas roots
// otherwise. One undo step.
function reorderSelected(toFront) {
  if (state.readonly) return;
  let moved = false;
  state.selected.forEach(id => {
    const n = getNode(id);
    if (!canReorder(n)) return;
    const parent = n.parentId && getNode(n.parentId);
    const list = parent ? parent.children : null;
    if (list) {
      list.splice(list.indexOf(n.id), 1);
      if (toFront) list.push(n.id); else list.unshift(n.id);
    } else {
      state.nodes.splice(state.nodes.indexOf(n), 1);
      if (toFront) state.nodes.push(n); else state.nodes.unshift(n);
    }
    moved = true;
  });
  if (!moved) return;
  saveHistory();
  render();
}
export const bringToFront = () => reorderSelected(true);
export const sendToBack = () => reorderSelected(false);

// Whether Copy has something to paste.
export const hasClipboard = () => !!(clipboard && clipboard.length);
