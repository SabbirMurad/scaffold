// Dashboard preview. The project card on the dashboard shows the screens worked
// on most recently, drawn by the editor into a small image and uploaded.
//
// Drawing and uploading is the expensive part, so it happens once per visit at
// most — when leaving the project (back to the projects list, or closing the
// window) — and only if the picture would change:
//  - while editing, a screen is stamped `editedAt` when a commit changes
//    something inside it (cheap: one JSON per screen per commit, no network);
//    that picks the screens to show;
//  - on leaving, the picture's fingerprint (those screens + the colors, type and
//    data they use) is compared with the one the server holds; when they match,
//    nothing is drawn or sent.

import { state, getNode } from './state.js';
import { commitCurrent } from './history.js';
import { isScreenFrame } from './nodes.js';
import { getAuth, refreshToken } from './session.js';

const SHOWN = 3;                    // screens on the card
const W = 720, H = 486;             // the image (≈ the card, at 3x)

let projectId = null;
let serverSig = null;      // fingerprint of the preview the server has
// Backdrop behind the screens: a neutral grey, so any design's colors sit well on it.
const BACKDROP = ['#4a4d55', '#2a2c31'];
const LOOK = 2; // bump when the drawing changes, so every preview is redrawn once
let screenSigs = new Map(); // screen id → fingerprint of its contents
let running = null;        // the update in progress, if any

export function initThumbnail(id, project) {
  if (!id || state.readonly || state.publicToken) return;
  projectId = id;
  serverSig = (project && project.thumbnail_sig) || null;
  screenSigs = currentScreenSigs();

  document.addEventListener('doc:commit', stampEdited);
  document.addEventListener('collab:applied', () => { screenSigs = currentScreenSigs(); });
  // Closing the desktop window: the app runs this first and closes once it
  // resolves (see BEFORE_CLOSE in main.rs).
  window.__scaffoldBeforeClose = () => flushThumbnail();
}

// Bring the preview up to date before leaving the editor. Resolves quickly even
// if drawing stalls, so navigation is never held up for long.
export function flushThumbnail(timeout = 2500) {
  if (!projectId) return Promise.resolve();
  return Promise.race([updateThumbnail(), new Promise(r => setTimeout(r, timeout))]);
}


// ── which screens changed ──
function subtreeJson(node, seen = new Set()) {
  if (!node || seen.has(node.id)) return '';
  seen.add(node.id);
  // Where a screen sits on the canvas, and when it was edited, isn't its content.
  const { x, y, editedAt, ...rest } = node;
  const own = node.type === 'frame' ? rest : node;
  return JSON.stringify(own) + (node.children || []).map(id => subtreeJson(getNode(id), seen)).join('');
}

function screens() { return state.nodes.filter(isScreenFrame); }

function currentScreenSigs() {
  return new Map(screens().map(s => [s.id, subtreeJson(s)]));
}

function stampEdited() {
  if (state.collabApplying) return;
  const now = Date.now();
  const next = currentScreenSigs();
  let stamped = false;
  next.forEach((sig, id) => {
    if (screenSigs.get(id) !== sig) { getNode(id).editedAt = now; stamped = true; }
  });
  screenSigs = next;
  // Fold the stamp into the step just committed, so it isn't an undo step of its
  // own (the collaboration flush that follows sends it along).
  if (stamped) commitCurrent();
}

// The screens to show: most recently edited first; never-edited ones after,
// the app's first screen leading, then in reading order.
function pickScreens() {
  const pos = (s) => {
    const p = s.parentId ? getNode(s.parentId) : null;
    return { x: s.x + (p ? p.x : 0), y: s.y + (p ? p.y : 0) };
  };
  return screens().sort((a, b) =>
    ((b.editedAt || 0) - (a.editedAt || 0))
    || (Number(!!b.isInitial) - Number(!!a.isInitial))
    || (pos(a).y - pos(b).y) || (pos(a).x - pos(b).x)).slice(0, SHOWN);
}

async function fingerprint(shown) {
  const text = shown.map(s => s.id + subtreeJson(s)).join('|') + JSON.stringify([
    state.colors, state.typography, state.themes, state.activeThemeId, state.components, state.mockSets, LOOK,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── update: redraw + upload when the fingerprint moved ──
function updateThumbnail() {
  if (!projectId) return Promise.resolve();
  if (!running) running = doUpdate().catch(e => console.warn('thumbnail:', e)).finally(() => { running = null; });
  return running;
}

async function doUpdate() {
  const shown = pickScreens();
  if (!shown.length) return;
  const sig = await fingerprint(shown);
  if (sig === serverSig) return;
  const blob = await draw(shown);
  if (!blob) return;
  const res = await authedFetch(`/v1/project/${encodeURIComponent(projectId)}/thumbnail?sig=${sig}`, {
    method: 'POST', headers: { 'Content-Type': blob.type }, body: blob,
  });
  if (res.ok) serverSig = sig;
}

async function authedFetch(path, opts) {
  const api = (window.projectDomain || '') + '/api';
  const call = (t) => fetch(api + path, { ...opts, headers: { ...opts.headers, ...(t ? { Authorization: `Bearer ${t}` } : {}) } });
  const auth = getAuth();
  let res = await call(auth && auth.access_token);
  if (res.status === 401) { const fresh = await refreshToken(); if (fresh) res = await call(fresh); }
  return res;
}

// ── drawing ──
// Each screen is copied out of the canvas with its computed styles written
// inline, put in an SVG <foreignObject>, and drawn onto a canvas side by side.
async function draw(shown) {
  const shots = [];
  for (const s of shown) {
    const img = await snapshot(s).catch(e => { console.warn('thumbnail: screen', s.name, e); return null; });
    if (img) shots.push({ img, w: s.w, h: s.h });
  }
  if (!shots.length) return null;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, BACKDROP[0]); bg.addColorStop(1, BACKDROP[1]);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // Screens rise from the bottom edge: top part visible, the rest cropped.
  const gap = 28, top = 34, n = shots.length;
  const slot = (W - gap * (n + 1)) / n;
  const scales = shots.map(({ w, h }) => w <= h
    ? Math.min(slot, 210) / w                          // phone-like: fixed width
    : Math.min(slot / w, (H - top - gap) / h));        // wide: whole screen fits
  const widths = shots.map((s, i) => s.w * scales[i]);
  let x = (W - (widths.reduce((a, b) => a + b, 0) + gap * (n - 1))) / 2;
  shots.forEach(({ img, w, h }, i) => {
    const dw = widths[i], dh = h * scales[i];
    const r = Math.max(6, dw * 0.06);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
    ctx.beginPath(); ctx.roundRect(x, top, dw, dh, r); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, top, dw, dh, r); ctx.clip();
    ctx.drawImage(img, x, top, dw, dh);
    ctx.restore();
    x += dw + gap;
  });
  return new Promise(r => cv.toBlob(r, 'image/webp', 0.85));
}

async function snapshot(screen) {
  const el = document.getElementById('node-' + screen.id);
  if (!el) return null;
  const clone = copyStyled(el, null);
  Object.assign(clone.style, { position: 'relative', left: '0', top: '0', right: 'auto', bottom: 'auto', margin: '0', transform: 'none', boxShadow: 'none' });

  await inlineImages(clone);
  const fonts = await fontCss(clone);
  const w = Math.ceil(screen.w), h = Math.ceil(screen.h);
  const xml = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    + `<foreignObject x="0" y="0" width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden">`
    + (fonts ? `<style>${fonts.replace(/</g, '\\3c ')}</style>` : '')
    + xml + `</div></foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  return img;
}

// Editor-only parts of the canvas that don't belong in the picture.
const CHROME = /(^|\s)(sel-handles|screen-fold|frame-label|handle|radius-handle|comment-pin)(\s|$)/;

// Properties inherited from the parent (written only where they differ from it);
// every other property is written only where it differs from the tag's default.
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant',
  'font-stretch', 'font-feature-settings', 'font-variation-settings', 'font-kerning', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform', 'text-shadow',
  'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'tab-size', 'direction', 'visibility',
  'text-rendering', '-webkit-font-smoothing', '-webkit-text-fill-color', '-webkit-text-stroke-color',
  '-webkit-text-stroke-width', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'stroke-dasharray', 'stroke-miterlimit',
  'text-align-last', 'list-style-type', 'quotes', 'cursor', 'pointer-events', 'caret-color']);
// Left out: editor feedback, and the logical (block/inline) twins of physical
// properties — both are reported, and a stale twin would override the other.
const SKIP = /^(outline|transition|animation|cursor|caret|will-change|pointer-events|user-select|-webkit-user|inset|block-size|inline-size|(min|max)-(block|inline)|(border|margin|padding|overflow|scroll-margin|scroll-padding)-(block|inline)|--)/;

const defaults = new Map();
let sandbox = null;
function defaultStyle(src) {
  const key = src.namespaceURI + ' ' + src.localName;
  if (defaults.has(key)) return defaults.get(key);
  if (!sandbox) {
    // Probes live in a shadow root, out of reach of the page's own CSS (its reset
    // would otherwise pass for the browser default).
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:absolute;left:-99999px;top:0;visibility:hidden';
    document.body.appendChild(host);
    sandbox = host.attachShadow({ mode: 'open' });
  }
  const probe = document.createElementNS(src.namespaceURI, src.localName);
  const host = src.namespaceURI === 'http://www.w3.org/2000/svg' && src.localName !== 'svg'
    ? sandbox.appendChild(document.createElementNS(src.namespaceURI, 'svg')) : sandbox;
  host.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = {};
  for (let i = 0; i < cs.length; i++) out[cs[i]] = cs.getPropertyValue(cs[i]);
  (host === sandbox ? probe : host).remove();
  defaults.set(key, out);
  return out;
}

function copyStyled(src, parentStyle) {
  if (src.nodeType === Node.TEXT_NODE) return document.createTextNode(src.nodeValue);
  if (src.nodeType !== Node.ELEMENT_NODE) return null;
  const cls = typeof src.className === 'string' ? src.className : '';
  if (CHROME.test(cls) || (src.classList && src.classList.contains('cond-hidden'))) return null;

  const cs = getComputedStyle(src);
  const def = defaultStyle(src);
  const out = document.createElementNS(src.namespaceURI, src.localName);
  // SVG content keeps its geometry attributes (viewBox, d, points…).
  if (src.namespaceURI === 'http://www.w3.org/2000/svg') {
    for (const a of src.attributes) if (a.name !== 'class' && a.name !== 'style' && a.name !== 'id') out.setAttribute(a.name, a.value);
  }
  let css = '';
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    if (SKIP.test(p)) continue;
    const v = cs.getPropertyValue(p);
    const same = INHERITED.has(p) && parentStyle ? parentStyle.getPropertyValue(p) === v : (!INHERITED.has(p) && def[p] === v);
    if (!same) css += `${p}:${v};`;
  }
  // A repeat's empty template or a condition's dimming is editor feedback.
  if (src.parentElement && src.parentElement.classList.contains('repeat-empty')) css += 'opacity:1;';
  out.setAttribute('style', css);
  for (const child of src.childNodes) {
    const c = copyStyled(child, cs);
    if (c) out.appendChild(c);
  }
  return out;
}

// Pictures on the canvas are blob: URLs, which an SVG image can't load — swap
// each for a data: URL.
const dataUrls = new Map();
async function toDataUrl(url) {
  if (dataUrls.has(url)) return dataUrls.get(url);
  const blob = await (await fetch(url)).blob();
  const data = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result); fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
  dataUrls.set(url, data);
  return data;
}

async function inlineImages(root) {
  const els = [root, ...root.querySelectorAll('*')];
  for (const el of els) {
    const style = el.getAttribute('style') || '';
    const urls = [...style.matchAll(/url\("?((?:blob:|https?:)[^")]+)"?\)/g)].map(m => m[1]);
    if (!urls.length) continue;
    let next = style;
    for (const u of urls) {
      try { next = next.split(u).join(await toDataUrl(u)); }
      catch { next = next.split(`url("${u}")`).join('none'); } // unreachable → leave it out
    }
    el.setAttribute('style', next);
  }
}

// Google Fonts the screen uses, embedded (Latin subset) so text keeps its face.
const cssCache = new Map();
async function fontCss(root) {
  const families = new Set();
  [root, ...root.querySelectorAll('*')].forEach(el => {
    const m = /font-family:([^;]+);/.exec(el.getAttribute('style') || '');
    if (m) m[1].split(',').forEach(f => families.add(f.trim().replace(/^["']|["']$/g, '')));
  });
  let out = '';
  for (const href of googleFontSheets()) {
    try {
      if (!cssCache.has(href)) cssCache.set(href, await (await fetch(href)).text());
      const faces = cssCache.get(href).match(/@font-face\s*{[^}]*}/g) || [];
      for (const face of faces) {
        const fam = /font-family:\s*['"]?([^;'"]+)/.exec(face);
        if (!fam || !families.has(fam[1].trim()) || !/unicode-range:[^;]*U\+0000-00FF/i.test(face)) continue;
        const src = /url\(([^)]+)\)/.exec(face);
        if (!src) continue;
        out += face.replace(src[1], await toDataUrl(src[1].replace(/["']/g, '')));
      }
    } catch { /* the default face will do */ }
  }
  return out;
}

// Every Google Fonts stylesheet on the page: <link>ed ones, and @imported ones
// (the app's own UI fonts, which designs default to).
function googleFontSheets() {
  const out = new Set();
  const isFonts = (h) => h && h.includes('fonts.googleapis.com');
  document.querySelectorAll('link[href*="fonts.googleapis.com"]').forEach(l => out.add(l.href));
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; } // another origin's sheet
    for (const r of rules) if (r instanceof CSSImportRule && isFonts(r.href)) out.add(r.href);
  }
  return out;
}
