// Play (prototype preview) mode. Opens a full-screen overlay that shows one
// screen frame inside a phone shell at 1:1 device size. Tapping any layer that
// carries an onTap → navigate action (the same `node.action` model Connect mode
// edits) walks to the target screen; a Back control returns along the nav stack.
// It reuses the already-rendered canvas DOM: the frame's element is deep-cloned
// and stripped of editor chrome, so what plays is exactly what's on the canvas.

import { state, getNode } from './state.js';
import { showToast } from './utils.js';
import { routeTarget, scopeOfElement } from './data.js';

let overlay, stage, device, screen, titleEl, backBtn, restartBtn;
let stack = [];       // frame ids to return to (Back pops this)
let startId = null;   // the frame Play launched on (Restart returns here)
let currentId = null; // the frame on screen now

// A navigable screen: a top-level frame — one at the canvas root, or placed
// directly inside a Section. (Frames nested inside another frame are components.)
function isPageFrame(n) {
  return n && n.type === 'frame' && (!n.parentId || getNode(n.parentId)?.type === 'section');
}

// The page frame a node belongs to: the outermost frame ancestor that is itself a
// page frame. Lets Play launch from any selected layer, not just the frame box.
function pageFrameOf(node) {
  let cur = node, found = null;
  while (cur) {
    if (isPageFrame(cur)) found = cur;
    cur = cur.parentId ? getNode(cur.parentId) : null;
  }
  return found;
}

// Deep-clone a rendered frame element, stripping every editor-only bit so it
// reads as a plain running screen. Node classes/inline styles are kept (the same
// CSS applies in this document), so the clone paints identically.
function buildClone(frameId) {
  const srcEl = document.getElementById('node-' + frameId);
  if (!srcEl) return null;
  const clone = srcEl.cloneNode(true);
  // Selection handles and the design-only "screen end" fold never play.
  // …nor do elements whose data condition doesn't hold (dimmed on the canvas).
  clone.querySelectorAll('.sel-handles, .screen-fold, .cond-hidden').forEach(n => n.remove());
  // `data-id` is kept (it maps a tap back to its node); everything editor-specific
  // — the element id and chrome classes — is dropped.
  const scrub = el => {
    el.removeAttribute('id');
    el.classList.remove('selected', 'is-component', 'is-instance', 'instance-missing',
      'drop-target', 'drag-source', 'flow-target', 'has-action');
  };
  scrub(clone);
  clone.querySelectorAll('.node').forEach(scrub);
  // Re-add has-action (a tap cursor hint) after the blanket scrub above.
  if (nodeAction(getNode(frameId))) clone.classList.add('has-action');
  clone.querySelectorAll('[data-id]').forEach(el => {
    if (nodeAction(getNode(el.dataset.id))) el.classList.add('has-action');
  });
  // The frame was absolutely positioned at its canvas x/y; sit it at the top-left
  // of the scroll viewport instead so below-the-fold content scrolls naturally.
  clone.style.position = 'relative';
  clone.style.left = '0';
  clone.style.top = '0';
  clone.style.margin = '0';
  clone.style.transform = '';
  return clone;
}

// A node's tap action, if it does anything: back, or navigate to a real screen
// (directly or through a conditional route).
function nodeAction(n) {
  const a = n && n.action;
  if (!a) return null;
  if (a.type === 'back') return a;
  if (a.type !== 'navigate') return null;
  const targets = [a.targetFrameId, ...(a.routes || []).map(r => r && r.target)];
  return targets.some(id => id && getNode(id)) ? a : null;
}

// Show `frameId`. `anim` picks the entrance; `isBack` reverses the slide.
function show(frameId, anim, isBack) {
  const frame = getNode(frameId);
  if (!frame) return;
  const clone = buildClone(frameId);
  if (!clone) return;
  const screenH = frame.screenH != null ? frame.screenH : frame.h;
  screen.style.width = frame.w + 'px';
  screen.style.height = screenH + 'px';
  screen.scrollTop = 0;
  screen.innerHTML = '';
  const cls = anim === 'none' ? '' : (anim === 'fade' ? 'play-anim-fade' : (isBack ? 'play-anim-back' : 'play-anim-fwd'));
  if (cls) clone.classList.add(cls);
  screen.appendChild(clone);
  currentId = frameId;
  titleEl.textContent = frame.name || 'Screen';
  backBtn.disabled = stack.length === 0;
  fit(frame.w, screenH);
}

// Scale the phone shell down (never up) so it fits the stage.
function fit(w, h) {
  const availW = stage.clientWidth - 48;
  const availH = stage.clientHeight - 48;
  const pad = 44; // bezel padding (12px each edge) + the titanium rail/buttons that overhang it
  const scale = Math.min(1, availW / (w + pad), availH / (h + pad));
  device.style.transform = `scale(${scale})`;
}

// Follow a node's action, honoring its stack mode. A conditional route picks its
// target from the data the tapped element was drawn with (its repeat item).
function navigate(action, el) {
  if (action.type === 'back') { goBack(); return; }
  const target = routeTarget(action, scopeOfElement(el));
  if (!target) { showToast('No route matches this data'); return; }
  const mode = action.mode || 'push';
  if (mode === 'push') stack.push(currentId);
  else if (mode === 'clear') stack = [];
  // 'replace' leaves the stack as-is.
  show(target, action.transition, false);
}

function goBack() {
  if (!stack.length) return;
  show(stack.pop(), 'platform', true);
}

function restart() {
  stack = [];
  show(startId, 'none', false);
}

function open(frameId) {
  startId = currentId = frameId;
  stack = [];
  overlay.hidden = false;
  document.body.classList.add('playing');
  show(frameId, 'none', false);
}

function close() {
  overlay.hidden = true;
  document.body.classList.remove('playing');
  screen.innerHTML = '';
}

// Launch Play on the selected screen, or the initial/first screen otherwise.
function launch() {
  const frames = state.nodes.filter(isPageFrame);
  if (!frames.length) { showToast('Add a frame to preview'); return; }
  let target = null;
  if (state.selected.size === 1) target = pageFrameOf(getNode([...state.selected][0]));
  if (!target) target = frames.find(f => f.isInitial) || frames[0];
  open(target.id);
}

// A tap walks up from the hit element through the node tree; the first ancestor
// with a navigate action wins (mirrors how an onTap bubbles in Flutter).
function onScreenClick(e) {
  let el = e.target.closest('[data-id]');
  while (el) {
    const action = nodeAction(getNode(el.dataset.id));
    if (action) { navigate(action, el); return; }
    el = el.parentElement ? el.parentElement.closest('[data-id]') : null;
  }
}

export function initPlay() {
  overlay = document.getElementById('play-overlay');
  if (!overlay) return;
  stage = document.getElementById('play-stage');
  device = document.getElementById('play-device');
  screen = document.getElementById('play-screen');
  titleEl = document.getElementById('play-title');
  backBtn = document.getElementById('play-back');
  restartBtn = document.getElementById('play-restart');

  document.getElementById('tool-play')?.addEventListener('click', launch);
  document.getElementById('play-close')?.addEventListener('click', close);
  backBtn?.addEventListener('click', goBack);
  restartBtn?.addEventListener('click', restart);
  screen?.addEventListener('click', onScreenClick);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay || e.target === stage) close(); });

  window.addEventListener('resize', () => {
    if (overlay.hidden) return;
    const f = getNode(currentId);
    if (f) fit(f.w, f.screenH != null ? f.screenH : f.h);
  });

  document.addEventListener('keydown', e => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); goBack(); }
  }, true);
}
