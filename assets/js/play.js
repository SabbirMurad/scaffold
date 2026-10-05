// Play (prototype preview) mode. Opens a full-screen overlay that shows one
// screen frame inside a phone shell at 1:1 device size. Tapping any layer that
// carries an onTap → navigate action (the same `node.action` model Connect mode
// edits) walks to the target screen; a Back control returns along the nav stack.
// It reuses the already-rendered canvas DOM: the frame's element is deep-cloned
// and stripped of editor chrome, so what plays is exactly what's on the canvas.

import { state, getNode, getMasterNode } from './state.js';
import { tapWidget, startAutoplay } from './widgets.js';
import { showToast } from './utils.js';
import { routeTarget, scopeOfElement } from './data.js';
import { isFlex, isOverlayFrame } from './nodes.js';
import { pageOf } from './pages.js';
import { routeOf } from './codegen.js';

// Stops the autoplaying carousels on the Play screen shown (startAutoplay).
let stopAutoplay = () => {};

let overlay, stage, device, screen, titleEl, backBtn, restartBtn, statusBar, homeInd, browserBar;
// The screen playing is on a web page: shown in a browser window, not a phone.
let web = false;
// That browser window fills the whole view (the default), or sits as a 16:9
// window — its minimize/maximize buttons switch between the two.
let webFull = true;
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
  if (a.type === 'back' || a.type === 'close') return a;
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
  web = isWebScreen(frame);
  if (web) fillBrowserBar(frame);
  layout(frame);
  screen.scrollTop = 0;
  screen.innerHTML = '';
  const cls = anim === 'none' ? '' : (anim === 'fade' ? 'play-anim-fade' : (isBack ? 'play-anim-back' : 'play-anim-fwd'));
  if (cls) clone.classList.add(cls);
  screen.appendChild(clone);
  stopAutoplay(); stopAutoplay = startAutoplay(clone); // carousels that slide by themselves
  // A web screen sits centred when the browser is wider than it, with its own
  // background colour filling the sides.
  if (web) {
    clone.style.margin = '0 auto';
    screen.style.background = getComputedStyle(clone).backgroundColor;
  } else {
    screen.style.background = '';
  }
  currentId = frameId;
  titleEl.textContent = frame.name || 'Screen';
  backBtn.disabled = stack.length === 0;
  document.getElementById('pb-back').disabled = stack.length === 0;
  updateChrome();
}

// Size and place the phone or browser window for `frame`.
//  - Phone: the frame's screen in the phone shell, scaled down to fit.
//  - Web, full view: the browser window fills the whole view, the design scaled
//    to its width (Play's own bar gives way to the browser's buttons).
//  - Web, windowed: a 16:9 window (a 1920×1080 monitor's shape) as wide as the
//    design, scaled down to fit.
// Either way the design starts below the browser's top.
function layout(frame) {
  device.classList.toggle('web', web);
  const full = web && webFull;
  overlay.classList.toggle('web-full', full);
  syncWindowButtons();
  screen.style.width = frame.w + 'px';
  if (!web) {
    device.style.width = device.style.height = '';
    const screenH = screenHeight(frame);
    screen.style.height = screenH + 'px';
    fit(frame.w, screenH);
    return;
  }
  let shellW = frame.w, shellH;
  if (full) {
    // Never zoomed up: a 1440 design on a 1920 screen shows at its real size,
    // centred on its background (as a fixed-width site sits on a wide monitor).
    // Only a design wider than the view is scaled down to fit.
    const k = Math.min(1, overlay.clientWidth / frame.w);
    shellW = overlay.clientWidth / k;
    shellH = overlay.clientHeight / k;
    device.style.transform = `scale(${k})`;
    deviceScale = k;
  } else {
    shellH = Math.round(frame.w * 9 / 16);
  }
  device.style.width = shellW + 'px';
  device.style.height = shellH + 'px';
  screen.style.width = shellW + 'px';
  screen.style.height = Math.max(0, shellH - browserBar.offsetHeight) + 'px';
  if (!full) fit(frame.w, shellH, 0);
}

// Full view ⇄ window (the browser's minimize and maximize buttons).
function toggleWebFull() {
  const frame = getNode(currentId);
  if (!web || !frame) return;
  webFull = !webFull;
  layout(frame);
}

// The maximize button shows "restore" (two squares) while the window fills the view.
function syncWindowButtons() {
  const max = document.getElementById('pb-max');
  if (!max) return;
  max.innerHTML = webFull
    ? '<svg viewBox="0 0 10 10"><rect x="1.5" y="3" width="5.5" height="5.5"/><path d="M3 3V1.5h5.5V7H7"/></svg>'
    : '<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg>';
  max.setAttribute('aria-label', webFull ? 'Restore down' : 'Maximize');
  max.title = webFull ? 'Restore down' : 'Maximize';
}

// Whether a screen is on a web page (pages.js).
function isWebScreen(frame) {
  const page = state.pages.find(p => p.id === pageOf(frame));
  return !!page && page.kind === 'web';
}

// The browser top for a web screen: its name on the tab, and an address made
// from the project's name and the screen's route.
function fillBrowserBar(frame) {
  const name = state.projectName || 'App';
  const host = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  document.getElementById('pb-tab-title').textContent = frame.name || 'Screen';
  document.getElementById('pb-favicon').textContent = name.trim().charAt(0).toUpperCase() || 'A';
  document.getElementById('pb-url').textContent = `${host}.app${routeOf(frame)}`;
}

// ── Status bar + home indicator colour ──
// Like iOS, each is black over light content and white over dark, going by what
// is actually under it — so it follows scrolling and each screen's colours.
function updateChrome() {
  if (!statusBar || overlay.hidden || web) return; // a browser window has no status bar
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

// Bezel padding (12px each edge) + the titanium rail/buttons that overhang it.
const PHONE_PAD = 44;

// Scale the phone (or browser window) down, never up, so it fits the stage.
// `pad`: what the shell adds around w×h.
function fit(w, h, pad = PHONE_PAD) {
  const availW = stage.clientWidth - 48;
  const availH = stage.clientHeight - 48;
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
  // The edge swipe is a phone gesture; a browser has its back button.
  const edge = web ? null : (e.clientX - r.left) / deviceScale <= EDGE ? 'left'
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
  if (action.type === 'close') { closeOverlay(); return; }
  if (action.type === 'back') { closeOverlays(); goBack(); return; }
  const target = routeTarget(action, scopeOfElement(el));
  if (!target) { showToast('No route matches this data'); return; }
  // An overlay frame opens over the screen instead of replacing it.
  if (isOverlayFrame(getNode(target))) { openOverlay(target, el); return; }
  closeOverlays();
  const mode = action.mode || 'push';
  if (mode === 'push') stack.push(currentId);
  else if (mode === 'clear') stack = [];
  // 'replace' leaves the stack as-is.
  show(target, action.transition, false);
}

// ── Overlays (dialogs, sheets, menus — nodes.js) ────────────────────────────
// Each open overlay is a layer over the screen (inside the device, so it scales
// with it): a scrim, and the overlay frame's clone placed by its kind.
let overlays = [];

function openOverlay(frameId, fromEl) {
  const frame = getNode(frameId);
  const clone = buildClone(frameId);
  if (!frame || !clone) return;
  const kind = frame.overlay.kind;
  const layer = document.createElement('div');
  layer.className = 'play-overlay-layer';
  Object.assign(layer.style, { position: 'absolute', left: screen.offsetLeft + 'px', top: screen.offsetTop + 'px',
    width: screen.offsetWidth + 'px', height: screen.offsetHeight + 'px', zIndex: String(20 + overlays.length), overflow: 'hidden' });
  const scrim = document.createElement('div');
  Object.assign(scrim.style, { position: 'absolute', inset: '0', background: kind === 'menu' ? 'transparent' : 'rgba(0,0,0,0.4)',
    opacity: '0', transition: 'opacity .18s' });
  scrim.addEventListener('click', () => { if (frame.overlay.dismissible !== false) closeOverlay(); });
  layer.appendChild(scrim);
  clone.style.position = 'absolute';
  clone.style.transition = 'transform .22s ease, opacity .18s';
  if (kind === 'dialog') {
    Object.assign(clone.style, { left: '50%', top: '50%', transform: 'translate(-50%, -50%) scale(.96)', opacity: '0' });
    requestAnimationFrame(() => { clone.style.transform = 'translate(-50%, -50%)'; clone.style.opacity = '1'; });
  } else if (kind === 'sheet') {
    Object.assign(clone.style, { left: '50%', top: 'auto', bottom: '0', transform: 'translate(-50%, 100%)', maxWidth: '100%' });
    requestAnimationFrame(() => { clone.style.transform = 'translate(-50%, 0)'; });
  } else {
    // A menu sits under the element tapped (above it when there's no room).
    const scale = screen.getBoundingClientRect().width / (screen.offsetWidth || 1) || 1;
    const sr = screen.getBoundingClientRect();
    const er = fromEl ? fromEl.getBoundingClientRect() : sr;
    const left = Math.max(8, Math.min((er.left - sr.left) / scale, screen.offsetWidth - frame.w - 8));
    let top = (er.bottom - sr.top) / scale + 4;
    if (top + frame.h > screen.offsetHeight - 8) top = Math.max(8, (er.top - sr.top) / scale - frame.h - 4);
    Object.assign(clone.style, { left: left + 'px', top: top + 'px', opacity: '0', boxShadow: clone.style.boxShadow || '0 8px 24px rgba(0,0,0,.18)' });
    requestAnimationFrame(() => { clone.style.opacity = '1'; });
  }
  layer.appendChild(clone);
  layer.addEventListener('click', onScreenClick); // taps inside the overlay act as on the screen
  device.appendChild(layer);
  requestAnimationFrame(() => { scrim.style.opacity = '1'; });
  overlays.push(layer);
}

// Close the top overlay (a "close" action, or a tap outside it).
function closeOverlay() {
  const layer = overlays.pop();
  if (layer) layer.remove();
}
function closeOverlays() {
  overlays.forEach(l => l.remove());
  overlays = [];
}

function goBack() {
  if (!stack.length) return;
  show(stack.pop(), 'platform', true);
}

function restart() {
  closeOverlays();
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
  closeOverlays();
  stopAutoplay();
  overlay.hidden = true;
  overlay.classList.remove('web-full');
  webFull = true; // next time a web screen opens full view again
  document.body.classList.remove('playing');
  screen.innerHTML = '';
}

// Launch Play on the selected screen, or the initial/first screen otherwise.
function launch() {
  const frames = state.nodes.filter(isPageFrame);
  if (!frames.length) { showToast('Add a frame to preview'); return; }
  let target = null;
  if (state.selected.size === 1) target = pageFrameOf(getNode([...state.selected][0]));
  // Nothing selected: the open page's initial (or first) screen, then any page's.
  const here = frames.filter(f => pageOf(f) === state.activePageId);
  if (!target) target = here.find(f => f.isInitial) || here[0] || frames.find(f => f.isInitial) || frames[0];
  open(target.id);
}

// A tap walks up from the hit element through the node tree; the first ancestor
// with a navigate action wins (mirrors how an onTap bubbles in Flutter).
function onScreenClick(e) {
  if (suppressClick) { suppressClick = false; return; }
  if (tapWidget(e.target)) return; // a tab, or a carousel's arrow or dot
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
  browserBar = document.getElementById('play-browser');
  document.getElementById('pb-back')?.addEventListener('click', goBack);
  document.getElementById('pb-reload')?.addEventListener('click', () => { if (currentId) show(currentId, 'fade'); });
  document.getElementById('pb-min')?.addEventListener('click', toggleWebFull);
  document.getElementById('pb-max')?.addEventListener('click', toggleWebFull);
  document.getElementById('pb-close')?.addEventListener('click', close);
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
    if (f) layout(f);
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
