import { state, makeNode, makeColorValue } from './state.js';
import { parseFigBuffer, figTree, guidKey } from './figkiwi.js';

// Maps a decoded Figma clipboard tree (figkiwi.js) onto Scaffold nodes:
//   • root FRAMEs → screen frames (snake_case name + unique route)
//   • nested frames/groups/instances → containers; auto-layout → row/column/wrap,
//     no auto-layout → free-positioned (stack), grow/stretch → fill, fit → hug
//   • TEXT → text nodes; RECT/ELLIPSE → containers; image fills → image nodes
//   • every solid fill / stroke / text colour is deduped into a colour variable
//     (reusing an existing one when the value matches), and every distinct text
//     style becomes a typography style — so theming "just works" after a paste
// Vector shapes (VECTOR, STAR, BOOLEAN_OPERATION…) import as plain boxes for now.
//
// Kept pure (imports state.js only) so the whole pipeline is testable in Node;
// the clipboard event wiring lives in tools.js.

const clone = (o) => JSON.parse(JSON.stringify(o));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── colour helpers ──

function rgbaToHex(c) {
  const h = (x) => Math.max(0, Math.min(255, Math.round((x || 0) * 255))).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

// Find-or-create a colour variable for a solid value. Matches against the active
// theme's mirror (so a pasted #ffffff reuses the seeded `white`); new variables
// get the same value under every theme — the user diverges them later.
function ensureColor(ctx, hex, alpha = 1) {
  hex = (hex || '#000000').toLowerCase();
  const found = state.colors.find(c =>
    c.fillType === 'solid' && (c.fill || '').toLowerCase() === hex
    && Math.abs((c.alpha == null ? 1 : c.alpha) - alpha) < 0.01);
  if (found) return found.id;
  const values = {};
  state.themes.forEach(t => { const v = makeColorValue(hex); v.alpha = alpha; values[t.id] = v; });
  // Colour names must be camelCase alphanumeric: "#1e1e2e" → c1e1e2e (+ alpha pct).
  let name = 'c' + hex.slice(1) + (alpha < 0.995 ? 'a' + Math.round(alpha * 100) : '');
  while (state.colors.some(c => c.name === name)) name += 'x';
  const active = values[state.activeThemeId] || makeColorValue(hex);
  const c = { id: 'c' + (state.nextColorId++), name, values, fillType: 'solid', fill: hex, alpha, gradient: clone(active.gradient) };
  state.colors.push(c);
  ctx.newColors++;
  return c.id;
}

// The topmost visible paint (Figma stores fills bottom→top).
function topPaint(paints) {
  const vis = (paints || []).filter(p => p && p.visible !== false);
  return vis.length ? vis[vis.length - 1] : null;
}

// ── Figma variables → colour variables ──
// A paint bound to a Figma colour variable carries `colorVar` (an alias to a
// VARIABLE node, shipped on the internal canvas) besides its resolved `color`.
// The variable's per-mode values map straight onto Scaffold's per-theme model:
// its "Dark"/"Light" modes (matched by name against each theme's brightness)
// become that colour's per-theme values, and the variable's own name becomes the
// colour name ("Labels/Primary" → labelsPrimary).

function buildVarIndex(message) {
  const byKey = new Map(), byGuid = new Map(), sets = new Map();
  (message.nodeChanges || []).forEach(n => {
    if (n.type === 'VARIABLE') {
      if (n.key) byKey.set(n.key, n);
      byGuid.set(guidKey(n.guid), n);
    } else if (n.type === 'VARIABLE_SET') {
      if (n.key) sets.set(n.key, n);
      sets.set(guidKey(n.guid), n);
    }
  });
  return { byKey, byGuid, sets };
}

// The variable's colour entry for a theme brightness: prefer the mode literally
// named after it ("Dark"), then a prefixed ("Dark Elevated") or containing name,
// else the first mode (single-mode collections like "Mode 1").
function themeModeEntry(variable, set, brightness) {
  const entries = (((variable.variableDataValues || {}).entries) || [])
    .filter(e => e.variableData && e.variableData.value && e.variableData.value.colorValue);
  if (!entries.length) return null;
  const byMode = new Map(entries.map(e => [guidKey(e.modeID), e]));
  const modes = ((set && set.variableSetModes) || []).filter(m => byMode.has(guidKey(m.id)));
  const match = (test) => {
    const m = modes.find(x => test(String(x.name || '').toLowerCase()));
    return m ? byMode.get(guidKey(m.id)) : null;
  };
  return match(n => n === brightness) || match(n => n.startsWith(brightness))
    || match(n => n.includes(brightness)) || entries[0];
}

// Resolve a paint's variable alias into a colour variable id (cached per
// variable), or null when the paint isn't variable-bound / can't be resolved.
function resolveVarColor(ctx, paint) {
  const alias = paint.colorVar && paint.colorVar.value && paint.colorVar.value.alias;
  if (!alias) return null;
  const v = (alias.assetRef && ctx.vars.byKey.get(alias.assetRef.key))
    || (alias.guid && ctx.vars.byGuid.get(guidKey(alias.guid))) || null;
  if (!v) return null;
  const ck = v.key || guidKey(v.guid);
  if (ctx.varCache.has(ck)) return ctx.varCache.get(ck);

  const setRef = v.variableSetID || {};
  const set = (setRef.assetRef && ctx.vars.sets.get(setRef.assetRef.key))
    || (setRef.guid && ctx.vars.sets.get(guidKey(setRef.guid))) || null;
  const op = paint.opacity == null ? 1 : paint.opacity;
  const values = {};
  state.themes.forEach(t => {
    const e = themeModeEntry(v, set, t.brightness);
    if (!e) return;
    const c = e.variableData.value.colorValue;
    const val = makeColorValue(rgbaToHex(c));
    val.alpha = round2((c.a == null ? 1 : c.a) * op);
    values[t.id] = val;
  });
  if (!Object.keys(values).length) { ctx.varCache.set(ck, null); return null; }

  const name = camelName(v.name);
  // Same variable pasted before (or twice in one paste) → reuse by name.
  const existing = state.colors.find(c => c.name === name);
  if (existing) { ctx.varCache.set(ck, existing.id); return existing.id; }

  const active = values[state.activeThemeId] || Object.values(values)[0];
  state.themes.forEach(t => { if (!values[t.id]) values[t.id] = clone(active); });
  const c = { id: 'c' + (state.nextColorId++), name, values, fillType: 'solid', fill: active.fill, alpha: active.alpha, gradient: clone(active.gradient) };
  state.colors.push(c);
  ctx.newColors++;
  ctx.varCache.set(ck, c.id);
  return c.id;
}

// A solid paint's colour variable id: the bound Figma variable when there is
// one, else a value-deduped variable from the resolved hex.
function solidColorId(ctx, paint) {
  const varId = resolveVarColor(ctx, paint);
  if (varId) return varId;
  const { hex, alpha } = paintSolid(paint);
  return ensureColor(ctx, hex, alpha);
}

// paint {color, opacity} → {hex, alpha} with the paint's own opacity baked in.
function paintSolid(paint) {
  const c = paint.color || { r: 0, g: 0, b: 0, a: 1 };
  const alpha = round2((c.a == null ? 1 : c.a) * (paint.opacity == null ? 1 : paint.opacity));
  return { hex: rgbaToHex(c), alpha };
}

// CSS-style gradient angle (0 = up, 90 = right) from a Figma gradient transform,
// which maps object space → gradient space; invert it and see where the gradient
// axis (0,0.5)→(1,0.5) lands in the object, scaled by the node's size.
function gradientAngle(t, w, h) {
  if (!t) return 180; // Figma's default gradient runs top → bottom
  const det = t.m00 * t.m11 - t.m01 * t.m10;
  if (!det) return 180;
  const ia = t.m11 / det, ib = -t.m01 / det, ic = -t.m10 / det, id = t.m00 / det;
  const ie = (t.m01 * t.m12 - t.m11 * t.m02) / det;
  const if_ = (t.m10 * t.m02 - t.m00 * t.m12) / det;
  const dx = (ia * 1 + ib * 0.5 + ie - (ia * 0 + ib * 0.5 + ie)) * (w || 1);
  const dy = (ic * 1 + id * 0.5 + if_ - (ic * 0 + id * 0.5 + if_)) * (h || 1);
  const ang = Math.atan2(dx, -dy) * 180 / Math.PI;
  return Math.round(((ang % 360) + 360) % 360);
}

function gradientFromPaint(paint, w, h) {
  const op = paint.opacity == null ? 1 : paint.opacity;
  const stops = (paint.stops || []).map(s => ({
    color: rgbaToHex(s.color || { r: 0, g: 0, b: 0 }),
    alpha: round2(((s.color && s.color.a) == null ? 1 : s.color.a) * op),
    pos: Math.round((s.position || 0) * 100),
  }));
  if (stops.length < 2) stops.push({ color: '#ffffff', alpha: 1, pos: 100 });
  return { angle: gradientAngle(paint.transform, w, h), stops };
}

// ── typography helpers ──

const WEIGHT_MAP = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
  regular: 400, normal: 400, book: 400, text: 400, medium: 500,
  semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800,
  black: 900, heavy: 900,
};
function weightFromStyle(style) {
  const s = String(style || '').toLowerCase().replace(/\s+/g, '').replace(/italic$/, '');
  const w = WEIGHT_MAP[s] || (/^\d+$/.test(s) ? +s : 400);
  return Math.min(700, Math.max(300, Math.round(w / 100) * 100)); // clamp to the UI's 300–700 range
}

// Figma "Number" values ({value, units}) → a plain number in the given context.
function numVal(v, dflt = 0) {
  if (v == null) return dflt;
  if (typeof v === 'number') return v;
  return typeof v.value === 'number' ? v.value : dflt;
}
function lineHeightMul(lh, fontSize) {
  if (!lh || typeof lh === 'number') return 1.2;
  if (lh.units === 'PERCENT') return round2((lh.value || 100) / 100);
  if (lh.units === 'PIXELS' && fontSize) return round2(lh.value / fontSize);
  if (lh.units === 'RAW') return round2(lh.value || 1.2);
  return 1.2;
}
function letterSpacingPx(ls, fontSize) {
  if (!ls) return 0;
  if (typeof ls === 'number') return round2(ls);
  if (ls.units === 'PERCENT') return round2((fontSize || 14) * (ls.value || 0) / 100);
  return round2(ls.value || 0);
}

const camelName = (s) => {
  const w = String(s || 'font').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const j = w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join('');
  return /^[a-z]/.test(j) ? j : 'f' + j;
};

// Find-or-create a typography style for (family, size, weight, lh, ls, colour).
function ensureTypo(ctx, { family, size, weight, lineHeight, letterSpacing, colorId }) {
  const found = state.typography.find(t =>
    t.fontFamily === family && t.fontSize === size && t.fontWeight === String(weight)
    && Math.abs((t.lineHeight || 0) - lineHeight) < 0.01
    && Math.abs((t.letterSpacing || 0) - letterSpacing) < 0.01
    && (t.colorId || null) === (colorId || null));
  if (found) return found.id;
  let name = camelName(family) + Math.round(size) + 'w' + weight; // e.g. inter14w400
  while (state.typography.some(t => t.name === name)) name += 'x';
  const t = { id: 't' + (state.nextTypoId++), name, fontFamily: family, fontSize: size, fontWeight: String(weight), lineHeight, letterSpacing, colorId: colorId || null };
  state.typography.push(t);
  ctx.newTypos++;
  return t.id;
}

// ── name / route helpers (screen frames need snake_case + a unique route) ──

function uniqueFrameName(figName) {
  let n = String(figName || 'frame').trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_{2,}/g, '_');
  if (!n) n = 'frame';
  if (/^[0-9]/.test(n)) n = 'frame_' + n;
  const base = n;
  for (let i = 2; state.nodes.some(nd => nd.type === 'frame' && nd.name === n); i++) n = base + '_' + i;
  return n;
}
function uniqueRoute(name) {
  let r = '/' + name.replace(/_/g, '-');
  const base = r;
  for (let i = 2; state.nodes.some(nd => nd.type === 'frame' && nd.routePath === r); i++) r = base + '-' + i;
  return r;
}

// ── image helpers ──

function sniffMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'image/png';
}
function bytesToDataUri(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${sniffMime(bytes)};base64,` + btoa(s);
}
const hashHex = (bytes) => [...(bytes || [])].map(b => b.toString(16).padStart(2, '0')).join('');

// ── vector networks → inline SVG icons ──
// Figma ships shape geometry as a "vector network" blob: vertices, cubic-bezier
// segments (tangents relative to their vertices; all-zero tangents = straight
// line), and regions (closed loops of segment indices). Decoding it lets pasted
// icons become real icon nodes — the same inline-SVG kind the icon tool makes —
// instead of empty boxes. Verified against real payloads; layout (all LE):
//   u32 vertexCount, u32 segmentCount, u32 regionCount
//   vertices: (u32 styleId, f32 x, f32 y) ×N
//   segments: (u32 styleId, u32 startVertex, f32 t0x, f32 t0y, u32 endVertex, f32 t1x, f32 t1y) ×N
//   regions:  (u32 windingRule, u32 loopCount, loops: (u32 n, u32 segIndex ×n)) ×N

function parseVectorNetwork(bytes) {
  const b = new Uint8Array(bytes); // copy realigns the view for DataView access
  const dv = new DataView(b.buffer);
  let o = 0;
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
  const nv = u32(), ns = u32(), nr = u32();
  if (12 + nv * 12 + ns * 28 > b.length) throw new Error('malformed vector network');
  const verts = [], segs = [], regions = [];
  for (let i = 0; i < nv; i++) { o += 4; verts.push({ x: f32(), y: f32() }); }
  for (let i = 0; i < ns; i++) {
    o += 4;
    segs.push({ start: u32(), t0x: f32(), t0y: f32(), end: u32(), t1x: f32(), t1y: f32() });
  }
  for (let i = 0; i < nr; i++) {
    const winding = u32(), loopCount = u32();
    const loops = [];
    for (let j = 0; j < loopCount; j++) {
      const n = u32(), idx = [];
      for (let k = 0; k < n; k++) idx.push(u32());
      loops.push(idx);
    }
    regions.push({ winding, loops });
  }
  return { verts, segs, regions };
}

// 2×3 affine helpers (Figma Matrix rows [m00 m01 m02; m10 m11 m12]).
const M_ID = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const mMul = (A, B) => ({
  m00: A.m00 * B.m00 + A.m01 * B.m10, m01: A.m00 * B.m01 + A.m01 * B.m11, m02: A.m00 * B.m02 + A.m01 * B.m12 + A.m02,
  m10: A.m10 * B.m00 + A.m11 * B.m10, m11: A.m10 * B.m01 + A.m11 * B.m11, m12: A.m10 * B.m02 + A.m11 * B.m12 + A.m12,
});
const mApply = (M, p) => ({ x: M.m00 * p.x + M.m01 * p.y + M.m02, y: M.m10 * p.x + M.m11 * p.y + M.m12 });

// One SVG path `d` from a run of segment indices, orienting each segment to
// continue from where the previous one ended.
function segRunToPath(net, indices, M, close) {
  const pt = (i) => mApply(M, net.verts[i]);
  let d = '', cur = -1;
  indices.forEach((si, k) => {
    const s = net.segs[si];
    if (!s) return;
    let { start, end, t0x, t0y, t1x, t1y } = s;
    if (k === 0) {
      // Orient the first segment so its far end meets the second segment.
      const nxt = net.segs[indices[1]];
      if (nxt && (start === nxt.start || start === nxt.end) && end !== nxt.start && end !== nxt.end) {
        [start, end] = [end, start]; [t0x, t0y, t1x, t1y] = [t1x, t1y, t0x, t0y];
      }
      const p = pt(start);
      d += `M${d2(p.x)} ${d2(p.y)}`;
      cur = start;
    } else if (start !== cur && end === cur) {
      [start, end] = [end, start]; [t0x, t0y, t1x, t1y] = [t1x, t1y, t0x, t0y];
    }
    const p1 = pt(end);
    if (!t0x && !t0y && !t1x && !t1y) {
      d += `L${d2(p1.x)} ${d2(p1.y)}`;
    } else {
      const c1 = mApply(M, { x: net.verts[start].x + t0x, y: net.verts[start].y + t0y });
      const c2 = mApply(M, { x: net.verts[end].x + t1x, y: net.verts[end].y + t1y });
      d += `C${d2(c1.x)} ${d2(c1.y)} ${d2(c2.x)} ${d2(c2.y)} ${d2(p1.x)} ${d2(p1.y)}`;
    }
    cur = end;
  });
  if (close && d) d += 'Z';
  return d;
}
const d2 = (n) => Math.round(n * 100) / 100;

// Chain loose segments (a network with no regions = open strokes) into runs.
function openRuns(net) {
  const used = new Set(), runs = [];
  net.segs.forEach((s, i) => {
    if (used.has(i)) return;
    const run = [i];
    used.add(i);
    let endV = s.end;
    for (;;) {
      const ni = net.segs.findIndex((x, j) => !used.has(j) && (x.start === endV || x.end === endV));
      if (ni < 0) break;
      used.add(ni);
      run.push(ni);
      endV = net.segs[ni].start === endV ? net.segs[ni].end : net.segs[ni].start;
    }
    runs.push(run);
  });
  return runs;
}

// Walk a vector-ish node (and, for boolean ops, its child vectors) collecting
// drawable paths in the root's local space. Each entry: {d, fill, strokeW}.
function collectVectorPaths(ctx, fig, M, out, depth = 0) {
  if (depth > 8) return;
  const blobIdx = fig.vectorData && fig.vectorData.vectorNetworkBlob;
  const blob = blobIdx != null && ctx.blobs[blobIdx];
  const bytes = blob && (blob.bytes || blob);
  if (bytes && bytes.length) {
    const net = parseVectorNetwork(bytes);
    const hasFill = !!topPaint(fig.fillPaints);
    const strokeW = topPaint(fig.strokePaints) ? d2(numVal(fig.strokeWeight, 1)) || 1 : 0;
    if (net.regions.length) {
      const evenodd = net.regions.some(r => r.winding === 1);
      const d = net.regions.map(r => r.loops.map(loop => segRunToPath(net, loop, M, true)).join('')).join('');
      if (d) out.push({ d, fill: hasFill || !strokeW, evenodd, strokeW });
    } else {
      const d = openRuns(net).map(run => segRunToPath(net, run, M, false)).join('');
      if (d) out.push({ d, fill: false, evenodd: false, strokeW: strokeW || 1 });
    }
  } else if (fig.type === 'LINE') {
    // Lines carry no network — synthesise their single stroke.
    const w = (fig.size && fig.size.x) || 0;
    const p0 = mApply(M, { x: 0, y: 0 }), p1 = mApply(M, { x: w, y: 0 });
    out.push({ d: `M${d2(p0.x)} ${d2(p0.y)}L${d2(p1.x)} ${d2(p1.y)}`, fill: false, evenodd: false, strokeW: d2(numVal(fig.strokeWeight, 1)) || 1 });
  }
  (fig._children || []).forEach(ch => {
    if (ch.visible === false) return;
    collectVectorPaths(ctx, ch, ch.transform ? mMul(M, ch.transform) : M, out, depth + 1);
  });
}

// The paint that tints an icon: the root's fill/stroke, else the first
// descendant's. Solid → colour variable (theme-aware); gradient → first stop.
function iconTint(ctx, fig, depth = 0) {
  for (const paints of [fig.fillPaints, fig.strokePaints]) {
    const p = topPaint(paints);
    if (p && p.type === 'SOLID') return solidColorId(ctx, p);
    if (p && String(p.type).startsWith('GRADIENT_') && p.stops && p.stops.length) {
      const s = p.stops[0];
      return ensureColor(ctx, rgbaToHex(s.color || {}), round2((s.color && s.color.a) == null ? 1 : s.color.a));
    }
  }
  if (depth < 8) {
    for (const ch of fig._children || []) {
      const id = iconTint(ctx, ch, depth + 1);
      if (id) return id;
    }
  }
  return null;
}

// A VECTOR/STAR/LINE/BOOLEAN_OPERATION… node as icon markup (like the icon
// tool's Iconify SVGs: viewBox + currentColor, tinted via colorId), or null
// when there's no decodable geometry (caller falls back to a plain box).
function vectorToIcon(ctx, fig) {
  const out = [];
  collectVectorPaths(ctx, fig, M_ID, out);
  if (!out.length) return null;
  const w = d2((fig.size && fig.size.x) || 1) || 1;
  const h = d2((fig.size && fig.size.y) || 1) || 1;
  const paths = out.map(p => p.fill
    ? `<path d="${p.d}" fill="currentColor"${p.evenodd ? ' fill-rule="evenodd" clip-rule="evenodd"' : ''}/>`
    : `<path d="${p.d}" fill="none" stroke="currentColor" stroke-width="${p.strokeW}" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join('');
  // overflow=visible so edge-hugging strokes aren't clipped by the viewBox.
  return {
    svg: `<svg viewBox="0 0 ${w} ${h}" overflow="visible" fill="none" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`,
    colorId: iconTint(ctx, fig),
  };
}

// ── node mapping ──

// Figma types that become Scaffold boxes. Vector-ish ones (right column) keep
// their box + fill but lose their path geometry — counted so the toast can say so.
const BOX_TYPES = new Set(['FRAME', 'GROUP', 'INSTANCE', 'SYMBOL', 'SECTION',
  'ROUNDED_RECTANGLE', 'RECTANGLE', 'ELLIPSE', 'HIGHLIGHT', 'SHAPE_WITH_TEXT']);
const VECTOR_TYPES = new Set(['VECTOR', 'STAR', 'LINE', 'POLYGON', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION']);
const FIT_MAP = { FILL: 'cover', FIT: 'contain', CROP: 'cover', TILE: 'cover', STRETCH: 'fill' };

function applyCorners(node, fig) {
  const tl = fig.rectangleTopLeftCornerRadius, tr = fig.rectangleTopRightCornerRadius;
  const br = fig.rectangleBottomRightCornerRadius, bl = fig.rectangleBottomLeftCornerRadius;
  if (fig.rectangleCornerRadiiIndependent && (tl || tr || br || bl)) {
    node.radiusMode = 'corners';
    node.radii = { tl: tl || 0, tr: tr || 0, br: br || 0, bl: bl || 0 };
  } else if (fig.cornerRadius > 0) {
    node.radius = Math.round(fig.cornerRadius);
  }
}

function applyStroke(ctx, node, fig) {
  const p = topPaint(fig.strokePaints);
  if (!p || p.type !== 'SOLID') return;
  node.strokeColorId = solidColorId(ctx, p);
  node.stroke = paintSolid(p).hex;
  node.strokeW = Math.max(1, Math.round(numVal(fig.strokeWeight, 1)));
  if (Array.isArray(fig.dashPattern) && fig.dashPattern.length) node.strokeStyle = 'dashed';
}

function applyShadows(ctx, node, fig) {
  (fig.effects || []).forEach(e => {
    if (e.type !== 'DROP_SHADOW' || e.visible === false) return;
    const c = e.color || { r: 0, g: 0, b: 0, a: 0.25 };
    const hex = rgbaToHex(c);
    node.shadows.push({
      x: Math.round((e.offset && e.offset.x) || 0), y: Math.round((e.offset && e.offset.y) || 0),
      blur: Math.round(e.radius || 0), spread: Math.round(e.spread || 0),
      colorId: hex === '#000000' ? null : ensureColor(ctx, hex, 1), // null = black (the default)
      alpha: round2(c.a == null ? 0.25 : c.a),
    });
  });
}

function applyFill(ctx, node, fig, w, h) {
  const p = topPaint(fig.fillPaints);
  node.colorId = null; // makeNode defaults containers/icons to the first variable — undo that
  if (!p) { node.fill = 'transparent'; return; }
  if (p.type === 'SOLID') {
    node.colorId = solidColorId(ctx, p);
    node.fill = paintSolid(p).hex;
  } else if (String(p.type).startsWith('GRADIENT_')) {
    node.fillType = p.type === 'GRADIENT_LINEAR' ? 'linear' : 'radial';
    node.gradient = gradientFromPaint(p, w, h);
    node.fill = node.gradient.stops[0].color;
  } else {
    node.fill = 'transparent';
  }
}

// Auto-layout → Scaffold layout. Returns the parent's flex axis ('row'|'column'|
// null) so children can translate grow/stretch into fill on the right axis.
function applyLayout(node, fig, childCount) {
  const mode = fig.stackMode;
  if (mode === 'HORIZONTAL' || mode === 'VERTICAL') {
    const row = mode === 'HORIZONTAL';
    if (fig.stackWrap === 'WRAP') {
      node.layout = 'wrap';
      node.gapH = Math.round(numVal(fig.stackSpacing, 8));
      node.gapV = Math.round(numVal(fig.stackCounterSpacing, node.gapH));
    } else {
      node.layout = row ? 'row' : 'column';
      node.gap = Math.round(numVal(fig.stackSpacing, 0));
    }
    node.padding = {
      l: Math.round(numVal(fig.stackHorizontalPadding, 0)),
      t: Math.round(numVal(fig.stackVerticalPadding, 0)),
      r: Math.round(numVal(fig.stackPaddingRight, numVal(fig.stackHorizontalPadding, 0))),
      b: Math.round(numVal(fig.stackPaddingBottom, numVal(fig.stackVerticalPadding, 0))),
    };
    const prim = { MIN: 'start', CENTER: 'center', MAX: 'end' }[fig.stackPrimaryAlignItems] || 'start';
    const ctr = { MIN: 'start', CENTER: 'center', MAX: 'end' }[fig.stackCounterAlignItems] || 'start';
    const toH = { start: 'left', center: 'center', end: 'right' };
    const toV = { start: 'top', center: 'center', end: 'bottom' };
    node.alignment = row ? { h: toH[prim], v: toV[ctr] } : { h: toH[ctr], v: toV[prim] };
    // Hug on an axis when Figma resizes the frame to fit its content.
    const hugP = String(fig.stackPrimarySizing || '').startsWith('RESIZE_TO_FIT');
    const hugC = String(fig.stackCounterSizing || '').startsWith('RESIZE_TO_FIT');
    if (node.type === 'container') {
      if (row ? hugP : hugC) node.wMode = 'hug';
      if (row ? hugC : hugP) node.hMode = 'hug';
    }
    return row ? 'row' : 'column';
  }
  // No auto-layout: keep children where they are (free positioning).
  if (childCount > 0) node.layout = 'stack';
  return null;
}

// Fill on the parent's axes from the child's grow/stretch flags.
function applyChildSizing(node, fig, parentAxis) {
  if (!parentAxis || node.type === 'frame') return;
  const grow = numVal(fig.stackChildPrimaryGrow, 0) > 0;
  const stretch = fig.stackChildAlignSelf === 'STRETCH';
  if (parentAxis === 'row') {
    if (grow) node.wMode = 'fill';
    if (stretch) node.hMode = 'fill';
  } else {
    if (grow) node.hMode = 'fill';
    if (stretch) node.wMode = 'fill';
  }
}

function mapText(ctx, node, fig) {
  node.text = (fig.textData && fig.textData.characters) || fig.name || 'Text';
  const size = Math.round(numVal(fig.fontSize, 14)) || 14;
  const weight = weightFromStyle(fig.fontName && fig.fontName.style);
  node.fontSize = size;
  node.fontWeight = String(weight);
  const p = topPaint(fig.fillPaints);
  let colorId = null;
  if (p && p.type === 'SOLID') {
    colorId = solidColorId(ctx, p);
    node.color = paintSolid(p).hex;
  }
  node.typoId = ensureTypo(ctx, {
    family: (fig.fontName && fig.fontName.family) || 'IBM Plex Sans',
    size, weight,
    lineHeight: lineHeightMul(fig.lineHeight, size),
    letterSpacing: letterSpacingPx(fig.letterSpacing, size),
    colorId,
  });
  node.alignment.h = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'left' }[fig.textAlignHorizontal] || 'left';
  node.autoSize = fig.textAutoResize === 'WIDTH_AND_HEIGHT' || fig.textAutoResize == null;
  if (!node.autoSize) node.wMode = 'fixed';
}

function mapImage(ctx, node, fig, paint) {
  const hash = hashHex(paint.image && paint.image.hash);
  const bytes = hash && ctx.images.get(hash);
  if (bytes) node.src = bytesToDataUri(bytes);
  else ctx.missingImages++;
  node.fit = FIT_MAP[paint.imageScaleMode] || 'cover';
  applyCorners(node, fig);
}

// Recursively map one Figma node (and its subtree) into state.nodes.
// `parentAxis` is the parent's flex axis for grow/stretch translation.
function mapFigNode(ctx, fig, parentId, isRoot, parentAxis, depth = 0) {
  // An INSTANCE doesn't inline its children — they live under its component
  // master (a SYMBOL on the internal canvas). Expand by merging: the master
  // supplies everything the instance doesn't state itself (fills, layout,
  // children); the instance's own guid/size/transform/overridden fields win.
  // Per-layer symbolOverrides are not applied yet (first pass).
  if (fig.type === 'INSTANCE' && fig.symbolData && depth < 16) {
    const master = ctx.byId.get(guidKey(fig.symbolData.symbolID));
    if (master) {
      fig = Object.assign({}, master, fig, {
        type: 'INSTANCE',
        _children: (fig._children && fig._children.length) ? fig._children : (master._children || []),
      });
    }
  }
  const t = fig.type;
  const w = Math.max(1, Math.round((fig.size && fig.size.x) || 100));
  const h = Math.max(1, Math.round((fig.size && fig.size.y) || 100));
  const m = fig.transform || { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const x = Math.round(m.m02), y = Math.round(m.m12);

  const imgPaint = topPaint(fig.fillPaints);
  const isImage = imgPaint && imgPaint.type === 'IMAGE' && t !== 'TEXT';
  let ffType, icon = null;
  if (t === 'TEXT') ffType = 'text';
  else if (isImage) ffType = 'image';
  else if (isRoot && t === 'FRAME') ffType = 'frame'; // a copied top-level frame is a screen
  else if (BOX_TYPES.has(t)) ffType = 'container';
  else if (VECTOR_TYPES.has(t)) {
    // Rebuild the vector's path from its network blob → a real icon node, the
    // same shape the icon tool produces. Unrecoverable geometry → plain box.
    icon = vectorToIcon(ctx, fig);
    if (icon) { ffType = 'icon'; ctx.icons++; }
    else { ffType = 'container'; ctx.vectors++; }
  } else { ctx.skipped++; return null; }

  const node = makeNode(ffType, x, y, w, h, parentId);
  state.nodes.push(node);
  if (parentId) {
    const p = state.nodes.find(n => n.id === parentId);
    if (p) p.children.push(node.id);
  }

  if (ffType === 'frame') {
    node.name = uniqueFrameName(fig.name);
    node.routePath = uniqueRoute(node.name);
  } else if (fig.name) {
    node.name = String(fig.name).slice(0, 60);
  }
  if (fig.visible === false) node.visible = false;
  if (fig.locked) node.locked = true;
  if (typeof fig.opacity === 'number' && fig.opacity < 1) node.opacity = round2(fig.opacity);
  const rot = Math.atan2(m.m10, m.m00) * 180 / Math.PI;
  if (Math.abs(rot) > 0.01) node.rotation = round2(rot);

  let axis = null;
  if (ffType === 'text') {
    mapText(ctx, node, fig);
  } else if (ffType === 'icon') {
    node.svg = icon.svg;
    node.iconId = '';
    node.colorId = icon.colorId;
  } else if (ffType === 'image') {
    mapImage(ctx, node, fig, imgPaint);
  } else {
    applyFill(ctx, node, fig, w, h);
    if (t === 'ELLIPSE') node.shape = 'circle';
    applyCorners(node, fig);
    applyStroke(ctx, node, fig);
    applyShadows(ctx, node, fig);
    const kids = (fig._children || []).filter(k => VECTOR_TYPES.has(k.type) || BOX_TYPES.has(k.type) || k.type === 'TEXT');
    axis = applyLayout(node, fig, kids.length);
  }
  applyChildSizing(node, fig, parentAxis);

  if (ffType === 'container' || ffType === 'frame') {
    (fig._children || []).forEach(child => mapFigNode(ctx, child, node.id, false, axis, depth + 1));
  }
  return node;
}

// ── entry point ──

// Decode a Figma clipboard buffer and materialise it in state at (px, py) world
// coordinates. Pure state mutation — the caller renders, snapshots history, and
// reports. Returns counts for the toast plus the new root ids for selection.
export async function importFigma(bytes, px, py) {
  const { message, images } = await parseFigBuffer(bytes);
  const { roots: allRoots, byId } = figTree(message);
  // Only visual layers paste; support material that can surface as a root in
  // odd payloads (styles, variables, component masters) is used indirectly.
  const roots = allRoots.filter(r =>
    BOX_TYPES.has(r.type) || VECTOR_TYPES.has(r.type) || r.type === 'TEXT');
  if (!roots.length) throw new Error('nothing recognisable on the clipboard');

  const ctx = {
    images, byId, vars: buildVarIndex(message), varCache: new Map(),
    blobs: (message.blobs || []).map(b => (b && b.bytes) ? b.bytes : b),
    newColors: 0, newTypos: 0, vectors: 0, icons: 0, skipped: 0, missingImages: 0,
  };
  // Keep the copied elements' relative placement: normalise to their bounding
  // box's top-left, then drop that at the paste point.
  const minX = Math.min(...roots.map(r => (r.transform && r.transform.m02) || 0));
  const minY = Math.min(...roots.map(r => (r.transform && r.transform.m12) || 0));
  const rootIds = [];
  let count = 0;
  const countRec = (n) => { count++; (n.children || []).forEach(id => countRec(state.nodes.find(x => x.id === id))); };
  roots.forEach(fig => {
    const node = mapFigNode(ctx, fig, null, true, null);
    if (!node) return;
    node.x = Math.round(px + (((fig.transform && fig.transform.m02) || 0) - minX));
    node.y = Math.round(py + (((fig.transform && fig.transform.m12) || 0) - minY));
    rootIds.push(node.id);
  });
  if (!rootIds.length) throw new Error('no supported layers on the clipboard');
  rootIds.forEach(id => countRec(state.nodes.find(n => n.id === id)));
  const { newColors, newTypos, vectors, icons, skipped, missingImages } = ctx;
  return { rootIds, count, newColors, newTypos, vectors, icons, skipped, missingImages };
}
