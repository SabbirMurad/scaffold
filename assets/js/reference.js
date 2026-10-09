// Measuring a reference image (Claude's study_reference tool): its real
// colors, read from the pixels, so a design "like this" is built on numbers
// rather than a guess at the vibe.
//
// measurePixels() works on raw RGBA pixels (testable anywhere); studyImage()
// draws an image to a small canvas first.

const SAMPLE_SIDE = 320;   // pixels on the long side to measure — enough that text stays text
const MERGE_DELTA = 5;     // Lab distance under which two colors count as one (a card on a page is ~6)

// ── color math ───────────────────────────────────────────────────────────────
const hex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
export const parseHex = (h) => {
  let s = String(h).replace('#', '').trim();
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function lab([r, g, b]) {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const chroma = (l) => Math.hypot(l[1], l[2]);
// WCAG: 4.5 for body text, 3 for large text and UI parts.
const grade = (ratio) => (ratio >= 7 ? 'AAA text' : ratio >= 4.5 ? 'AA text' : ratio >= 3 ? 'large text / UI only' : 'decorative only');

// ── palette ──────────────────────────────────────────────────────────────────
// Pixels are counted in color buckets (5 bits a channel), then the buckets are
// gathered into clusters, biggest first: a bucket joins the nearest cluster
// within reach, else starts its own. Reach is wide for vivid colors — JPEG
// keeps color at a lower resolution than lightness, so a small saturated area
// (a button, a logo) smears over many buckets — and narrow for neutrals, so a
// card stays apart from the page it sits on. A cluster's color is its
// weighted average; clusters under MIN_PEAK of the image are edges and noise.
const MIN_PEAK = 0.001;
const REACH_VIVID = 20, REACH_NEUTRAL = 4;
function histogramPalette(pixels) {
  const buckets = new Map();
  for (const p of pixels) {
    const key = ((p[0] >> 3) << 10) | ((p[1] >> 3) << 5) | (p[2] >> 3);
    let b = buckets.get(key);
    if (!b) { b = { sum: [0, 0, 0], count: 0 }; buckets.set(key, b); }
    b.sum[0] += p[0]; b.sum[1] += p[1]; b.sum[2] += p[2]; b.count++;
  }
  const clusters = [];
  const sorted = [...buckets.values()].sort((x, y) => y.count - x.count);
  for (const b of sorted) {
    const l = lab(b.sum.map(v => v / b.count));
    let best = null, bestD = Infinity;
    for (const c of clusters) {
      const d = dist(c.lab, l);
      if (d < (chroma(c.lab) >= 25 ? REACH_VIVID : REACH_NEUTRAL) && d < bestD) { best = c; bestD = d; }
    }
    if (best) {
      best.sum = best.sum.map((v, i) => v + b.sum[i]);
      best.count += b.count;
      best.lab = lab(best.sum.map(v => v / best.count));
    } else clusters.push({ sum: [...b.sum], count: b.count, lab: l });
  }
  const min = Math.max(2, pixels.length * MIN_PEAK);
  // Two clusters a person couldn't tell apart (they can drift together) become one.
  const out = [];
  for (const c of clusters.filter(c => c.count >= min).sort((x, y) => y.count - x.count)) {
    const near = out.find(o => dist(o.lab, c.lab) < MERGE_DELTA);
    if (near) { near.sum = near.sum.map((v, i) => v + c.sum[i]); near.count += c.count; }
    else out.push({ ...c });
  }
  return out.map(c => { const rgb = c.sum.map(v => v / c.count); return { rgb, count: c.count, lab: lab(rgb) }; });
}

// ── measuring ────────────────────────────────────────────────────────────────
// `data`: RGBA bytes of a w×h image. `pairs`: [[hexA, hexB], …] to check.
export function measurePixels(data, w, h, { pairs = [] } = {}) {
  const pixels = [], border = [];
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.04));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) continue; // transparent: not part of the picture
      const p = [data[i], data[i + 1], data[i + 2]];
      pixels.push(p);
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) border.push(p);
    }
  }
  if (!pixels.length) return { ok: false, summary: 'The image is fully transparent — nothing to measure' };
  const palette = histogramPalette(pixels);
  if (!palette.length) return { ok: false, summary: 'The image has no clear colors to measure' };
  const total = pixels.length;
  const nearest = (p) => { const l = lab(p); let best = palette[0], d = Infinity; for (const c of palette) { const e = dist(c.lab, l); if (e < d) { d = e; best = c; } } return best; };

  // The background: the color most of the image's edge is.
  const edgeCounts = new Map();
  (border.length ? border : pixels).forEach(p => { const c = nearest(p); edgeCounts.set(c, (edgeCounts.get(c) || 0) + 1); });
  const bg = [...edgeCounts].sort((a, b) => b[1] - a[1])[0][0];
  const bgShare = bg.count / total;

  // How busy: hard edges between neighbouring pixels.
  let edges = 0, checked = 0;
  for (let y = 0; y < h - 1; y += 2) {
    for (let x = 0; x < w - 1; x += 2) {
      const i = (y * w + x) * 4, j = i + 4, k = i + w * 4;
      if (data[i + 3] < 128) continue;
      const d1 = Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
      const d2 = Math.abs(data[i] - data[k]) + Math.abs(data[i + 1] - data[k + 1]) + Math.abs(data[i + 2] - data[k + 2]);
      if (Math.max(d1, d2) > 90) edges++;
      checked++;
    }
  }
  const edgeShare = checked ? edges / checked : 0;

  // Neutrals from 0.5% of the image; vivid colors from 0.1% — accents are small (a button, a logo).
  const colors = palette.filter(c => c.count / total >= (chroma(c.lab) >= 30 ? MIN_PEAK : 0.005)).map(c => {
    const ratio = contrast(c.rgb, bg.rgb);
    return {
      hex: hex(c.rgb), share: pct(c.count / total), lightness: Math.round(c.lab[0]), chroma: Math.round(chroma(c.lab)),
      onBackground: c === bg ? 'is the background' : `${ratio.toFixed(2)}:1 — ${grade(ratio)}`,
      _c: c, _ratio: ratio,
    };
  });
  const usable = colors.filter(c => c._c !== bg);
  const text = usable.filter(c => c._c.count / total >= 0.01).sort((a, b) => b._ratio - a._ratio)[0] || null;
  const accents = usable.filter(c => c.chroma >= 30)
    .sort((a, b) => b.chroma * Math.sqrt(b._c.count) - a.chroma * Math.sqrt(a._c.count)).slice(0, 3);
  const meanChroma = palette.reduce((s, c) => s + chroma(c.lab) * c.count, 0) / total;

  const checks = pairs.map(([a, b]) => {
    const A = parseHex(a), B = parseHex(b);
    if (!A || !B) return { pair: [a, b], problem: 'give two hex colors, like "#1a1a1a"' };
    const ratio = contrast(A, B);
    return { pair: [a, b], ratio: `${ratio.toFixed(2)}:1`, verdict: grade(ratio) };
  });

  const strip = ({ _c, _ratio, ...rest }) => rest;
  return {
    ok: true,
    theme: bg.lab[0] >= 60 ? 'light' : bg.lab[0] <= 35 ? 'dark' : 'mid-tone',
    background: { hex: hex(bg.rgb), share: pct(bgShare) },
    text: text ? { hex: text.hex, contrast: text.onBackground } : null,
    accents: accents.map(strip),
    palette: colors.map(strip),
    mood: { saturation: meanChroma < 12 ? 'muted / near-neutral' : meanChroma < 30 ? 'moderate' : 'vivid', meanChroma: Math.round(meanChroma) },
    density: { openSpace: pct(bgShare), hardEdges: pct(edgeShare), reads: bgShare > 0.55 && edgeShare < 0.08 ? 'airy' : edgeShare > 0.2 ? 'busy' : 'balanced' },
    checks,
    summary: `${bg.lab[0] >= 60 ? 'Light' : bg.lab[0] <= 35 ? 'Dark' : 'Mid-tone'} reference on ${hex(bg.rgb)}; ${colors.length} colors`
      + (accents.length ? `, accent ${accents[0].hex}` : '') + (text ? `, text ${text.hex} (${text.onBackground})` : ''),
  };
}
const pct = (f) => `${Math.round(f * 1000) / 10}%`;

// Draw an image (a URL the page can read, or a data: URL) small and measure it.
export async function studyImage(src, options) {
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('That image couldn\'t be opened'));
    im.src = src;
  });
  const k = Math.min(1, SAMPLE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false; // sample real pixels, not blends of neighbours
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return { ...measurePixels(data, w, h, options), size: [img.naturalWidth, img.naturalHeight] };
}
