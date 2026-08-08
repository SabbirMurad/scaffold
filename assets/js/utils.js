export const $ = (id) => document.getElementById(id);

export const canvasWrap = $('canvas-wrap');
export const canvas     = $('canvas');
export const layersList = $('layers-list');
export const propsFields = $('props-fields');
export const noSelection = $('no-selection');
export const ctxMenu    = $('ctx-menu');
export const frameMenu  = $('frame-menu');
export const zoomLabel  = $('zoom-label');
export const selBox     = $('selection-box');
export const toastEl    = $('toast');

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer;
export function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2000);
}

export function closeMenus() {
  ctxMenu.style.display = 'none';
  frameMenu.style.display = 'none';
}
