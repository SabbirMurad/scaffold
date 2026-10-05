// Lottie animations: a `lottie` node plays an animation file (Bodymovin JSON).
//
// The JSON lives once per file in `state.lotties` (id → JSON text), a document
// slice of its own: the `nodes` slice is resent on every edit, an animation
// only when one is added. It isn't in undo snapshots either (history.js) —
// files are only ever added, so an undo just leaves an unused one, dropped on
// the next load.
//
// A node: { type: 'lottie', lottieId, loop, autoplay, speed, poster (0–1, the
// frame shown while still), fit, alt, decorative }.
//
// The player is lottie-web's light build (assets/js/vendor/lottie_light.min.js):
// SVG renderer only, and no expression support — expressions run as code, and
// an animation can come from anyone (an import, a collaborator, Claude).
// Anything in a file that would load from the internet (linked images, font
// files) is removed when it's added, so an animation can't reach out.

import { state } from './state.js';

export const LOTTIE_MAX_BYTES = 2 * 1024 * 1024;
const PLAYER_SRC = '/assets/js/vendor/lottie_light.min.js';

// ── files ────────────────────────────────────────────────────────────────────
// Read and check an animation file: { json (cleaned text), w, h, frames, fps }.
// Throws a message a person can read.
export function readLottie(text) {
  if (typeof text !== 'string') text = JSON.stringify(text);
  if (text.length > LOTTIE_MAX_BYTES) throw new Error(`That animation is ${(text.length / 1048576).toFixed(1)} MB — the limit is 2 MB`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file isn\'t valid JSON'); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.layers) || !(data.w > 0) || !(data.h > 0)) {
    throw new Error('That JSON isn\'t a Lottie animation (no layers or size)');
  }
  // Nothing loaded from elsewhere: linked images become empty, font files go.
  (data.assets || []).forEach(a => {
    if (a && typeof a.p === 'string' && !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(a.p)) {
      a.p = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      a.u = ''; a.e = 1;
    }
  });
  if (data.fonts && Array.isArray(data.fonts.list)) data.fonts.list.forEach(f => { delete f.fPath; });
  const fps = data.fr > 0 ? data.fr : 30;
  return { json: JSON.stringify(data), w: Math.round(data.w), h: Math.round(data.h), frames: Math.max(1, (data.op || 0) - (data.ip || 0)), fps };
}

// Store an animation (once per distinct file) and return its id.
export function addLottie(text) {
  const { json } = readLottie(text);
  if (!state.lotties) state.lotties = {};
  const id = 'lt_' + hash(json);
  if (!state.lotties[id]) state.lotties[id] = json;
  return id;
}

export const lottieJson = (id) => (state.lotties && id && state.lotties[id]) || null;

// A fresh copy per player: lottie-web changes the data it's given.
function dataOf(id) {
  const json = lottieJson(id);
  return json ? JSON.parse(json) : null;
}

function hash(s) {
  let h1 = 0x811c9dc5, h2 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

// ── export ───────────────────────────────────────────────────────────────────
// An animation's file in an export: assets/lottie/<id>.json.
export const lottieFile = (id) => `${String(id).replace(/[^a-z0-9_]/gi, '_')}.json`;

// The web export ships the player (pages can't load scripts from elsewhere), and
// export files are made synchronously — so its source is fetched beforehand.
let playerSource = null;
export async function preparePlayerSource() {
  if (playerSource) return playerSource;
  try { const res = await fetch(PLAYER_SRC); if (res.ok) playerSource = await res.text(); } catch { /* left out */ }
  return playerSource;
}
export const lottiePlayerSource = () => playerSource;

// The animation files a set of nodes play (their subtrees, components and
// overlays included): id → JSON.
export function lottiesUsed(nodes, getNode, getMasterNode) {
  const out = new Map(), seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    if (n.type === 'lottie' && lottieJson(n.lottieId)) out.set(n.lottieId, lottieJson(n.lottieId));
    if (n.type === 'instance') walk(getMasterNode(n.componentId));
    const t = n.action && n.action.targetFrameId ? getNode(n.action.targetFrameId) : null;
    if (t && t.overlay) walk(t);
    (n.children || []).forEach(id => walk(getNode(id)));
  };
  nodes.forEach(walk);
  return out;
}

// ── player ───────────────────────────────────────────────────────────────────
let player = null;
function loadPlayer() {
  if (window.lottie) return Promise.resolve(window.lottie);
  if (!player) {
    player = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PLAYER_SRC;
      s.onload = () => (window.lottie ? resolve(window.lottie) : reject(new Error('player missing')));
      s.onerror = () => reject(new Error('Couldn\'t load the animation player'));
      document.head.appendChild(s);
    });
  }
  return player;
}

const live = new Set(); // players mounted in the page, destroyed once their element is gone

// Play (or hold still) a node's animation inside `el`. `play`: false holds the
// poster frame — the canvas, where many animations shouldn't all run.
export function mountLottie(el, node, { play = false } = {}) {
  const data = dataOf(node.lottieId);
  if (!data) { el.classList.add('lottie-missing'); return; }
  el.dataset.lottieId = node.lottieId;
  loadPlayer().then(lottie => {
    if (!el.isConnected) return; // redrawn meanwhile
    const fit = { cover: 'xMidYMid slice', fill: 'none' }[node.fit] || 'xMidYMid meet';
    const anim = lottie.loadAnimation({
      container: el, renderer: 'svg', animationData: data, loop: node.loop !== false, autoplay: false,
      rendererSettings: { preserveAspectRatio: fit, progressiveLoad: true },
    });
    anim.__el = el;
    live.add(anim);
    anim.setSpeed(node.speed > 0 ? node.speed : 1);
    const still = () => anim.goToAndStop(Math.round((anim.totalFrames - 1) * clamp01(node.poster ?? 0)), true);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (play && node.autoplay !== false && !reduce) anim.play(); else still();
  }).catch(() => el.classList.add('lottie-missing'));
}
const clamp01 = (v) => Math.min(Math.max(Number(v) || 0, 0), 1);

// Stop and free the players whose elements left the page (the canvas redraws
// by rebuilding its elements).
export function sweepLotties() {
  live.forEach(anim => {
    if (!anim.__el || !anim.__el.isConnected) { anim.destroy(); live.delete(anim); }
  });
}

// Play / hold a drawn animation (the props panel's preview).
export function previewLottie(el, on) {
  const anim = [...live].find(a => a.__el === el);
  if (anim) { if (on) anim.play(); else anim.stop(); }
  return !!anim;
}

// Play: the cloned screen's animations are pictures of the canvas; mount real,
// playing ones in their place.
export function playLotties(root, nodeOf) {
  root.querySelectorAll('[data-lottie-id]').forEach(el => {
    const node = nodeOf(el);
    if (!node) return;
    el.innerHTML = '';
    mountLottie(el, node, { play: true });
  });
}

// Show a drawn animation at a point (0–1) — the still-frame slider, live.
export function seekLottie(el, fraction) {
  const anim = [...live].find(a => a.__el === el);
  if (anim) anim.goToAndStop(Math.round((anim.totalFrames - 1) * clamp01(fraction)), true);
}
