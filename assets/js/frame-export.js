// Export a frame as a picture (PNG, JPG) or a one-page PDF — from the Export
// section of its properties. The frame is drawn the way the dashboard preview
// draws screens (thumbnail.js: snapshot), at 1×, 2× or 3× its size.
//
// The PDF is the frame as a high-quality JPEG on a page its own size (CSS
// pixels at 96 dpi, so it prints at the size it's designed at): the text in it
// is part of the picture, not selectable.

import { snapshot } from './thumbnail.js';
import { saveFile } from './save-file.js';
import { pdfOfJpegs, jpegOf } from './pdf.js';

export const EXPORT_FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'pdf', label: 'PDF' },
];
export const EXPORT_SCALES = [
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
  { value: '3', label: '3×' },
];

// What a browser canvas reliably holds.
const MAX_SIDE = 16000;
const MAX_AREA = 120e6;

// Draw `node` (a frame) and save it. Resolves to the file name, and whether the
// scale had to come down to fit (a very tall frame at 3×).
export async function exportFrame(node, format, scale) {
  const w = Math.ceil(node.w), h = Math.ceil(node.h);
  let s = Math.max(1, Number(scale) || 1);
  const fit = Math.min(MAX_SIDE / (w * s), MAX_SIDE / (h * s), Math.sqrt(MAX_AREA / (w * s * h * s)), 1);
  const reduced = fit < 1;
  s *= fit;

  const img = await snapshot(node, s);
  if (!img) throw new Error('The frame isn’t on the canvas');
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * s));
  cv.height = Math.max(1, Math.round(h * s));
  const ctx = cv.getContext('2d');
  // JPEG (and so the PDF) has no see-through: what's transparent goes white.
  if (format !== 'png') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
  ctx.drawImage(img, 0, 0, cv.width, cv.height);

  const base = fileName(node.name) + (format === 'pdf' || s === 1 ? '' : `@${+s.toFixed(2)}x`);
  let blob, name;
  if (format === 'png') {
    blob = await toBlob(cv, 'image/png');
    name = base + '.png';
  } else if (format === 'jpg') {
    blob = await toBlob(cv, 'image/jpeg', 0.92);
    name = base + '.jpg';
  } else {
    blob = pdfOfJpegs([{ jpeg: await jpegOf(cv, 0.95), iw: cv.width, ih: cv.height, pw: w * 0.75, ph: h * 0.75 }]);
    name = base + '.pdf';
  }
  const path = await saveFile(blob, name);
  // The app may have had to pick "name (2).png": say what it really is.
  if (path) name = path.split(/[\\/]/).pop();
  return { name, reduced, inApp: !!path };
}

function toBlob(cv, type, quality) {
  return new Promise((resolve, reject) => cv.toBlob(b => (b ? resolve(b) : reject(new Error('Couldn’t draw the frame'))), type, quality));
}

// A name that's safe as a file name on every OS.
export function fileName(name) {
  return String(name || 'Frame').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Frame';
}
