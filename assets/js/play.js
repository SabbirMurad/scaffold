// Play (prototype preview) mode. Opens a full-screen overlay that shows one
// screen frame inside a phone shell at 1:1 device size. Tapping any layer that
// carries an onTap → navigate action (the same `node.action` model Connect mode
// edits) walks to the target screen; a Back control returns along the nav stack.
// It reuses the already-rendered canvas DOM: the frame's element is deep-cloned
// and stripped of editor chrome, so what plays is exactly what's on the canvas.

import { state, getNode, getMasterNode } from './state.js';
import { showToast } from './utils.js';
import { routeTarget, scopeOfElement } from './data.js';
import { isFlex } from './nodes.js';

let overlay, stage, device, screen, titleEl, backBtn, restartBtn, statusBar, homeInd;
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
  // A list with nothing to repeat over is empty in the app — its template (drawn
  // dimmed on the canvas so it stays editable) doesn't play.
  clone.querySelectorAll('.repeat-empty').forEach(el => el.querySelectorAll(':scope > .node').forEach(n => n.remove()));
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
  clone.querySelectorAll('[data-id], [data-play-id]').forEach(el => {
    if (tapAction(el)) el.classList.add('has-action');
  });
  // The frame was absolutely positioned at its canvas x/y; sit it at the top-left
  // of the scroll viewport instead so below-the-fold content scrolls naturally.
  // A screen hidden on the canvas still plays when something navigates to it.
  const frame = getNode(frameId);
  if (frame && frame.visible === false) clone.style.display = isFlex(frame) ? 'flex' : '';
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

// The tap action of a drawn element: its node's own; for a component instance
// without one, its component's (the master's root); for an element drawn inside
// an instance, that element's in the master.
function tapAction(el) {
  const n = getNode(el.dataset.id || el.dataset.playId);
  if (!n) return null;
  return nodeAction(n) || (n.type === 'instance' ? nodeAction(getMasterNode(n.componentId)) : null);
}

// Show `frameId`. `anim` picks the entrance; `isBack` reverses the slide.
function show(frameId, anim, isBack) {
  const frame = getNode(frameId);
  if (!frame) return;
  const clone = buildClone(frameId);
  if (!clone) return;
  const screenH = screenHeight(frame);
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
  updateChrome();
}

// ── Status bar + home indicator colour ──
// Like iOS, each is black over light content and white over dark, going by what
// is actually under it — so it follows scrolling and each screen's colours.
function updateChrome() {
  if (!statusBar || overlay.hidden) return;
  const sr = screen.getBoundingClientRect();
  if (!sr.width) return;
  const k = deviceScale;
  statusBar.classList.toggle('on-dark', isDarkAt(sr.left + 30 * k, sr.top + 24 * k));
  homeInd.classList.toggle('on-dark', isDarkAt(sr.left + sr.width / 2, sr.bottom - 10 * k));
}

// Whether what's painted at a point is dark: the first element there with a
// real background colour (a picture counts as dark); the screen's white if none.
function isDarkAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (!screen.contains(el) && el !== screen) continue;
    const cs = getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('linear-gradient') && !cs.backgroundImage.startsWith('radial-gradient')) return true;
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) continue;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    if (a < 0.5) continue;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.55;
  }
  return false;
}
let chromeRaf = null;
const updateChromeSoon = () => { if (chromeRaf == null) chromeRaf = requestAnimationFrame(() => { chromeRaf = null; updateChrome(); }); };

// The device screen's height: the frame's screen height, never taller than the frame.
const screenHeight = (f) => Math.min(f.screenH != null ? f.screenH : f.h, f.h);

// Scale the phone shell down (never up) so it fits the stage.
function fit(w, h) {
  const availW = stage.clientWidth - 48;
  const availH = stage.clientHeight - 48;
  const pad = 44; // bezel padding (12px each edge) + the titanium rail/buttons that overhang it
  const scale = Math.min(1, availW / (w + pad), availH / (h + pad));
  device.style.transform = `scale(${scale})`;
  deviceScale = scale;
}

// ── Drag to scroll, as a finger does on the phone ──
// Press and drag moves the screen — or the scrolling container under the pointer
// that can move that way (a horizontal list scrolls sideways). A press that
// barely moves is still a tap; a real drag never also fires the tap.
let deviceScale = 1;
let drag = null;          // the press in progress
let suppressClick = false; // the drag that just ended must not count as a tap

const DRAG_START = 5; // px of movement before a press becomes a drag

// The nearest element from `el` up to the screen that can scroll along `axis`.
function scrollerFor(el, axis) {
  for (let e = el; e && e !== screen.parentElement; e = e.parentElement) {
    const cs = getComputedStyle(e);
    const overflow = axis === 'y' ? cs.overflowY : cs.overflowX;
    const room = axis === 'y' ? e.scrollHeight > e.clientHeight : e.scrollWidth > e.clientWidth;
    if (room && (overflow === 'auto' || overflow === 'scroll' || e === screen)) return e;
    if (e === screen) break;
  }
  return screen;
}

function onDragStart(e) {
  if (e.button !== 0 || swiping) return;
  // A press near either side edge can become the back gesture (for touch too —
  // the one gesture touch doesn't already have).
  const r = screen.getBoundingClientRect();
  const edge = (e.clientX - r.left) / deviceScale <= EDGE ? 'left'
    : (r.right - e.clientX) / deviceScale <= EDGE ? 'right' : null;
  if (e.pointerType === 'touch' && !edge) return; // touch already scrolls natively
  drag = { x: e.clientX, y: e.clientY, target: e.target, moved: false, edge };
  if (edge && e.pointerType === 'touch') screen.setPointerCapture?.(e.pointerId);
}

function onDragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < DRAG_START) return;
    drag.moved = true;
    // From an edge, inward: the back gesture. Anything else scrolls as usual.
    const inward = drag.edge === 'left' ? dx > 0 : drag.edge === 'right' ? dx < 0 : false;
    if (inward && Math.abs(dx) > Math.abs(dy)) beginSwipe(drag.edge);
    else if (e.pointerType === 'touch') { drag = null; return; }
  }
  if (drag.swipe) { moveSwipe(Math.abs(dx) / deviceScale, e.clientY, e.timeStamp); return; }
  if (!drag.axis) {
    drag.axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
    drag.el = scrollerFor(drag.target, drag.axis);
    drag.start = drag.axis === 'y' ? drag.el.scrollTop : drag.el.scrollLeft;
    screen.classList.add('dragging');
  }
  // The phone is drawn scaled down; move the content as far as the pointer went.
  if (drag.axis === 'y') drag.el.scrollTop = drag.start - dy / deviceScale;
  else drag.el.scrollLeft = drag.start - dx / deviceScale;
}

function onDragEnd() {
  if (drag && drag.swipe) endSwipe();
  if (drag && drag.moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0); // only the click this release produces
  }
  drag = null;
  screen.classList.remove('dragging');
}

// ── Back gesture (Android predictive back) ──
// Drag inward from either side edge: a back arrow slides out of that edge at the
// pointer, and the screen shrinks back to reveal the one before it. Once the
// arrow fills in (far enough, or a flick) letting go goes back; otherwise it all
// springs back. On the first screen the arrow still shows, but there's no back.
const EDGE = 40;         // px (device) from a side edge where the gesture can start
const ARM = 90;          // px (device) of travel that arms it
let swiping = false;     // the release animation is running
let under = null;        // the previous screen, shown beneath during the gesture
let arrow = null;        // the back arrow bubble

function beginSwipe(side) {
  drag.swipe = { side, dist: 0, samples: [], armed: false };
  const prev = stack[stack.length - 1];
  const clone = prev && buildClone(prev);
  if (clone) {
    under = document.createElement('div');
    under.className = 'play-under';
    Object.assign(under.style, { left: screen.offsetLeft + 'px', top: screen.offsetTop + 'px', width: screen.offsetWidth + 'px', height: screen.offsetHeight + 'px' });
    const shade = document.createElement('div');
    shade.className = 'play-under-shade';
    under.append(clone, shade);
    device.insertBefore(under, screen);
  }
  arrow = document.createElement('div');
  arrow.className = 'play-back-arrow ' + side;
  arrow.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>';
  device.appendChild(arrow);
  screen.classList.add('swiping');
}

// Paint the gesture `dist` px in, with the arrow at client y `clientY`.
function paintSwipe(sw, dist, clientY) {
  const p = Math.min(1, dist / ARM), dir = sw.side === 'left' ? 1 : -1;
  const content = screen.firstElementChild;
  if (content) {
    content.style.transform = `translateX(${dir * 18 * p}px) scale(${1 - 0.08 * p})`;
    content.style.borderRadius = (30 * p) + 'px';
  }
  if (under) {
    under.firstChild.style.transform = `scale(${0.94 + 0.06 * p})`;
    under.lastChild.style.opacity = String(0.4 * (1 - p));
  }
  if (arrow) {
    if (clientY != null) {
      const dr = device.getBoundingClientRect();
      const y = (clientY - dr.top) / deviceScale;
      const lo = screen.offsetTop + 40, hi = screen.offsetTop + screen.offsetHeight - 40;
      arrow.style.top = Math.max(lo, Math.min(hi, y)) + 'px';
    }
    // It grows out of the edge, staying inside the screen.
    const edgeX = sw.side === 'left' ? screen.offsetLeft : device.clientWidth - screen.offsetLeft - screen.offsetWidth;
    arrow.style[sw.side] = (edgeX + 4 + 12 * p) + 'px';
    arrow.style.setProperty('--s', String(0.55 + 0.45 * p));
    arrow.style.opacity = String(Math.min(1, p * 1.6));
    arrow.classList.toggle('armed', sw.armed);
  }
}

function moveSwipe(dist, clientY, t) {
  const sw = drag.swipe;
  sw.dist = Math.max(0, dist);
  sw.samples.push({ d: sw.dist, t });
  if (sw.samples.length > 5) sw.samples.shift();
  sw.armed = sw.dist >= ARM;
  paintSwipe(sw, sw.dist, clientY);
}

function endSwipe() {
  const sw = drag.swipe, first = sw.samples[0], last = sw.samples[sw.samples.length - 1];
  const speed = first && last && last.t > first.t ? (last.d - first.d) / (last.t - first.t) : 0; // px/ms, inward
  const back = (sw.armed || speed > 0.6) && stack.length > 0;
  swiping = true;
  screen.classList.add('swipe-settle');
  under?.classList.add('swipe-settle');
  arrow?.classList.add('swipe-settle');
  if (back) arrow?.classList.add('armed');
  requestAnimationFrame(() => {
    if (back) {
      // Committed: the screen falls away to the side, the previous one comes up.
      const content = screen.firstElementChild, dir = sw.side === 'left' ? 1 : -1;
      if (content) { content.style.transform = `translateX(${dir * 60}px) scale(0.86)`; content.style.opacity = '0'; }
      if (under) { under.firstChild.style.transform = 'scale(1)'; under.lastChild.style.opacity = '0'; }
      if (arrow) arrow.style.opacity = '0';
    } else {
      paintSwipe(sw, 0, null);
    }
  });
  setTimeout(() => {
    screen.classList.remove('swiping', 'swipe-settle');
    const content = screen.firstElementChild;
    if (content) { content.style.transform = ''; content.style.borderRadius = ''; content.style.opacity = ''; }
    under?.remove(); under = null;
    arrow?.remove(); arrow = null;
    swiping = false;
    if (back) show(stack.pop(), 'none', true);
  }, 230);
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
  if (suppressClick) { suppressClick = false; return; }
  const TAPPABLE = '[data-id], [data-play-id]';
  let el = e.target.closest(TAPPABLE);
  while (el) {
    const action = tapAction(el);
    if (action) { navigate(action, el); return; }
    el = el.parentElement ? el.parentElement.closest(TAPPABLE) : null;
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
  statusBar = document.getElementById('play-statusbar');
  homeInd = document.getElementById('play-home-ind');
  screen?.addEventListener('scroll', updateChromeSoon, true); // the screen or any list in it

  document.getElementById('tool-play')?.addEventListener('click', launch);
  document.getElementById('play-close')?.addEventListener('click', close);
  backBtn?.addEventListener('click', goBack);
  restartBtn?.addEventListener('click', restart);
  screen?.addEventListener('click', onScreenClick);
  screen?.addEventListener('pointerdown', onDragStart);
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay || e.target === stage) close(); });

  window.addEventListener('resize', () => {
    if (overlay.hidden) return;
    const f = getNode(currentId);
    if (f) fit(f.w, screenHeight(f));
  });

  // While playing, keys belong to Play — none reach the editor's shortcuts, which
  // would otherwise act on the design behind it (Backspace deleting the selection,
  // arrows moving it, Ctrl+Z undoing).
  document.addEventListener('keydown', e => {
    if (overlay.hidden) return;
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); goBack(); }
    else if (e.key === ' ' || e.key.startsWith('Arrow') || e.key === 'Tab') e.preventDefault();
  }, true);
}
