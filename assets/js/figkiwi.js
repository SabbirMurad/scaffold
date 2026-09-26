// Decoder for Figma's clipboard payload. Ctrl+C in Figma puts an HTML blob on
// the clipboard containing `<!--(figma)BASE64(/figma)-->` — the selection encoded
// in Figma's binary Kiwi format (https://github.com/evanw/kiwi), the same payload
// as a .fig file. Crucially the container ships its *own* Kiwi schema, so we
// decode that first and then read the node tree against it — no hardcoded,
// version-locked schema. Newer payloads wrap the whole thing in a ZIP (with a
// canvas.fig plus the referenced image bytes under images/<hash>).
//
// This module is deliberately pure (no DOM, no app imports) so it can be unit
// tested in Node; the mapping into Scaffold nodes lives in figpaste.js.

// ── bytes / base64 ──

export function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Pull the base64 figma buffer out of pasted HTML, or null when the clipboard
// isn't a Figma copy. Large copies can split the buffer across several
// `(figma)…(/figma)` blocks — concatenate them in order. (The figmeta blob
// alongside is metadata we don't need.)
export function extractFigmaHtml(html) {
  const parts = [...String(html || '').matchAll(/\(figma\)([A-Za-z0-9+/=\s]+?)\(\/figma\)/g)].map(m => m[1]);
  return parts.length ? b64ToBytes(parts.join('')) : null;
}

// ── decompression ──

import { decompress as zstdDecompress } from './vendor/fzstd.js';

async function decompress(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
// fig chunks are raw DEFLATE historically, but newer Figma compresses the data
// chunk with Zstandard (magic 28 b5 2f fd) — the browser has no native zstd, so
// that goes through the vendored fzstd. Tolerate a zlib wrapper (0x78) too.
async function inflate(bytes) {
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    return zstdDecompress(bytes);
  }
  try { return await decompress(bytes, bytes[0] === 0x78 ? 'deflate' : 'deflate-raw'); }
  catch { return decompress(bytes, bytes[0] === 0x78 ? 'deflate-raw' : 'deflate'); }
}

// ── minimal ZIP reader (STORE + DEFLATE entries) ──

async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End-of-central-directory record: scan back from the tail (comment can pad it).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('clipboard zip: no directory');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = new Map();
  const td = new TextDecoder();
  for (let i = 0; i < count && dv.getUint32(off, true) === 0x02014b50; i++) {
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = td.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    // The local header repeats name/extra with its own lengths — skip via those.
    const dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + csize);
    out.set(name, method === 8 ? await decompress(raw, 'deflate-raw') : raw.slice());
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── Kiwi byte reader ──

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);

class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  get eof() { return this.i >= this.b.length; }
  byte() {
    if (this.i >= this.b.length) throw new Error('kiwi: unexpected end of data');
    return this.b[this.i++];
  }
  varUint() { // LEB128; multiply (not shift) so 5-byte values don't overflow int32
    let v = 0, mul = 1, b;
    do { b = this.byte(); v += (b & 127) * mul; mul *= 128; } while (b & 128);
    return v;
  }
  varInt() { const v = this.varUint(); return v & 1 ? ~(v >>> 1) : v >>> 1; } // zigzag
  varUint64() {
    let v = 0n, sh = 0n, b;
    do { b = this.byte(); v |= BigInt(b & 127) << sh; sh += 7n; } while (b & 128);
    return Number(v);
  }
  varInt64() {
    let v = 0n, sh = 0n, b;
    do { b = this.byte(); v |= BigInt(b & 127) << sh; sh += 7n; } while (b & 128);
    return Number(v & 1n ? ~(v >> 1n) : v >> 1n);
  }
  varFloat() { // kiwi packs the exponent into byte 0 so 0.0 is a single byte
    const first = this.byte();
    if (first === 0) return 0;
    if (this.i + 3 > this.b.length) throw new Error('kiwi: bad float');
    const bits = first | (this.b[this.i] << 8) | (this.b[this.i + 1] << 16) | (this.b[this.i + 2] << 24);
    this.i += 3;
    i32[0] = (bits << 23) | (bits >>> 9);
    return f32[0];
  }
  string() { // UTF-8, null-terminated
    const start = this.i;
    while (this.byte() !== 0) { /* advance */ }
    return new TextDecoder().decode(this.b.subarray(start, this.i - 1));
  }
  bytes(n) { const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
}

// ── Kiwi schema + message decoding ──

// kind: 0 = ENUM, 1 = STRUCT, 2 = MESSAGE. Negative field types are primitives.
const PRIMITIVES = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];

export function decodeSchema(bytes) {
  const r = new Reader(bytes);
  const count = r.varUint();
  const defs = [];
  for (let i = 0; i < count; i++) {
    const name = r.string();
    const kind = r.byte();
    const fieldCount = r.varUint();
    const fields = [];
    for (let j = 0; j < fieldCount; j++) {
      fields.push({ name: r.string(), type: r.varInt(), isArray: !!(r.byte() & 1), value: r.varUint() });
    }
    defs.push({ name, kind, fields });
  }
  const byName = {};
  defs.forEach(d => { byName[d.name] = d; });
  return { defs, byName };
}

function readPrimitive(r, p) {
  switch (p) {
    case 'bool': return !!r.byte();
    case 'byte': return r.byte();
    case 'int': return r.varInt();
    case 'uint': return r.varUint();
    case 'float': return r.varFloat();
    case 'string': return r.string();
    case 'int64': return r.varInt64();
    case 'uint64': return r.varUint64();
    default: throw new Error('kiwi: bad primitive ' + p);
  }
}

function readType(r, schema, type) {
  if (type < 0) return readPrimitive(r, PRIMITIVES[-type - 1]);
  const def = schema.defs[type];
  if (!def) throw new Error('kiwi: bad type index ' + type);
  if (def.kind === 0) { // enum → symbolic name
    const v = r.varUint();
    const f = def.fields.find(x => x.value === v);
    return f ? f.name : v;
  }
  if (def.kind === 1) { // struct: every field, in order, no ids
    const o = {};
    for (const f of def.fields) o[f.name] = readField(r, schema, f);
    return o;
  }
  // message: (field id, value) pairs until a 0 id. We decode with the payload's
  // own schema, so every id is known — an unknown one means corrupt data.
  const o = {};
  for (;;) {
    const id = r.varUint();
    if (id === 0) return o;
    const f = def.fields.find(x => x.value === id);
    if (!f) throw new Error(`kiwi: unknown field ${id} in ${def.name}`);
    o[f.name] = readField(r, schema, f);
  }
}

function readField(r, schema, f) {
  if (f.isArray) {
    if (f.type === -2) return r.bytes(r.varUint()); // byte[] → raw Uint8Array
    const n = r.varUint();
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = readType(r, schema, f.type);
    return a;
  }
  return readType(r, schema, f.type);
}

export function decodeMessage(schema, bytes, rootName = 'Message') {
  const def = schema.byName[rootName];
  if (!def) throw new Error(`kiwi: no ${rootName} definition in schema`);
  return readType(new Reader(bytes), schema, schema.defs.indexOf(def));
}

// ── fig container ──

// Parse the decoded clipboard buffer (raw fig-kiwi, or a ZIP wrapping one) into
// the decoded root Message plus any bundled image bytes (hash hex → bytes).
export async function parseFigBuffer(bytes) {
  const images = new Map();
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // 'PK' — zipped payload
    let fig = null;
    for (const [name, data] of await readZip(bytes)) {
      if (/\.fig$/i.test(name)) fig = data;
      const m = /^images\/([0-9a-f]{16,})$/i.exec(name);
      if (m) images.set(m[1].toLowerCase(), data);
    }
    if (!fig) throw new Error('clipboard zip has no .fig payload');
    bytes = fig;
  }
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (!magic.startsWith('fig-')) throw new Error('not a Figma clipboard payload');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 12; // 8-byte magic + uint32 version
  const chunks = [];
  while (off + 4 <= bytes.length) {
    const size = dv.getUint32(off, true);
    off += 4;
    chunks.push(bytes.subarray(off, off + size));
    off += size;
  }
  if (chunks.length < 2) throw new Error('fig payload has no data chunks');
  const schema = decodeSchema(await inflate(chunks[0]));
  const message = decodeMessage(schema, await inflate(chunks[1]));
  return { message, images };
}

// ── node tree reconstruction ──

export const guidKey = (g) => (g ? `${g.sessionID}:${g.localID}` : '');

// Rebuild the copied selection as a tree from the flat nodeChanges list: link
// children via parentIndex and order siblings by their fractional-index position
// (lexicographic order == document order).
//
// The paste roots are the nodes parented to a *real* canvas. Figma also ships an
// "Internal Only Canvas" (internalOnly: true) carrying support material — the
// component masters behind copied instances, variable sets, style nodes. Those
// must not paste as layers, but they stay reachable through `byId` so the mapper
// can expand instances and resolve variable aliases against them.
export function figTree(message) {
  const changes = (message.nodeChanges || []).filter(n => n && n.guid);
  const byId = new Map();
  changes.forEach(n => { n._children = []; byId.set(guidKey(n.guid), n); });
  const realCanvas = new Set(), internalCanvas = new Set();
  changes.forEach(n => {
    if (n.type === 'CANVAS') (n.internalOnly ? internalCanvas : realCanvas).add(guidKey(n.guid));
  });
  const roots = [], orphans = [];
  for (const n of changes) {
    if (n.type === 'DOCUMENT' || n.type === 'CANVAS') continue;
    const pk = n.parentIndex ? guidKey(n.parentIndex.guid) : '';
    const p = byId.get(pk);
    if (p && p.type !== 'DOCUMENT' && p.type !== 'CANVAS') { p._children.push(n); continue; }
    if (realCanvas.has(pk)) roots.push(n);
    else if (!internalCanvas.has(pk)) orphans.push(n); // parent unknown → root candidate
  }
  const pos = (n) => (n.parentIndex && n.parentIndex.position) || '';
  const byPos = (a, b) => (pos(a) < pos(b) ? -1 : pos(a) > pos(b) ? 1 : 0);
  byId.forEach(n => n._children.sort(byPos));
  // Only fall back to orphans when nothing sits on a real canvas (odd payloads).
  const out = (roots.length ? roots : orphans).sort(byPos);
  return { roots: out, byId };
}
