import { state } from './state.js';
import { canvasWrap } from './utils.js';

const RW = 26;                          // ruler thickness
// The ruler canvases are left transparent; the frosted-glass tint + blur come from
// CSS (background + backdrop-filter on #ruler-*-canvas), matching the panels.
const RULER_LINE = 'rgba(255,255,255,0.13)'; // separator from the canvas
const TICK = '#555';
const LABEL = '#8a8d96';

export function drawRulers() {
  const wrapRect = canvasWrap.getBoundingClientRect();
  const W = wrapRect.width, H = wrapRect.height;
  const step = getStep();

  // Horizontal ruler
  const rh = document.getElementById('ruler-h-canvas');
  if (!rh) return;
  rh.width = W - RW; rh.height = RW;
  rh.style.position = 'absolute'; rh.style.left = RW + 'px'; rh.style.top = '0';
  const hctx = rh.getContext('2d');
  hctx.clearRect(0, 0, W, RW);
  // separator line along the bottom edge (between ruler and canvas)
  hctx.strokeStyle = RULER_LINE; hctx.lineWidth = 1;
  hctx.beginPath(); hctx.moveTo(0, RW - 0.5); hctx.lineTo(W, RW - 0.5); hctx.stroke();
  hctx.strokeStyle = TICK; hctx.fillStyle = LABEL;
  hctx.font = '9px IBM Plex Mono, monospace';
  const startX = Math.floor(-state.panX / state.zoom / step) * step;
  for (let x = startX; x < (W - state.panX) / state.zoom; x += step) {
    const px = x * state.zoom + state.panX;
    hctx.beginPath(); hctx.moveTo(px, RW - 6); hctx.lineTo(px, RW); hctx.stroke();
    if (Math.abs(x) % (step * 5) < step * 0.5) {
      hctx.fillText(Math.round(x), px + 2, RW - 13);
    }
  }

  // Vertical ruler
  const rv = document.getElementById('ruler-v-canvas');
  if (!rv) return;
  rv.width = RW; rv.height = H - RW;
  rv.style.position = 'absolute'; rv.style.left = '0'; rv.style.top = RW + 'px';
  const vctx = rv.getContext('2d');
  vctx.clearRect(0, 0, RW, H);
  // separator line along the right edge
  vctx.strokeStyle = RULER_LINE; vctx.lineWidth = 1;
  vctx.beginPath(); vctx.moveTo(RW - 0.5, 0); vctx.lineTo(RW - 0.5, H); vctx.stroke();
  vctx.strokeStyle = TICK; vctx.fillStyle = LABEL;
  vctx.font = '9px IBM Plex Mono, monospace';
  const startY = Math.floor(-state.panY / state.zoom / step) * step;
  for (let y = startY; y < (H - state.panY) / state.zoom; y += step) {
    const py = y * state.zoom + state.panY;
    vctx.beginPath(); vctx.moveTo(RW - 6, py); vctx.lineTo(RW, py); vctx.stroke();
    if (Math.abs(y) % (step * 5) < step * 0.5) {
      vctx.save(); vctx.translate(RW - 13, py + 2); vctx.rotate(-Math.PI / 2);
      vctx.fillText(Math.round(y), 0, 0);
      vctx.restore();
    }
  }
}

function getStep() {
  if (state.zoom > 4) return 10;
  if (state.zoom > 2) return 20;
  if (state.zoom > 0.5) return 50;
  if (state.zoom > 0.2) return 100;
  return 200;
}
