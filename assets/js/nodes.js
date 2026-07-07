import { state, getNode } from './state.js';

// Types that can contain children (valid drop targets). A Section holds frames.
export const CONTAINER_TYPES = ['frame', 'container', 'row', 'column', 'wrap', 'stack', 'section'];
// Wrappers that hold exactly one child; the rest are multi-child layouts
export const SINGLE_CHILD_TYPES = ['frame', 'container'];
// Multi-child layout types (row/column/wrap are flex, stack is absolute)
export const MULTI_CHILD_TYPES = ['row', 'column', 'wrap', 'stack'];

// A container adopts a layout via its `layout` property ('row'/'column'/'wrap'/
// 'stack'); the legacy row/column/wrap/stack node types are equivalent to a
// container locked to that layout. These helpers give a node's *effective*
// layout role from either source, so the rest of the app needn't care which.
// Containers and frames can both carry an auto-layout via their `layout` property.
const LAYOUT_HOST = (node) => node && (node.type === 'container' || node.type === 'frame');
export function flexKind(node) {
  if (!node) return null;
  if (node.type === 'row' || node.type === 'column' || node.type === 'wrap') return node.type;
  if (LAYOUT_HOST(node) && ['row', 'column', 'wrap'].includes(node.layout)) return node.layout;
  return null;
}
export function isFlex(node) { return flexKind(node) !== null; }
export function isStack(node) {
  // Sections position their frames freely (absolute x/y), same as a stack.
  return !!node && (node.type === 'stack' || node.type === 'section' || (LAYOUT_HOST(node) && node.layout === 'stack'));
}

// A "screen" frame: a routable page. That's a frame either at the canvas root or
// directly inside a Section (which groups screens into a folder). A frame nested
// inside another frame is a component, not a screen.
export function isScreenFrame(node) {
  if (!node || node.type !== 'frame') return false;
  if (!node.parentId) return true;
  const p = getNode(node.parentId);
  return !!p && p.type === 'section';
}
// Holds exactly one child (pads + aligns it): a frame or container with no
// auto-layout. Once a layout is chosen it lays its own children out instead.
export function isSingleChild(node) {
  return LAYOUT_HOST(node) && (!node.layout || node.layout === 'none');
}

// A node can become a component if it isn't a frame/section and its whole subtree
// is frame/section-free — components live strictly below the screen level.
export function canBeComponent(node) {
  const check = (n) => {
    if (!n || n.type === 'frame' || n.type === 'section') return false;
    return (n.children || []).every(cid => check(getNode(cid)));
  };
  return check(node);
}
// Lays its children out itself (flex or stack) rather than holding just one.
export function isMultiChild(node) { return isFlex(node) || isStack(node); }

// Whether `node` can accept a child right now. `childType` (or the type resolved
// from `childId`) refines the Section rules:
//   • Sections are top-level only — nothing ever accepts a section as a child.
//   • A Section only accepts frames (each becomes a file under its folder).
// Otherwise: multi-child layouts always accept; single-child wrappers only if
// empty (ignoring childId itself, so an existing child can be re-dropped within).
export function canAcceptChild(node, childId = null, childType = null) {
  if (!node || !CONTAINER_TYPES.includes(node.type)) return false;
  const ct = childType || (childId ? (getNode(childId)?.type || null) : null);
  if (ct === 'section') return false;
  if (node.type === 'section') return ct === 'frame';
  if (!isSingleChild(node)) return true;
  const kids = (node.children || []).filter(id => id !== childId);
  return kids.length === 0;
}

export function canvasToWorld(cx, cy) {
  return {
    x: (cx - state.panX) / state.zoom,
    y: (cy - state.panY) / state.zoom,
  };
}

export function getWorldPos(node) {
  let x = node.x, y = node.y;
  let cur = node;
  while (cur.parentId) {
    const parent = getNode(cur.parentId);
    if (!parent) break;
    x += parent.x;
    y += parent.y;
    cur = parent;
  }
  return { x, y };
}

export function isDescendant(nodeId, ancestorId) {
  if (!ancestorId) return false;
  let cur = getNode(nodeId);
  while (cur && cur.parentId) {
    if (cur.parentId === ancestorId) return true;
    cur = getNode(cur.parentId);
  }
  return false;
}

export function findFrameAt(wx, wy, excludeId = null, childType = null) {
  const frames = [...state.nodes].reverse().filter(n =>
    n.id !== excludeId && !isDescendant(n.id, excludeId) && canAcceptChild(n, excludeId, childType)
  );
  for (const frame of frames) {
    const wp = getWorldPos(frame);
    if (wx >= wp.x && wx <= wp.x + frame.w && wy >= wp.y && wy <= wp.y + frame.h) {
      return frame;
    }
  }
  return null;
}

export function reparentNode(node, newParentId) {
  if (state.readonly) return; // viewers can't move nodes between parents
  const oldParentId = node.parentId;
  if (oldParentId === newParentId) return;

  const wp = getWorldPos(node);

  // Freeze the on-screen size now, before the DOM/parenting changes, so any
  // "fill" axis that becomes invalid in the new context can keep the size it
  // currently occupies (see the fill→fixed baking below).
  const el = document.getElementById('node-' + node.id);
  const measuredW = el ? el.offsetWidth : node.w;
  const measuredH = el ? el.offsetHeight : node.h;

  if (oldParentId) {
    const oldParent = getNode(oldParentId);
    if (oldParent) oldParent.children = oldParent.children.filter(id => id !== node.id);
  }

  node.parentId = newParentId || null;
  if (newParentId) {
    const newParent = getNode(newParentId);
    if (newParent) {
      if (!newParent.children.includes(node.id)) newParent.children.push(node.id);
      if (isSingleChild(newParent)) {
        // Single-child wrappers pin their child to the top-left corner
        node.x = 0;
        node.y = 0;
      } else {
        const newWp = getWorldPos(newParent);
        node.x = wp.x - newWp.x;
        node.y = wp.y - newWp.y;
      }
    }
  } else {
    node.x = wp.x;
    node.y = wp.y;
  }

  // "Fill" only makes sense inside a parent that isn't hugging the same axis.
  // When a node leaves such a parent — detached to the canvas, or dropped into a
  // parent that hugs — freeze that axis to the size it was just filling, exactly
  // as if the user had switched it from Fill to Fixed before moving it. Without
  // this the node's width:100% would resolve against the wrong (or no) parent and
  // it would stretch or collapse.
  const newParent = newParentId ? getNode(newParentId) : null;
  if (node.wMode === 'fill' && !(newParent && newParent.wMode !== 'hug')) {
    node.w = measuredW;
    node.wMode = 'fixed';
    if (node.type === 'text') node.autoSize = false;
  }
  if (node.hMode === 'fill' && !(newParent && newParent.hMode !== 'hug')) {
    node.h = measuredH;
    node.hMode = 'fixed';
  }
}

export function clearDropTargets() {
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
}

export function highlightDropTarget(worldX, worldY, excludeId = null, childType = null) {
  clearDropTargets();
  const frame = findFrameAt(worldX, worldY, excludeId, childType);
  if (frame) {
    const el = document.getElementById('node-' + frame.id);
    if (el) el.classList.add('drop-target');
  }
}
