// Mock data in the design: bindings, conditions and repeats.
//
// A node can be driven by the project's mock data (Mock Data tab):
//   node.bind   = { text, src, fill, color }  — each a path, e.g. 'user.name'
//   node.showIf = { path, op, value }          — shown only while the condition holds
//   node.repeat = { source, as }               — a row/column/wrap container draws its
//                                                children once per item of a list
//   node.action.routes = [{ when: {path, op, value}, target }]
//                                              — conditional navigation, before the
//                                                action's own (fallback) target
//
// Paths start at a name in scope: every mock set by its variable name (a single
// set is one object, a list set is a list), every API provider by its name (same
// shape — its output model, one or a list), plus each enclosing repeat's alias
// (default `item`) for the item being drawn.
//
// A provider's real data only exists in the running app, so the design shows its
// preview data: a mock set of the same model and kind (p.preview, or the only
// matching set). Exported screens read the provider itself. Fields follow by name:
// 'user.address.city', 'item.body_region'. The canvas, Play, the properties
// panel, Claude's tools and the code generator all read the same rules here.

import { state, getNode } from './state.js';
import { flexKind } from './nodes.js';
import { typeToString } from './models.js';

export const OPS = [
  { value: 'truthy', label: 'is true / set', unary: true },
  { value: 'falsy', label: 'is false / not set', unary: true },
  { value: '==', label: 'equals' },
  { value: '!=', label: 'does not equal' },
  { value: '>', label: 'is greater than' },
  { value: '<', label: 'is less than' },
  { value: '>=', label: 'is at least' },
  { value: '<=', label: 'is at most' },
  { value: 'empty', label: 'is empty', unary: true },
  { value: 'notEmpty', label: 'is not empty', unary: true },
];
export const OP_VALUES = OPS.map(o => o.value);
export const isUnary = (op) => !!(OPS.find(o => o.value === op) || {}).unary;

const PRIMITIVES = ['String', 'int', 'double', 'bool'];
const modelById = (id) => state.models.find(m => m.id === id);
const modelByName = (name) => state.models.find(m => m.name === name);
const enumByName = (name) => state.enums.find(e => e.name === name);
const listType = (t) => t && (t.base === 'List' || t.base === 'Set');

// ── scopes ──────────────────────────────────────────────────────────────────
// A scope maps each name in reach → { type, value }.

// Every mock set whose model still exists, by its variable name, and every
// provider with a model output, by its name (showing its preview data). A mock
// set keeps its name if a provider shares it.
export function rootScope() {
  const scope = {};
  for (const set of state.mockSets || []) {
    const m = modelById(set.modelId);
    const name = (set.name || '').trim();
    if (!m || !name) continue;
    const model = { base: m.name, args: [] };
    scope[name] = set.kind === 'list'
      ? { type: { base: 'List', args: [model] }, value: Array.isArray(set.data) ? set.data : [], source: 'mock' }
      : { type: model, value: set.data, source: 'mock' };
  }
  for (const p of state.providers || []) {
    const name = (p.name || '').trim();
    const m = p.output && modelByName(p.output.model);
    if (!m || !name || scope[name]) continue;
    const model = { base: m.name, args: [] };
    const preview = providerPreview(p);
    scope[name] = p.output.type === 'list'
      ? { type: { base: 'List', args: [model] }, value: preview && Array.isArray(preview.data) ? preview.data : [], source: 'provider' }
      : { type: model, value: preview ? preview.data : undefined, source: 'provider' };
  }
  return scope;
}

// The mock set a provider shows in the design: its chosen preview, if that still
// matches its output (same model, same single/list), else the only matching set.
export function providerPreview(p) {
  const m = p && p.output && modelByName(p.output.model);
  if (!m) return null;
  const kind = p.output.type === 'list' ? 'list' : 'single';
  const fits = (s) => s && s.modelId === m.id && s.kind === kind;
  const chosen = p.preview && state.mockSets.find(s => s.id === p.preview);
  if (fits(chosen)) return chosen;
  const matches = state.mockSets.filter(fits);
  return matches.length === 1 ? matches[0] : null;
}
// Mock sets a provider could preview with.
export function previewCandidates(p) {
  const m = p && p.output && modelByName(p.output.model);
  if (!m) return [];
  const kind = p.output.type === 'list' ? 'list' : 'single';
  return state.mockSets.filter(s => s.modelId === m.id && s.kind === kind);
}

// The scope a node's children see when `node` repeats: one per item (the value
// of its alias), or [] when the source is missing or empty.
export function repeatScopes(node, scope) {
  if (!node.repeat || !node.repeat.source) return [];
  const t = pathType(scope, node.repeat.source);
  if (!t.type || !listType(t.type)) return [];
  const items = resolve(scope, node.repeat.source);
  if (!Array.isArray(items)) return [];
  const as = aliasOf(node);
  const itemType = t.type.args[0];
  return items.map(item => ({ ...scope, [as]: { type: itemType, value: item } }));
}
export const aliasOf = (node) => (node.repeat && node.repeat.as ? node.repeat.as : 'item');

// Whether `node` can repeat: a laid-out container (its layout draws the copies).
export const canRepeat = (node) => !!node && (node.type === 'container' || node.type === 'frame')
  && ['row', 'column', 'wrap'].includes(flexKind(node));

// The scope a node's own bindings see: the root scope plus the alias of every
// repeating ancestor, bound to that repeat's first item (what the editable
// template shows on the canvas).
export function scopeFor(node) {
  const chain = [];
  for (let p = node && node.parentId ? getNode(node.parentId) : null; p; p = p.parentId ? getNode(p.parentId) : null) {
    if (p.repeat) chain.unshift(p);
  }
  let scope = rootScope();
  for (const r of chain) {
    const scopes = repeatScopes(r, scope);
    if (scopes.length) scope = scopes[0];
    else {
      // Empty or broken source: the alias still has a type (for pickers), no value.
      const t = pathType(scope, r.repeat.source);
      if (t.type && listType(t.type)) scope = { ...scope, [aliasOf(r)]: { type: t.type.args[0], value: undefined } };
    }
  }
  return scope;
}

// ── paths ───────────────────────────────────────────────────────────────────

// The type at a path: { type } or { error }.
export function pathType(scope, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return { error: 'empty path' };
  const root = scope[parts[0]];
  if (!root) {
    const names = Object.keys(scope);
    return { error: `"${parts[0]}" isn't in scope here (available: ${names.join(', ') || 'no mock data yet'})` };
  }
  let type = root.type;
  for (const field of parts.slice(1)) {
    const m = type && modelByName(type.base);
    if (!m) return { error: `${typeToString(type)} has no fields ("${field}" in ${path})` };
    const f = m.properties.find(p => p.name === field);
    if (!f) return { error: `${m.name} has no field "${field}" (it has ${m.properties.map(p => p.name).join(', ')})` };
    type = f.type;
  }
  return { type };
}

// The value at a path (undefined when any step is missing).
export function resolve(scope, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length || !scope[parts[0]]) return undefined;
  let v = scope[parts[0]].value;
  for (const field of parts.slice(1)) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[field];
  }
  return v;
}

// What each binding slot accepts.
const SLOT_OK = {
  text: (t) => PRIMITIVES.includes(t.base) || !!enumByName(t.base) || (listType(t) && (PRIMITIVES.includes(t.args[0].base) || !!enumByName(t.args[0].base))),
  src: (t) => t.base === 'String',
  fill: (t) => t.base === 'String',
  color: (t) => t.base === 'String',
  list: (t) => listType(t),
  cond: (t) => !modelByName(t.base),
};
export const SLOT_HINT = {
  text: 'a text, number, bool or enum field',
  src: 'a String field holding an image URL',
  fill: 'a String field holding a hex color',
  color: 'a String field holding a hex color',
  list: 'a list',
  cond: 'a field that isn’t a whole model object',
};

// null, or why `path` can't fill `slot` in `scope`.
export function pathError(scope, path, slot) {
  const t = pathType(scope, path);
  if (t.error) return t.error;
  if (!SLOT_OK[slot](t.type)) return `${path} is ${typeToString(t.type)}; this needs ${SLOT_HINT[slot]}`;
  return null;
}

// Every path in scope that fits `slot`, for pickers: [{ path, type, source }]
// (source: 'mock', 'provider' or 'item' — where the root comes from).
export function pathOptions(scope, slot) {
  const out = [];
  const walk = (path, type, depth, source) => {
    if (SLOT_OK[slot](type)) out.push({ path, type: typeToString(type), source });
    const m = modelByName(type.base);
    if (m && depth < 3) m.properties.forEach(p => walk(`${path}.${p.name}`, p.type, depth + 1, source));
  };
  for (const [name, v] of Object.entries(scope)) walk(name, v.type, 0, v.source || 'item');
  return out;
}

// ── values ──────────────────────────────────────────────────────────────────

// A value as the text a bound Text shows.
export function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(asText).join(', ');
  if (typeof v === 'object') return '';
  return String(v);
}

export function evalCond(cond, scope) {
  if (!cond || !cond.path) return true;
  const v = resolve(scope, cond.path);
  const isEmpty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const num = (x) => (typeof x === 'number' ? x : parseFloat(x));
  switch (cond.op) {
    case 'truthy': return !isEmpty && v !== false && v !== 0;
    case 'falsy': return isEmpty || v === false || v === 0;
    case 'empty': return isEmpty;
    case 'notEmpty': return !isEmpty;
    case '==': return typeof v === 'number' ? v === num(cond.value) : String(v) === String(cond.value);
    case '!=': return typeof v === 'number' ? v !== num(cond.value) : String(v) !== String(cond.value);
    case '>': return num(v) > num(cond.value);
    case '<': return num(v) < num(cond.value);
    case '>=': return num(v) >= num(cond.value);
    case '<=': return num(v) <= num(cond.value);
    default: return true;
  }
}

// null, or why a condition can't be evaluated in `scope`.
export function condError(scope, cond) {
  if (!cond || typeof cond !== 'object') return 'a condition is { path, op, value }';
  if (!OP_VALUES.includes(cond.op)) return `op is one of ${OP_VALUES.join(', ')}`;
  const err = pathError(scope, cond.path, 'cond');
  if (err) return err;
  if (isUnary(cond.op)) return null;
  if (cond.value === undefined || cond.value === null || cond.value === '') return `"${cond.op}" needs a value to compare with`;
  const t = pathType(scope, cond.path).type;
  const en = enumByName(t.base);
  if (en && !en.values.some(v => v.name === String(cond.value))) {
    return `${cond.path} is a ${en.name}: compare with one of ${en.values.map(v => v.name).join(', ')}`;
  }
  if (['>', '<', '>=', '<='].includes(cond.op) && !['int', 'double'].includes(t.base) && !listType(t)) {
    return `"${cond.op}" compares numbers; ${cond.path} is ${typeToString(t)}`;
  }
  return null;
}

// A node as it looks with its bindings applied: a shallow stand-in whose text /
// src / fill / color come from the data (only where a binding resolves).
export function viewOf(node, scope) {
  const b = node.bind;
  if (!b) return node;
  const v = Object.create(node);
  if (b.text) { const val = resolve(scope, b.text); if (val !== undefined) v.text = asText(val); }
  if (b.src) { const val = resolve(scope, b.src); if (typeof val === 'string' && val) v.src = val; }
  if (b.fill) {
    const val = resolve(scope, b.fill);
    if (isHex(val)) { v.fill = val; v.colorId = null; v.fillType = 'solid'; v.alpha = 1; }
  }
  return v;
}
// The text color a binding gives (applied over the text's style).
export function boundColor(node, scope) {
  if (!node.bind || !node.bind.color) return null;
  const val = resolve(scope, node.bind.color);
  return isHex(val) ? val : null;
}
const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v);

// The screen a navigate action goes to in `scope`: the first conditional route
// whose condition holds, else the action's own target.
export function routeTarget(action, scope) {
  if (!action || action.type !== 'navigate') return null;
  for (const r of action.routes || []) {
    if (r && r.target && getNode(r.target) && evalCond(r.when, scope)) return r.target;
  }
  return action.targetFrameId && getNode(action.targetFrameId) ? action.targetFrameId : null;
}

// ── Play: the data each drawn copy was rendered with ─────────────────────────
// Repeated copies are drawn from one template, so an element can't find its own
// item from the node tree. The renderer registers each copy's scope here and
// stamps the key on the element (data-scope), which survives Play's DOM clone.
let scopes = [];
export function resetScopes() { scopes = []; }
export function registerScope(scope) { scopes.push(scope); return String(scopes.length - 1); }
export function scopeOfElement(el) {
  const holder = el && el.closest ? el.closest('[data-scope]') : null;
  return holder ? scopes[Number(holder.dataset.scope)] || rootScope() : rootScope();
}
