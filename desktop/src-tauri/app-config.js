// Desktop runtime config — generated into desktop/dist by build.rs, loaded by
// every app page before its modules.

// API server the frontend talks to (Fetcher, images, collab WebSocket).
window.projectDomain = '__API_URL__';

// Links to other sites open in the system browser instead of the app window.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const url = new URL(a.href, location.href);
  if (url.origin === location.origin || !/^(https?|mailto):$/.test(url.protocol)) return;
  e.preventDefault();
  window.__TAURI__?.opener?.openUrl(url.href);
}, true);
