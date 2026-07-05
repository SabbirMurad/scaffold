// Portable toast notifications — zero dependencies, no build step, framework-free.
//
// Drop this file into any project. It self-injects its own CSS (using CSS custom
// properties with fallbacks, so it adopts a host theme's --accent/--red/etc when
// present and still looks right standalone) and registers a `window.toast`
// global, so non-module code (e.g. fetcher.js) can call `toast.setNotification`.
//
//   import { toast } from './toast.js';
//   toast.success('Saved');
//   toast.error('Something went wrong');
//   toast.setNotification({ type: 'info', title: 'Heads up', message: '…' });
//   const t = toast.info('Working…', { duration: 0 });  // sticky; t.dismiss() to close
//
// Types: 'success' | 'error' | 'warning' | 'info' (unknown types fall back to info).

const TYPES = {
  success: { color: 'var(--accent, #1ecc7a)', icon: 'M20 6 9 17l-5-5' },
  error:   { color: 'var(--red, #f55b5b)',    icon: 'M12 8v5M12 16.5v.5M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' },
  warning: { color: 'var(--yellow, #f5d05b)', icon: 'M12 9v4M12 16.5v.5M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' },
  info:    { color: 'var(--accent, #4d7cff)', icon: 'M12 11v6M12 7.5v.5M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20Z' },
};

// Auto-dismiss defaults per type (ms). 0 / Infinity = sticky.
const DEFAULT_DURATION = { success: 3500, info: 4000, warning: 5000, error: 6000 };

const STYLE_ID = 'toast-styles';
const CSS = `
.toast-viewport {
  position: fixed; top: 16px; right: 16px; z-index: 2147483000;
  display: flex; flex-direction: column; gap: 10px;
  width: min(360px, calc(100vw - 32px)); pointer-events: none;
}
.toast-viewport.left { right: auto; left: 16px; }
.toast-viewport.bottom { top: auto; bottom: 16px; flex-direction: column-reverse; }
.toast {
  pointer-events: auto; position: relative; overflow: hidden;
  display: flex; gap: 11px; align-items: flex-start;
  padding: 12px 13px; border-radius: 11px;
  background: var(--glass-bg, #26272b);
  border: 1px solid var(--glass-border, rgba(255,255,255,0.09));
  box-shadow: 0 12px 34px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.06);
  color: var(--text, #edeef2);
  font-family: var(--sans, system-ui, sans-serif);
  backdrop-filter: blur(var(--glass-blur, 14px)) saturate(140%);
  -webkit-backdrop-filter: blur(var(--glass-blur, 14px)) saturate(140%);
  border-left: 3px solid var(--toast-accent, #1ecc7a);
  transform: translateX(120%); opacity: 0;
  transition: transform .28s cubic-bezier(.22,1,.36,1), opacity .28s ease;
}
.toast-viewport.left .toast { transform: translateX(-120%); }
.toast.in { transform: translateX(0); opacity: 1; }
.toast.out { transform: translateX(0); opacity: 0; height: 0; margin: 0; padding-top: 0; padding-bottom: 0; border-width: 0; }
.toast-ico { flex: 0 0 auto; width: 19px; height: 19px; color: var(--toast-accent, #1ecc7a); margin-top: 1px; }
.toast-body { flex: 1 1 auto; min-width: 0; }
.toast-title { font-size: 13px; font-weight: 600; line-height: 1.3; }
.toast-msg { font-size: 12.5px; line-height: 1.45; color: var(--text2, #9a9da6); word-wrap: break-word; }
.toast-title + .toast-msg { margin-top: 2px; }
.toast-close {
  flex: 0 0 auto; width: 18px; height: 18px; margin: -1px -2px 0 0; padding: 0;
  background: none; border: none; cursor: pointer; color: var(--text2, #9a9da6);
  font-size: 17px; line-height: 18px; border-radius: 5px; transition: color .1s, background .1s;
}
.toast-close:hover { color: var(--text, #edeef2); background: var(--surface3, rgba(255,255,255,0.1)); }
.toast-bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--toast-accent, #1ecc7a); opacity: .5; transform-origin: left; }
@media (prefers-reduced-motion: reduce) {
  .toast { transition: opacity .2s ease; transform: none; }
  .toast-viewport.left .toast { transform: none; }
  .toast-bar { display: none; }
}
`;

class ToastManager {
  constructor(options = {}) {
    // position: 'top-right' (default) | 'top-left' | 'bottom-right' | 'bottom-left'
    this.position = options.position || 'top-right';
    this.max = options.max || 5;        // cap concurrent toasts (oldest evicted)
    this._host = null;
    this._live = new Set();
  }

  // Lazily inject styles + the viewport container on first use (so importing the
  // module in <head>, before <body> exists, is safe).
  _ensureHost() {
    if (this._host && document.body.contains(this._host)) return this._host;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const host = document.createElement('div');
    host.className = 'toast-viewport';
    if (this.position.includes('left')) host.classList.add('left');
    if (this.position.includes('bottom')) host.classList.add('bottom');
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('role', 'region');
    document.body.appendChild(host);
    this._host = host;
    return host;
  }

  // Core entry point (matches the shape fetcher.js calls).
  //   { type, message, title, duration, dismissible }
  setNotification({ type = 'info', message = '', title = '', duration, dismissible = true } = {}) {
    const host = this._ensureHost();
    const spec = TYPES[type] || TYPES.info;
    const ms = duration != null ? duration : (DEFAULT_DURATION[type] ?? 4000);

    const el = document.createElement('div');
    el.className = 'toast';
    el.style.setProperty('--toast-accent', spec.color);
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `
      <svg class="toast-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="${spec.icon}"/>
      </svg>
      <div class="toast-body">
        ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
        <div class="toast-msg">${escapeHtml(message)}</div>
      </div>
      ${dismissible ? '<button class="toast-close" aria-label="Dismiss">&times;</button>' : ''}`;

    const handle = { el, dismiss: () => this.dismiss(el) };

    if (dismissible) el.querySelector('.toast-close').addEventListener('click', handle.dismiss);

    // Auto-dismiss with a shrinking progress bar; pause while hovered.
    if (ms && ms !== Infinity) {
      const bar = document.createElement('div');
      bar.className = 'toast-bar';
      bar.style.transition = `transform ${ms}ms linear`;
      el.appendChild(bar);
      requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; });

      let remaining = ms, startedAt = performance.now(), timer = setTimeout(handle.dismiss, ms);
      el.addEventListener('mouseenter', () => {
        clearTimeout(timer);
        remaining -= performance.now() - startedAt;
        const done = 1 - remaining / ms;
        bar.style.transition = 'none';
        bar.style.transform = `scaleX(${Math.max(0, 1 - done)})`;
      });
      el.addEventListener('mouseleave', () => {
        startedAt = performance.now();
        timer = setTimeout(handle.dismiss, Math.max(0, remaining));
        bar.style.transition = `transform ${Math.max(0, remaining)}ms linear`;
        requestAnimationFrame(() => { bar.style.transform = 'scaleX(0)'; });
      });
    }

    host.appendChild(el);
    this._live.add(handle);
    requestAnimationFrame(() => el.classList.add('in'));

    // Evict the oldest when over the cap.
    while (this._live.size > this.max) this.dismiss([...this._live][0].el);

    return handle;
  }

  dismiss(el) {
    if (!el || !el.classList || el.classList.contains('out')) return;
    el.classList.add('out');
    el.classList.remove('in');
    for (const h of this._live) if (h.el === el) { this._live.delete(h); break; }
    const done = () => el.remove();
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 400); // fallback if transitionend doesn't fire
  }

  clear() { [...this._live].forEach(h => this.dismiss(h.el)); }

  // Convenience shorthands.
  success(message, opts = {}) { return this.setNotification({ ...opts, type: 'success', message }); }
  error(message, opts = {})   { return this.setNotification({ ...opts, type: 'error', message }); }
  warning(message, opts = {}) { return this.setNotification({ ...opts, type: 'warning', message }); }
  info(message, opts = {})    { return this.setNotification({ ...opts, type: 'info', message }); }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const toast = new ToastManager();
export { ToastManager };
export default toast;

// Register the global so non-module consumers (and fetcher.js) can use it
// without importing. A host page can override with its own before this loads.
if (typeof window !== 'undefined' && !window.toast) window.toast = toast;
