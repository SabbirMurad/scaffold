// Save a file the page made (an export). In the desktop app it goes straight
// to Downloads (desktop/src-tauri/src/downloads.rs) — the webview's own
// downloads stop working after the first one from a page. On the web, the
// browser downloads it. Resolves to where it went, when known.

const tauri = window.__TAURI__;

export async function saveFile(blob, name) {
  if (tauri && tauri.core) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return tauri.core.invoke('save_download', bytes, { headers: { 'x-name': encodeURIComponent(name) } });
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}
