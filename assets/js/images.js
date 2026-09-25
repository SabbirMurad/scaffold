// Design-image references. Image bytes live in the backend (SQLite); the design
// document only stores a reference of the form `img:<uuid>`. Because serving is
// gated by project access, images can't be plain <img src> — we fetch the bytes
// with the bearer token and render them via blob object URLs.
//
// This module owns: uploading inline images to the backend and swapping their
// node.src to a ref (finalizeImages), resolving a ref to a renderable URL
// (resolvedSrc), and pre-resolving refs to data URIs for code export.

import { state } from './state.js';
import { getAuth, refreshToken } from './session.js';

const PREFIX = 'img:';
const API = () => (window.projectDomain || '') + '/api';

export function isImageRef(src) { return typeof src === 'string' && src.startsWith(PREFIX); }
export function refId(src) { return isImageRef(src) ? src.slice(PREFIX.length) : null; }
export function makeRef(id) { return PREFIX + id; }
function isDataUri(src) { return typeof src === 'string' && src.startsWith('data:'); }

// uuid → blob object URL, for rendering in the editor.
const objectUrls = new Map();
// uuid → data URI, resolved ahead of a code export.
const dataUris = new Map();
// uuid → in-flight GET promise, so concurrent renders don't refetch.
const inflight = new Map();

// Authenticated fetch with a single refresh-and-retry on 401. Returns the raw
// Response (we need blobs/bytes, not JSON, so we don't go through Fetcher).
async function authedFetch(path, opts = {}) {
  const token = () => { const a = getAuth(); return a && a.access_token; };
  const call = (t) => fetch(API() + path, {
    ...opts,
    headers: { ...(opts.headers || {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  });
  let res = await call(token());
  if (res.status === 401) {
    const fresh = await refreshToken();
    if (fresh) res = await call(fresh);
  }
  return res;
}

// Where an image's bytes are served: the member endpoint, or — on a public view
// link — the link's own read-only endpoint.
const imagePath = (id) => state.publicToken
  ? `/v1/public/${encodeURIComponent(state.publicToken)}/image/${encodeURIComponent(id)}`
  : `/v1/image/${encodeURIComponent(id)}`;

// Upload one image's bytes for the current project; resolves to an `img:<uuid>`
// ref, or null on failure (e.g. an unsaved scratch session with no project id).
// Seeds the render cache so the image shows immediately without a round-trip.
async function uploadImage(blob) {
  const projectId = state.projectId;
  if (!projectId) return null;
  const res = await authedFetch(`/v1/project/${encodeURIComponent(projectId)}/image`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) return null;
  let info;
  try { info = await res.json(); } catch { return null; }
  if (!info || !info.uuid) return null;
  objectUrls.set(info.uuid, URL.createObjectURL(blob));
  return makeRef(info.uuid);
}

function dataUriToBlob(uri) {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(uri);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const body = m[3];
  if (m[2]) { // base64
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

// ── finalize: inline data-URI images → uploaded refs ──
let pendingCount = 0;
// True while uploads are in flight; autosave skips so a transient data URI is
// never persisted before it becomes a compact ref.
export function imagesPending() { return pendingCount > 0; }

// Sweep the document for image nodes still carrying an inline data URI, upload
// each to the backend, and swap node.src to its ref. Fire-and-forget from every
// image-add path (device upload, paste, picker). A bare remote URL (the picker's
// CORS fallback) is left untouched. Dispatches `image:committed` when any node
// changed so the app can fold the swap into history and re-render.
export async function finalizeImages() {
  const targets = state.nodes.filter(n => n && n.type === 'image' && isDataUri(n.src));
  if (!targets.length) return;
  pendingCount += targets.length;
  let swapped = 0;
  await Promise.all(targets.map(async (node) => {
    try {
      const blob = dataUriToBlob(node.src);
      if (!blob) return;
      const ref = await uploadImage(blob);
      if (ref) { node.src = ref; swapped++; }
    } catch { /* leave the data URI; the next add re-sweeps */ }
    finally { pendingCount--; }
  }));
  if (swapped) document.dispatchEvent(new CustomEvent('image:committed'));
}

// ── resolve: ref → renderable URL ──
function loadRef(id) {
  if (objectUrls.has(id) || inflight.has(id)) return;
  const p = (async () => {
    try {
      const res = await authedFetch(imagePath(id));
      if (!res.ok) return;
      const blob = await res.blob();
      objectUrls.set(id, URL.createObjectURL(blob));
      document.dispatchEvent(new CustomEvent('image:resolved', { detail: id }));
    } catch { /* leave unresolved; a later render retries */ }
    finally { inflight.delete(id); }
  })();
  inflight.set(id, p);
}

// Turn a node.src into something the renderer can use *now*. A non-ref (data URI
// or remote URL) passes through; a ref returns its cached blob URL, or '' while
// it loads (an `image:resolved` event triggers a re-render once ready).
export function resolvedSrc(src) {
  if (!isImageRef(src)) return src || '';
  const id = refId(src);
  if (objectUrls.has(id)) return objectUrls.get(id);
  loadRef(id);
  return '';
}

// ── export: pre-resolve refs to data URIs so codegen can bundle the bytes ──
async function fetchDataUri(id) {
  if (dataUris.has(id)) return;
  try {
    const res = await authedFetch(imagePath(id));
    if (!res.ok) return;
    const blob = await res.blob();
    const uri = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
    if (uri) dataUris.set(id, uri);
  } catch { /* codegen falls back to a placeholder for this image */ }
}

// Fetch every referenced image's bytes as data URIs, ready for the code exporter.
export async function resolveRefsForExport(nodes) {
  const ids = new Set();
  (nodes || []).forEach(n => { if (n && isImageRef(n.src)) ids.add(refId(n.src)); });
  await Promise.all([...ids].map(fetchDataUri));
}

// Sync getter used by the code generator (after resolveRefsForExport has run).
export function imageDataUri(id) { return dataUris.get(id) || null; }
