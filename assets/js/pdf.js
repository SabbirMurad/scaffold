// A small PDF writer for exports drawn in the editor (a frame, a presentation).
//
// Pages are made of JPEG images placed on them, plus whatever drawing operators
// the caller writes (lines, curves, shapes, a little text). An image used on
// several pages is stored once. One font is available as /F1: Helvetica Bold,
// a PDF standard font (nothing embedded) — enough for numbers and short labels.
//
//   pdfDocument({
//     images: [{ jpeg: Uint8Array, w, h }],            // pixels
//     pages:  [{ w, h, content: '…operators…', images: [0, 2] }], // points
//   })
// In `content`, image i is drawn with `/I<i> Do` (after a `cm` placing it).

export function pdfDocument({ images, pages }) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; put(`${n} 0 obj\n`); body(); put('\nendobj\n'); };
  const num = (v) => +v.toFixed(2);

  // 1 catalog, 2 page tree, 3 font, then the images, then two objects a page.
  const imageObj = (i) => 4 + i;
  const pageObj = (p) => 4 + images.length + p * 2;
  const count = 4 + images.length + pages.length * 2;

  put('%PDF-1.4\n');
  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => put(`<< /Type /Pages /Kids [${pages.map((_, p) => `${pageObj(p)} 0 R`).join(' ')}] /Count ${pages.length} >>`));
  obj(3, () => put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
  images.forEach((im, i) => obj(imageObj(i), () => {
    put(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`);
    put(im.jpeg);
    put('\nendstream');
  }));
  pages.forEach((pg, p) => {
    const n = pageObj(p);
    const used = [...new Set(pg.images || [])];
    const xobjects = used.map(i => `/I${i} ${imageObj(i)} 0 R`).join(' ');
    const content = enc.encode(pg.content);
    obj(n, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pg.w)} ${num(pg.h)}] /Resources << /XObject << ${xobjects} >> /Font << /F1 3 0 R >> >> /Contents ${n + 1} 0 R >>`));
    obj(n + 1, () => { put(`<< /Length ${content.length} >>\nstream\n`); put(content); put('\nendstream'); });
  });
  const xref = size;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
  put(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

// Pages that are each one JPEG covering the page (`pw`×`ph` points).
export function pdfOfJpegs(pages) {
  const num = (v) => +v.toFixed(2);
  return pdfDocument({
    images: pages.map(p => ({ jpeg: p.jpeg, w: p.iw, h: p.ih })),
    pages: pages.map((p, i) => ({ w: p.pw, h: p.ph, images: [i], content: `q ${num(p.pw)} 0 0 ${num(p.ph)} 0 0 cm /I${i} Do Q` })),
  });
}

// A canvas as JPEG bytes.
export async function jpegOf(canvas, quality = 0.92) {
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Couldn’t draw the page'))), 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

// ── drawing operators (a page's coordinates: points, origin bottom-left) ──
const n2 = (v) => +(+v).toFixed(2);
const K = 0.5523; // a quarter circle as a cubic

// A rounded rectangle's path (not yet filled, stroked or clipped).
export function roundRectPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = r * K;
  return [
    `${n2(x + r)} ${n2(y)} m`,
    `${n2(x + w - r)} ${n2(y)} l`,
    `${n2(x + w - r + k)} ${n2(y)} ${n2(x + w)} ${n2(y + r - k)} ${n2(x + w)} ${n2(y + r)} c`,
    `${n2(x + w)} ${n2(y + h - r)} l`,
    `${n2(x + w)} ${n2(y + h - r + k)} ${n2(x + w - r + k)} ${n2(y + h)} ${n2(x + w - r)} ${n2(y + h)} c`,
    `${n2(x + r)} ${n2(y + h)} l`,
    `${n2(x + r - k)} ${n2(y + h)} ${n2(x)} ${n2(y + h - r + k)} ${n2(x)} ${n2(y + h - r)} c`,
    `${n2(x)} ${n2(y + r)} l`,
    `${n2(x)} ${n2(y + r - k)} ${n2(x + r - k)} ${n2(y)} ${n2(x + r)} ${n2(y)} c`,
    'h',
  ].join('\n');
}

export const circlePath = (cx, cy, r) => roundRectPath(cx - r, cy - r, r * 2, r * 2, r);

// "#1ecc7a" → "0.118 0.8 0.478"
export function rgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(c => +(c / 255).toFixed(3)).join(' ');
}
export { n2 as pdfNum };
