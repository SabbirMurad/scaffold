// Presentation export: the open page's screens as a PDF deck to show clients and
// investors. 16:9 slides:
//   1. a cover — the project's name, a few of its screens;
//   2. the flow — every screen where it sits on the canvas, with the prototype
//      links (the Connect tool's arrows) from each linking element to its screen;
//   3. a slide per screen — large, the linking elements numbered on it, with
//      where each goes and which screens lead here.
//
// So that it stays sharp when zoomed into, a slide is layered: its background
// and words are a picture (drawn on a canvas, in the app's fonts, at twice the
// page's resolution); each screen is a picture of its own on top, at up to 3×
// its size (stored once however many slides show it); the arrows and numbered
// markers are drawn as PDF shapes over those.

import { state, getNode } from './state.js';
import { isScreenFrame, isOverlayFrame, overlayLabel, getWorldPos } from './nodes.js';
import { activePage } from './pages.js';
import { snapshot } from './thumbnail.js';
import { pdfDocument, jpegOf, roundRectPath, circlePath, rgb, pdfNum as n } from './pdf.js';
import { saveFile } from './save-file.js';
import { fileName } from './frame-export.js';
import { routeOf } from './codegen.js';

const W = 1920, H = 1080;          // a slide, in layout units
const PAGE = { w: 960, h: 540 };    // …and in PDF points
const PT = PAGE.w / W;              // points a unit
const BASE = 2;                     // background canvas pixels a unit
const C = {
  bg: '#0f1115', bg2: '#161a21', text: '#f2f3f5', dim: '#9aa0aa', faint: '#5d636e',
  line: 'rgba(255,255,255,0.10)', accent: '#1ECC7A', onAccent: '#06140d',
};
const FONT = "'IBM Plex Sans', system-ui, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, monospace";

// Build the deck and save it. `progress(text)` hears how far along it is.
// Resolves to { name, inApp, slides }.
export async function exportPresentation(progress = () => {}) {
  const screens = pageScreens();
  if (!screens.length) throw new Error('This page has no screens to present');
  await Promise.all([document.fonts.load(`700 40px ${FONT}`), document.fonts.load(`400 40px ${FONT}`), document.fonts.load(`400 20px ${MONO}`)]).catch(() => {});

  // Each screen drawn once, at up to 3× (within what a canvas holds), and kept
  // as an image of the document.
  const images = [];
  const shots = new Map(); // screen id → { index, w, h }
  for (const [i, s] of screens.entries()) {
    progress(`Drawing screens… ${i + 1}/${screens.length}`);
    const k = Math.max(0.5, Math.min(3, 4000 / s.w, 16000 / s.h, Math.sqrt(60e6 / (s.w * s.h))));
    const img = await snapshot(s, k).catch(e => { console.warn('presentation:', s.name, e); return null; });
    if (!img) continue;
    const cv = document.createElement('canvas');
    cv.width = Math.round(s.w * k); cv.height = Math.round(s.h * k);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    images.push({ jpeg: await jpegOf(cv, 0.92), w: cv.width, h: cv.height });
    shots.set(s.id, { index: images.length - 1, w: s.w, h: s.h });
  }
  const shown = screens.filter(s => shots.has(s.id));
  if (!shown.length) throw new Error('Couldn’t draw the screens');
  const links = pageLinks(shown);

  const slides = [];
  const add = async (draw) => {
    const cv = document.createElement('canvas');
    cv.width = W * BASE; cv.height = H * BASE;
    const ctx = cv.getContext('2d');
    ctx.scale(BASE, BASE);
    background(ctx);
    layer = [];
    draw(ctx);
    images.push({ jpeg: await jpegOf(cv, 0.9), w: cv.width, h: cv.height });
    const base = images.length - 1;
    slides.push({
      w: PAGE.w, h: PAGE.h,
      images: [base, ...layer.filter(o => o.image != null).map(o => o.image)],
      content: [`q ${n(PAGE.w)} 0 0 ${n(PAGE.h)} 0 0 cm /I${base} Do Q`, ...layer.map(o => o.ops)].join('\n'),
    });
  };
  const project = state.projectName || 'Untitled';
  const page = activePage();
  const total = shown.length + 2;
  progress('Making slides…');
  await add(ctx => coverSlide(ctx, project, page, shown, shots));
  await add(ctx => { flowSlide(ctx, shown, shots, links); footer(ctx, project, 2, total); });
  for (const [i, s] of shown.entries()) {
    progress(`Making slides… ${i + 3}/${total}`);
    await add(ctx => { screenSlide(ctx, s, shots.get(s.id), links); footer(ctx, project, i + 3, total); });
  }

  progress('Saving…');
  const blob = pdfDocument({ images, pages: slides });
  let name = `${fileName(project)}${page && state.pages.length > 1 ? ' – ' + fileName(page.name) : ''} presentation.pdf`;
  const path = await saveFile(blob, name);
  if (path) name = path.split(/[\\/]/).pop();
  return { name, inApp: !!path, slides: slides.length };
}

// ── what's presented ──────────────────────────────────────────────────────────
// The open page's screens that are drawn: the start screen first, then in
// reading order; overlays (dialogs, sheets, menus) after the screens.
function pageScreens() {
  const pos = (s) => getWorldPos(s);
  return state.nodes
    .filter(n => isScreenFrame(n) && topOf(n).pageId === state.activePageId && document.getElementById('node-' + n.id))
    .sort((a, b) => (Number(isOverlayFrame(a)) - Number(isOverlayFrame(b)))
      || (Number(!!b.isInitial) - Number(!!a.isInitial))
      || (pos(a).y - pos(b).y) || (pos(a).x - pos(b).x));
}

function topOf(node) {
  let n = node;
  while (n && n.parentId) n = getNode(n.parentId);
  return n || {};
}

function screenOf(node) {
  let n = node;
  while (n && !isScreenFrame(n)) n = n.parentId ? getNode(n.parentId) : null;
  return n;
}

// Every prototype link between the presented screens: from an element (where
// it is in its screen) to a screen. Numbered per source screen.
function pageLinks(screens) {
  const ids = new Set(screens.map(s => s.id));
  const out = [];
  const count = new Map();
  for (const n of state.nodes) {
    if (!n.action || n.action.type !== 'navigate') continue;
    const from = screenOf(n);
    if (!from || !ids.has(from.id)) continue;
    const targets = [];
    if (n.action.targetFrameId) targets.push({ id: n.action.targetFrameId, conditional: false });
    (n.action.routes || []).forEach(r => { if (r && r.target) targets.push({ id: r.target, conditional: true }); });
    for (const t of targets) {
      if (!ids.has(t.id) || t.id === from.id) continue;
      const num = (count.get(from.id) || 0) + 1;
      count.set(from.id, num);
      out.push({ from: from.id, to: t.id, conditional: t.conditional, num, rect: rectIn(n, from), label: elementLabel(n) });
    }
  }
  return out;
}

// Where an element is inside its screen, in the screen's own units.
function rectIn(node, screen) {
  const el = document.getElementById('node-' + node.id), sc = document.getElementById('node-' + screen.id);
  if (!el || !sc) return null;
  const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
  if (!r.width && !r.height) return null; // hidden (another tab, a closed state)
  const z = state.zoom || 1;
  return { x: (r.left - s.left) / z, y: (r.top - s.top) / z, w: r.width / z, h: r.height / z };
}

// What a person would call the element: its text, else its name tidied up.
function elementLabel(node) {
  const el = document.getElementById('node-' + node.id);
  const text = el ? (el.innerText || '').trim().split('\n').map(t => t.trim()).find(Boolean) : '';
  if (text && text.length <= 36) return `“${text}”`;
  return pretty(node.name || 'Element');
}

// "home_page" → "Home page", "shopDetail" → "Shop Detail".
function pretty(name) {
  const s = String(name).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Untitled';
}

// A web page (desktop width) rather than a phone screen — by width, not shape:
// a long web page is taller than it's wide too.
const isWeb = (s) => s.w >= 700;
// How much of a screen the overview slides show: a web page above the fold.
const foldOf = (s) => (isWeb(s) ? Math.min(s.h, Math.round(s.w * 0.75)) : s.h);

const kindOf = (s) => isOverlayFrame(s) ? overlayLabel(s) : (routeOf(s) || '');
const nameOf = (id) => pretty((getNode(id) || {}).name || 'Screen');

// ── drawing helpers ───────────────────────────────────────────────────────────
function background(ctx) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, C.bg2); g.addColorStop(1, C.bg);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function text(ctx, str, x, y, { size = 28, weight = 400, color = C.text, max = Infinity, font = FONT, align = 'left' } = {}) {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  let s = String(str);
  if (ctx.measureText(s).width > max) {
    while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
    s += '…';
  }
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}

// What goes over the slide's background, in order: { ops, image? }.
let layer = [];
// Layout units (origin top-left) → points (origin bottom-left).
const px = (x) => x * PT;
const py = (y) => (H - y) * PT;

// Part of a screen (`src`, in screen units) at x,y, `scale` times: its shadow
// on the background, the screen itself (clipped to its rounded corners) on top.
function drawShot(ctx, shot, src, x, y, scale, radius) {
  const dw = src.w * scale, dh = src.h * scale;
  if (shot.w >= 700) radius = Math.min(radius, 10); // a web page: a window's corners, not a phone's
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 14;
  ctx.beginPath(); ctx.roundRect(x, y, dw, dh, radius); ctx.fillStyle = C.bg2; ctx.fill();
  ctx.restore();
  // The whole screen image, placed so `src` lands on x,y; the clip shows `src`.
  const fx = x - src.x * scale, fy = y - src.y * scale, fw = shot.w * scale, fh = shot.h * scale;
  layer.push({
    image: shot.index,
    ops: [
      'q',
      roundRectPath(px(x), py(y + dh), dw * PT, dh * PT, radius * PT),
      'W n',
      `${n(fw * PT)} 0 0 ${n(fh * PT)} ${n(px(fx))} ${n(py(fy + fh))} cm`,
      `/I${shot.index} Do`,
      'Q',
    ].join('\n'),
  });
}

// A numbered marker over a screen (a shape on top, sharp at any zoom).
function marker(num, x, y, r = 18) {
  const label = String(num), size = r * 1.05 * PT;
  const tw = label.length * 0.556 * size; // Helvetica Bold's digits are all this wide
  layer.push({
    ops: [
      'q',
      `${rgb(C.accent)} rg`, circlePath(px(x), py(y), r * PT), 'f',
      `1 1 1 RG ${n(2.5 * PT)} w`, circlePath(px(x), py(y), r * PT), 'S',
      `BT /F1 ${n(size)} Tf ${rgb(C.onAccent)} rg ${n(px(x) - tw / 2)} ${n(py(y) - size * 0.36)} Td (${label}) Tj ET`,
      'Q',
    ].join('\n'),
  });
}

function badge(ctx, n, x, y, r = 18) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 10;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = C.accent; ctx.fill();
  ctx.restore();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.font = `700 ${Math.round(r * 1.05)}px ${FONT}`;
  ctx.fillStyle = C.onAccent; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(n), x, y + 1);
}

function footer(ctx, project, n, total) {
  text(ctx, project, 100, H - 48, { size: 20, color: C.faint, max: 900 });
  text(ctx, `${n} / ${total}`, W - 100, H - 48, { size: 20, color: C.faint, align: 'right' });
}

// ── 1. cover ──────────────────────────────────────────────────────────────────
function coverSlide(ctx, project, page, screens, shots) {
  const glow = ctx.createRadialGradient(W * 0.78, H * 0.55, 40, W * 0.78, H * 0.55, 900);
  glow.addColorStop(0, 'rgba(30,204,122,0.16)'); glow.addColorStop(1, 'rgba(30,204,122,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = C.accent; ctx.fillRect(120, 352, 64, 6);
  text(ctx, project, 120, 470, { size: 92, weight: 700, max: 820 });
  const count = screens.filter(s => !isOverlayFrame(s)).length;
  const sub = [page && state.pages.length > 1 ? page.name : null, `${count} screen${count === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  text(ctx, sub, 122, 540, { size: 34, color: C.dim, max: 820 });
  text(ctx, new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), 122, 592, { size: 26, color: C.faint });

  // A few screens, rising from the bottom edge.
  const picks = screens.filter(s => !isOverlayFrame(s)).slice(0, 3);
  const area = { x: 1000, w: 820, top: 170 };
  const wide = picks.some(isWeb);
  const list = wide ? picks.slice(0, 1) : picks;
  const gap = 36;
  const each = wide ? area.w : Math.min(300, (area.w - gap * (list.length - 1)) / list.length);
  let x = area.x + (area.w - (each * list.length + gap * (list.length - 1))) / 2;
  list.forEach((s, i) => {
    const scale = each / s.w;
    const top = wide ? 250 : area.top + (i === 1 ? -40 : 30);
    const visible = Math.min(s.h, (H - top) / scale);
    drawShot(ctx, shots.get(s.id), { x: 0, y: 0, w: s.w, h: visible }, x, top, scale, Math.max(10, each * 0.07));
    x += each + gap;
  });
}

// ── 2. the flow ───────────────────────────────────────────────────────────────
function flowSlide(ctx, screens, shots, links) {
  text(ctx, links.length ? 'User flow' : 'Screens', 100, 140, { size: 52, weight: 700 });
  text(ctx, links.length ? 'How the screens connect — each arrow is a tap that leads to another screen.' : 'Every screen in this design.', 100, 192, { size: 26, color: C.dim, max: 1700 });

  const area = { x: 100, y: 260, w: W - 200, h: H - 260 - 110 };
  const rects = screens.map(s => ({ s, ...getWorldPos(s), w: s.w, h: foldOf(s) }));
  const minX = Math.min(...rects.map(r => r.x)), minY = Math.min(...rects.map(r => r.y));
  const maxX = Math.max(...rects.map(r => r.x + r.w)), maxY = Math.max(...rects.map(r => r.y + r.h));
  const LABEL = 30; // room for each screen's name above it
  const scale = Math.min(area.w / (maxX - minX), (area.h - LABEL) / (maxY - minY), 0.6);
  const ox = area.x + (area.w - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = area.y + LABEL + (area.h - LABEL - (maxY - minY) * scale) / 2 - minY * scale;
  const at = new Map(rects.map(r => [r.s.id, { x: ox + r.x * scale, y: oy + r.y * scale, w: r.w * scale, h: r.h * scale }]));

  for (const r of rects) {
    const p = at.get(r.s.id);
    drawShot(ctx, shots.get(r.s.id), { x: 0, y: 0, w: r.w, h: r.h }, p.x, p.y, scale, Math.max(4, p.w * 0.05));
    text(ctx, pretty(r.s.name), p.x, p.y - 10, { size: Math.max(14, Math.min(20, p.w / 9)), weight: 600, color: C.dim, max: Math.max(p.w, 120) });
  }
  for (const l of links) {
    const from = at.get(l.from), to = at.get(l.to);
    const src = l.rect
      ? clipTo({ x: from.x + l.rect.x * scale, y: from.y + l.rect.y * scale, w: l.rect.w * scale, h: l.rect.h * scale }, from)
      : from;
    const sc = center(src), tc = center(to);
    arrow(edgePoint(src, tc.x, tc.y), edgePoint(to, sc.x, sc.y), l.conditional);
  }
}

// A rect kept within another (an element below a web page's fold starts its
// arrow from the bottom edge of what's shown).
function clipTo(r, box) {
  const x = Math.max(box.x, Math.min(r.x, box.x + box.w)), y = Math.max(box.y, Math.min(r.y, box.y + box.h));
  return { x, y, w: Math.max(0, Math.min(r.x + r.w, box.x + box.w) - x), h: Math.max(0, Math.min(r.y + r.h, box.y + box.h) - y) };
}

const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
// Where the line from a rect's center toward (tx,ty) leaves it (as flow.js).
function edgePoint(r, tx, ty) {
  const c = center(r), dx = tx - c.x, dy = ty - c.y;
  if (!dx && !dy) return c;
  const s = Math.min(dx ? (r.w / 2) / Math.abs(dx) : Infinity, dy ? (r.h / 2) / Math.abs(dy) : Infinity);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

// The canvas's arrow: a curve with level handles, a dot where it starts —
// shapes over the screens.
function arrow(a, b, dashed) {
  const k = Math.max(30, Math.min(140, Math.abs(b.x - a.x) * 0.5));
  const dir = b.x >= a.x ? 1 : -1;
  const c1 = { x: a.x + dir * k, y: a.y }, c2 = { x: b.x - dir * k, y: b.y };
  const ang = Math.atan2(b.y - c2.y, b.x - c2.x), L = 16;
  const p = (pt) => `${n(px(pt.x))} ${n(py(pt.y))}`;
  const tip1 = { x: b.x - L * Math.cos(ang - 0.45), y: b.y - L * Math.sin(ang - 0.45) };
  const tip2 = { x: b.x - L * Math.cos(ang + 0.45), y: b.y - L * Math.sin(ang + 0.45) };
  // The line stops at the arrowhead's base, so its round end doesn't poke through.
  const end = { x: b.x - L * 0.8 * Math.cos(ang), y: b.y - L * 0.8 * Math.sin(ang) };
  layer.push({
    ops: [
      'q',
      `${rgb(C.accent)} RG ${rgb(C.accent)} rg ${n(3.5 * PT)} w 1 J`,
      dashed ? `[${n(12 * PT)} ${n(9 * PT)}] 0 d` : '',
      `${p(a)} m ${p(c1)} ${p(c2)} ${p(end)} c S`,
      '[] 0 d',
      `${p(b)} m ${p(tip1)} l ${p(tip2)} l h f`,
      circlePath(px(a.x), py(a.y), 6 * PT), 'f',
      `${rgb(C.bg)} RG ${n(2 * PT)} w`, circlePath(px(a.x), py(a.y), 6 * PT), 'S',
      'Q',
    ].filter(Boolean).join('\n'),
  });
}

// ── 3. a screen ───────────────────────────────────────────────────────────────
function screenSlide(ctx, s, shot, links) {
  const area = { x: 100, y: 90, w: 1000, h: H - 90 - 110 };
  const w = s.w, h = s.h;
  const tall = w < 700 && h / w > 1.2;
  // A tall phone screen is cut into columns side by side (up to three) so all
  // of it shows; a wide one shows from its top, as far as fits.
  let cols = 1, segH = h, scale;
  if (tall) {
    // As few columns as show it nearly as big as the best split would.
    const fit = (n) => Math.min(area.h / Math.ceil(h / n), (area.w - 40 * (n - 1)) / (w * n), 1.6);
    const best = Math.max(fit(1), fit(2), fit(3));
    cols = [1, 2, 3].find(n => fit(n) >= best * 0.8);
    segH = Math.ceil(h / cols);
    scale = fit(cols);
  } else {
    scale = Math.min(area.w / w, area.h / Math.min(h, w), 1.6);
    segH = Math.min(h, area.h / scale);
  }
  const gap = 40;
  const total = w * scale * cols + gap * (cols - 1);
  const x0 = area.x + (area.w - total) / 2;
  const colH = Math.min(segH, h) * scale;
  const y0 = area.y + (area.h - colH) / 2;
  const colX = (k) => x0 + k * (w * scale + gap);
  for (let k = 0; k < cols; k++) {
    const sy = k * segH;
    const sh = Math.min(segH, h - sy);
    if (sh <= 0) break;
    drawShot(ctx, shot, { x: 0, y: sy, w, h: sh }, colX(k), y0, scale, Math.max(8, w * scale * 0.06));
  }

  // The linking elements, numbered where they are.
  const mine = links.filter(l => l.from === s.id);
  // At each one's top-right corner, kept inside the screen.
  const R = 18;
  for (const l of mine) {
    if (!l.rect) continue;
    const k = tall ? Math.min(cols - 1, Math.floor(l.rect.y / segH)) : 0;
    if (!tall && l.rect.y > segH) continue;
    // Inside the corner of a big element (a card), on the corner of a small one.
    const big = l.rect.w * scale > R * 5 && l.rect.h * scale > R * 4;
    const inset = big ? R + 8 : 4;
    const bx = colX(k) + (l.rect.x + l.rect.w) * scale - inset;
    const by = y0 + (l.rect.y - k * segH) * scale + (big ? R + 8 : 4);
    marker(l.num,
      Math.min(Math.max(bx, colX(k) + R + 4), colX(k) + w * scale - R - 4),
      Math.min(Math.max(by, y0 + R + 4), y0 + colH - R - 4), R);
  }

  // Beside it: what it is, where it leads, where it's reached from.
  const px = 1200, pw = W - px - 100;
  let y = 200;
  const section = s.parentId ? getNode(s.parentId) : null;
  if (section && section.type === 'section') { text(ctx, pretty(section.name).toUpperCase(), px, y, { size: 20, weight: 600, color: C.faint, max: pw }); y += 58; }
  text(ctx, pretty(s.name), px, y, { size: 54, weight: 700, max: pw });
  y += 52;
  const meta = [kindOf(s), s.isInitial ? 'Start screen' : null].filter(Boolean).join(' · ');
  if (meta) { text(ctx, meta, px, y, { size: 24, color: C.dim, max: pw, font: isOverlayFrame(s) ? FONT : MONO }); y += 30; }
  y += 50;

  if (mine.length) {
    text(ctx, 'GOES TO', px, y, { size: 18, weight: 600, color: C.faint }); y += 46;
    const room = Math.floor((H - 330 - y) / 50);
    mine.slice(0, room).forEach(l => {
      badge(ctx, l.num, px + 16, y - 9, 16);
      const lw = text(ctx, l.label, px + 48, y, { size: 26, max: pw * 0.55 });
      text(ctx, `→  ${nameOf(l.to)}${l.conditional ? ' (sometimes)' : ''}`, px + 48 + lw + 14, y, { size: 26, color: C.accent, max: pw - 62 - lw });
      y += 50;
    });
    if (mine.length > room) { text(ctx, `+ ${mine.length - room} more`, px + 48, y, { size: 22, color: C.dim }); y += 40; }
    y += 30;
  }
  const from = [...new Set(links.filter(l => l.to === s.id).map(l => l.from))];
  if (from.length) {
    text(ctx, 'REACHED FROM', px, y, { size: 18, weight: 600, color: C.faint }); y += 46;
    const room = Math.max(1, Math.floor((H - 160 - y) / 42));
    from.slice(0, room).forEach(id => { text(ctx, nameOf(id), px, y, { size: 26, color: C.dim, max: pw }); y += 42; });
    if (from.length > room) text(ctx, `+ ${from.length - room} more`, px, y, { size: 22, color: C.faint });
  }
  if (!mine.length && !from.length) text(ctx, 'Not linked to other screens yet.', px, y, { size: 24, color: C.faint, max: pw });
}
