// Design files: a project's design saved as a single `.scaffold` file that
// anyone can import as a new project of their own.
//
// The file holds the design and nothing about who it belongs to: the project's
// name and its document (screens, components, colors, text styles, themes,
// models, mock data, providers), plus the bytes of every image it uses — those
// are stored per project on the server, so a bare reference would be useless
// to anyone else. Owner, collaborators, public link, comments and ids stay
// behind. Importing creates a fresh project owned by whoever imports it.
//
// Format (JSON):
//   { format: "scaffold-design", version: 1, name, exported_at,
//     content: { …the design document… },
//     images: { "<id>": { type: "image/png", data: "<base64>" } } }
// Images are referenced from the content as "img:<id>" (see images.js).

import { getAuth, refreshToken } from './session.js';
import { getProject, createProject, saveProjectDoc, deleteProject } from './projects.js';

const FORMAT = 'scaffold-design';
const VERSION = 1;
export const EXTENSION = '.scaffold';
const IMAGE_REF = /^img:([A-Za-z0-9-]+)$/;

// ── export ───────────────────────────────────────────────────────────────────
// Build the file for a project and download it. Resolves to the file name.
export async function exportDesign(projectId) {
  const res = await getProject(projectId);
  if (!res.ok || !res.data) throw new Error(res.error || 'Couldn’t load the project');
  const name = (res.data.project && res.data.project.name) || 'Untitled';
  const content = (res.data.document && res.data.document.content) || {};

  const images = {};
  for (const id of imageIds(content)) {
    const blob = await fetchImage(id);
    images[id] = { type: blob.type || 'image/png', data: await toBase64(blob) };
  }

  const file = { format: FORMAT, version: VERSION, name, exported_at: new Date().toISOString(), content, images };
  const fileName = safeFileName(name) + EXTENSION;
  download(new Blob([JSON.stringify(file)], { type: 'application/json' }), fileName);
  return fileName;
}

// ── import ───────────────────────────────────────────────────────────────────
// Create a new project (owned by the signed-in person) from a design file.
// Resolves to the new project. A failure part-way removes what was made.
export async function importDesign(file) {
  const parsed = parse(await file.text(), file.name);

  const created = await createProject({ name: parsed.name });
  if (!created.ok || !created.data || !created.data.uuid) throw new Error(created.error || 'Couldn’t create the project');
  const project = created.data;

  try {
    // Each image gets a new id in the new project; the content is pointed at them.
    const newIds = {};
    for (const id of imageIds(parsed.content)) {
      const image = parsed.images[id];
      if (!image) continue; // not in the file: stays a broken reference, like the original
      newIds[id] = await uploadImage(project.uuid, image);
    }
    const content = relink(parsed.content, newIds);
    const saved = await saveProjectDoc(project.uuid, content, 1);
    if (!saved.ok) throw new Error(saved.error || 'Couldn’t save the design');
  } catch (error) {
    await deleteProject(project.uuid);
    throw error;
  }
  return project;
}

function parse(text, fileName) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This isn’t a Scaffold design file'); }
  if (!data || data.format !== FORMAT) throw new Error('This isn’t a Scaffold design file');
  if (typeof data.version !== 'number' || data.version > VERSION) {
    throw new Error('This design file is from a newer version of Scaffold — update the app to open it');
  }
  if (!data.content || typeof data.content !== 'object' || Array.isArray(data.content)) {
    throw new Error('This design file is damaged (it has no design in it)');
  }
  const fallback = String(fileName || '').replace(/\.[^.]*$/, '') || 'Imported design';
  const name = (typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallback).slice(0, 120);
  const images = data.images && typeof data.images === 'object' ? data.images : {};
  return { name, content: data.content, images };
}

// ── images ───────────────────────────────────────────────────────────────────
// Every image id referenced anywhere in the design.
function imageIds(value, found = new Set()) {
  if (typeof value === 'string') {
    const m = IMAGE_REF.exec(value);
    if (m) found.add(m[1]);
  } else if (Array.isArray(value)) value.forEach(v => imageIds(v, found));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => imageIds(v, found));
  return found;
}

// A copy of the design with image references pointed at their new ids.
function relink(value, newIds) {
  if (typeof value === 'string') {
    const m = IMAGE_REF.exec(value);
    return m && newIds[m[1]] ? 'img:' + newIds[m[1]] : value;
  }
  if (Array.isArray(value)) return value.map(v => relink(v, newIds));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = relink(v, newIds);
    return out;
  }
  return value;
}

async function fetchImage(id) {
  const res = await authedFetch(`/v1/image/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Couldn’t read one of the design’s images');
  return res.blob();
}

async function uploadImage(projectId, image) {
  const type = typeof image.type === 'string' ? image.type : 'image/png';
  let blob;
  try { blob = await (await fetch(`data:${type};base64,${image.data}`)).blob(); }
  catch { throw new Error('One of the design’s images is damaged'); }
  const res = await authedFetch(`/v1/project/${encodeURIComponent(projectId)}/image`, {
    method: 'POST', headers: { 'Content-Type': type }, body: blob,
  });
  let info = null;
  try { info = await res.json(); } catch { /* no body */ }
  if (!res.ok || !info || !info.uuid) throw new Error((info && info.message) || 'Couldn’t upload one of the design’s images');
  return info.uuid;
}

// Authenticated fetch (bytes, not JSON) with one refresh-and-retry on 401.
async function authedFetch(path, opts = {}) {
  const call = (t) => fetch((window.projectDomain || '') + '/api' + path, {
    ...opts, headers: { ...(opts.headers || {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  });
  const auth = getAuth();
  let res = await call(auth && auth.access_token);
  if (res.status === 401) { const fresh = await refreshToken(); if (fresh) res = await call(fresh); }
  return res;
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('Couldn’t read an image'));
    reader.readAsDataURL(blob);
  });
}

// ── file ─────────────────────────────────────────────────────────────────────
// A name that's safe as a file name on every OS.
function safeFileName(name) {
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Design';
}

function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
