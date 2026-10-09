// Projects in tabs. In the desktop app each open project is a tab of its own
// (desktop/src-tauri/src/tabs.rs): opening one opens (or switches to) its tab,
// "home" brings the dashboard tab forward, signing out closes the project tabs.
// On the web, each is a page, as ever.

const tauri = window.__TAURI__;
export const inTabs = !!(tauri && tauri.core);
// In the app the top bar has the profile (tabs.html): pages hide their own.
if (inTabs) document.documentElement.classList.add('in-tabs');
const invoke = (cmd, args) => tauri.core.invoke(cmd, args).catch(() => {});

const editorUrl = (id) => `/editor.html?id=${encodeURIComponent(id)}`;

// Open a project: its tab in the app, its page on the web.
export function openProject(id, title) {
  if (inTabs) invoke('tab_open', { project: id, title: title || 'Project' });
  else window.location.href = editorUrl(id);
}

// The dashboard: its tab in the app, its page on the web.
export function goHome() {
  if (inTabs) invoke('tab_home');
  else window.location.href = '/dashboard.html';
}

// Close this page's tab (the app) — on the web, leave for the dashboard.
export function closeThisTab() {
  if (inTabs) invoke('tab_close', {});
  else window.location.href = '/dashboard.html';
}

// Name this page's tab (the project's name).
export function setTabTitle(title) {
  if (inTabs && title) invoke('tab_title', { title: String(title) });
}

// Signed out (or the session ran out): in the app every project tab closes and
// the home tab shows sign-in; on the web, this page goes to sign-in.
export function signedOut() {
  if (inTabs) invoke('tabs_signed_out');
  else window.location.href = '/auth.html';
}

// The dashboard has the person's projects: close tabs whose project is gone
// (deleted on another computer, access removed). Resolves to how many closed.
export async function pruneTabs(ids) {
  if (!inTabs) return 0;
  return (await invoke('tabs_prune', { projects: ids })) || 0;
}

// Keyboard, as in a browser: Ctrl+W closes this tab (not Home), Ctrl+Tab /
// Ctrl+Shift+Tab and Ctrl+PageDown / PageUp move between tabs.
if (inTabs) {
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key === 'w' && !e.shiftKey) {
      e.preventDefault();
      if (!/\/dashboard\.html$/.test(location.pathname)) invoke('tab_close', {});
    } else if (key === 'tab') {
      e.preventDefault();
      invoke('tab_cycle', { back: e.shiftKey });
    } else if (key === 'pagedown' || key === 'pageup') {
      e.preventDefault();
      invoke('tab_cycle', { back: key === 'pageup' });
    }
  }, true);
}
