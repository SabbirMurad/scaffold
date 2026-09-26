import { state } from './state.js';
import { scopeFor, pathType } from './data.js';
import { esc } from './utils.js';
import { ddTrigger } from './dropdown.js';
import { saveHistory } from './history.js';

// Model tab: define data models (entities) with typed properties.
// A property's type is a tree: primitives are leaves; List/Set wrap one type,
// Map wraps two (key, value). This lets types nest, e.g. Map<String, List<int>>.

const PRIMITIVES = ['String', 'int', 'double', 'bool'];
const COLLECTIONS = ['List', 'Set', 'Map'];

// Build a fresh type subtree for a chosen base, seeding collection args.
function makeType(base) {
  if (base === 'List' || base === 'Set') return { base, args: [makeType('String')] };
  if (base === 'Map') return { base, args: [makeType('String'), makeType('String')] };
  return { base, args: [] };
}

// Render a type tree to a Dart-style string, e.g. "Map<String, List<int>>".
export function typeToString(t) {
  if (!t) return '';
  if (t.base === 'List') return `List<${typeToString(t.args[0])}>`;
  if (t.base === 'Set') return `Set<${typeToString(t.args[0])}>`;
  if (t.base === 'Map') return `Map<${typeToString(t.args[0])}, ${typeToString(t.args[1])}>`;
  return t.base;
}

const getModel = (id) => state.models.find(m => m.id === id);
const getEnum = (id) => state.enums.find(e => e.id === id);

// Dart's reserved words: never usable as a field, value or variable name.
export const DART_KEYWORDS = new Set(['assert', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'default', 'do', 'else', 'enum', 'extends', 'false', 'final', 'finally', 'for', 'if', 'in', 'is',
  'new', 'null', 'rethrow', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'var', 'void', 'while',
  'with', 'yield']);
// Type names the generated code already uses (Dart core, Flutter): a model or enum
// with one of these names would shadow it and break the app.
const TAKEN_TYPES = new Set(['String', 'int', 'double', 'bool', 'num', 'List', 'Set', 'Map', 'Object', 'Iterable',
  'Future', 'Stream', 'DateTime', 'Duration', 'Function', 'Type', 'Null', 'Never', 'Record', 'Enum', 'Symbol',
  'Uri', 'Error', 'Exception', 'Color', 'Colors', 'Widget', 'State', 'Key', 'Icon', 'Icons', 'Text', 'Image',
  'Theme', 'ThemeData', 'Size', 'Offset', 'Route', 'Material', 'Scaffold', 'Container', 'Row', 'Column']);
// Members every generated model class has (plus Object's), so no field may use them.
const MODEL_MEMBERS = new Set(['copyWith', 'toJson', 'fromJson', 'fromJsonList', 'hashCode', 'runtimeType', 'toString', 'noSuchMethod']);
// Members every Dart enum has.
const ENUM_MEMBERS = new Set(['values', 'index', 'name', 'hashCode', 'runtimeType', 'toString', 'noSuchMethod']);

// Validate a model name against Dart class-name rules (PascalCase identifier).
// Returns a human-readable issue, or null when the name is valid.
function nameError(name) {
  if (!name.trim()) return 'Name can’t be empty';
  if (/^[0-9]/.test(name)) return 'Can’t start with a number';
  if (/\s/.test(name)) return 'No spaces allowed';
  if (/[^A-Za-z0-9]/.test(name)) return 'Only letters and numbers allowed';
  if (!/^[A-Z]/.test(name)) return 'Must be PascalCase (start with a capital letter)';
  if (TAKEN_TYPES.has(name)) return `“${name}” is already a Dart / Flutter type`;
  return null;
}

// Validate a field name against snake_case rules. Returns an issue, or null.
function fieldNameError(name) {
  if (!name.trim()) return 'Name can’t be empty';
  if (/^[0-9]/.test(name)) return 'Can’t start with a number';
  if (/\s/.test(name)) return 'No spaces allowed';
  if (/[A-Z]/.test(name)) return 'Must be snake_case (use lowercase)';
  if (/[^a-z0-9_]/.test(name)) return 'Only lowercase letters, numbers and underscores';
  if (DART_KEYWORDS.has(name)) return `“${name}” is a Dart keyword`;
  if (MODEL_MEMBERS.has(name)) return `“${name}” is used by the generated class`;
  return null;
}

// A field's type must name things that exist: a primitive, a collection, or a
// current model / enum (a deleted or renamed one would export broken code).
function typeError(t) {
  if (!t) return 'No type';
  const known = [...PRIMITIVES, ...COLLECTIONS];
  if (!known.includes(t.base) && !state.models.some(m => m.name === t.base) && !state.enums.some(e => e.name === t.base)) {
    return `Type “${t.base}” doesn’t exist (deleted or renamed?)`;
  }
  for (const a of t.args || []) { const e = typeError(a); if (e) return e; }
  return null;
}

// Full validation for a field: name format, uniqueness within its model, type.
export function propError(model, prop) {
  const fmt = fieldNameError(prop.name);
  if (fmt) return fmt;
  if (model.properties.some(o => o !== prop && o.name.trim() === prop.name.trim())) {
    return 'Duplicate field name';
  }
  return typeError(prop.type);
}

// ───────── Following a rename ─────────
// Types, API outputs and mock data refer to models, enums, fields and enum values
// by name, as do the design's data bindings — so a rename is carried through all
// of them, or they'd silently break.

// Field types and API outputs name models/enums.
export function renameTypeRefs(from, to) {
  if (!from || from === to) return;
  const walk = (t) => { if (!t) return; if (t.base === from) t.base = to; (t.args || []).forEach(walk); };
  state.models.forEach(m => m.properties.forEach(p => walk(p.type)));
  state.providers.forEach(p => {
    if (p.output.model === from) p.output.model = to;
    p.apis.forEach(a => { if (a.output.model === from) a.output.model = to; });
  });
}

// Visit every value of a type in the mock data: fn(value, type, setValue).
function walkMockValues(fn) {
  const visit = (v, t, set, depth) => {
    if (!t || depth > 12) return;
    fn(v, t, set);
    if (v == null) return;
    if ((t.base === 'List' || t.base === 'Set') && Array.isArray(v)) v.forEach((x, i) => visit(x, t.args[0], nv => { v[i] = nv; }, depth + 1));
    else if (t.base === 'Map' && typeof v === 'object') Object.keys(v).forEach(k => visit(v[k], t.args[1], nv => { v[k] = nv; }, depth + 1));
    else {
      const m = state.models.find(mm => mm.name === t.base);
      if (m && typeof v === 'object') m.properties.forEach(p => visit(v[p.name], p.type, nv => { v[p.name] = nv; }, depth + 1));
    }
  };
  (state.mockSets || []).forEach(s => {
    const m = state.models.find(mm => mm.id === s.modelId);
    if (!m || s.data == null) return;
    const t = { base: m.name, args: [] };
    if (s.kind === 'list' && Array.isArray(s.data)) s.data.forEach((x, i) => visit(x, t, nv => { s.data[i] = nv; }, 0));
    else visit(s.data, t, nv => { s.data = nv; }, 0);
  });
}

// Every data path on the canvas, with where it's used: bindings, conditions,
// repeat sources, conditional routes. fn(path, node, setPath).
function forEachDataPath(fn) {
  state.nodes.forEach(n => {
    if (n.bind) Object.keys(n.bind).forEach(k => fn(n.bind[k], n, p => { n.bind[k] = p; }));
    if (n.showIf && n.showIf.path) fn(n.showIf.path, n, p => { n.showIf.path = p; }, n.showIf);
    if (n.repeat && n.repeat.source) fn(n.repeat.source, n, p => { n.repeat.source = p; });
    ((n.action && n.action.routes) || []).forEach(r => { if (r && r.when && r.when.path) fn(r.when.path, n, p => { r.when.path = p; }, r.when); });
  });
}

// A field of `model` renamed `from` → `to` (already renamed on the model).
function renameFieldRefs(model, from, to) {
  if (!from || from === to) return;
  walkMockValues((v, t) => {
    if (t.base === model.name && v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, from)) {
      v[to] = v[from];
      delete v[from];
    }
  });
  forEachDataPath((path, node, setPath) => {
    const parts = String(path).split('.');
    const scope = scopeFor(node);
    if (!scope[parts[0]]) return;
    let type = scope[parts[0]].type, changed = false;
    for (let i = 1; i < parts.length && type; i++) {
      const m = state.models.find(mm => mm.name === type.base);
      if (!m) return;
      if (m.id === model.id && parts[i] === from) { parts[i] = to; changed = true; }
      const f = m.properties.find(p => p.name === parts[i]);
      type = f && f.type;
    }
    if (changed) setPath(parts.join('.'));
  });
}

// A value of enum `en` renamed `from` → `to`.
function renameEnumValueRefs(en, from, to) {
  if (!from || from === to) return;
  walkMockValues((v, t, set) => { if (t.base === en.name && v === from) set(to); });
  forEachDataPath((path, node, _set, cond) => {
    if (!cond || cond.value !== from) return;
    const t = pathType(scopeFor(node), path).type;
    if (t && t.base === en.name) cond.value = to;
  });
}

// Names as they were when their input got focus, so a commit knows what changed.
const nameAtFocus = new Map();

// Sync a model's field warning icons + input outlines (no re-render). Renaming
// one field can change another's duplicate status, so refresh them all.
function refreshPropWarns(model) {
  model.properties.forEach(p => {
    const err = propError(model, p);
    const warn = document.querySelector(`.prop-warn[data-pwarn="${p.id}"]`);
    if (warn) { warn.title = err || ''; warn.style.display = err ? '' : 'none'; }
    const input = document.querySelector(`.prop-name-input[data-prop="${p.id}"]`);
    if (input) input.classList.toggle('invalid', !!err);
  });
}

// Names of models that pass all validation — used by the API tab's output picker.
export function validModelNames() {
  return state.models.filter(m => modelError(m) === null).map(m => m.name);
}

// Full validation for a model: name format, then uniqueness across models.
export function modelError(m) {
  const fmt = nameError(m.name);
  if (fmt) return fmt;
  if (state.models.some(o => o !== m && o.name.trim() === m.name.trim())) {
    return 'Another model has this name';
  }
  if (state.enums.some(e => e.name.trim() === m.name.trim())) {
    return 'An enum already has this name';
  }
  return null;
}

// ───────── Enums ─────────

// Enum names follow the same PascalCase rule as models; they share the type
// namespace, so an enum can't collide with another enum or a model.
export function enumError(en) {
  const fmt = nameError(en.name);
  if (fmt) return fmt;
  if (state.enums.some(o => o !== en && o.name.trim() === en.name.trim())) return 'Another enum has this name';
  if (state.models.some(m => m.name.trim() === en.name.trim())) return 'A model already has this name';
  return null;
}

// Enum value names are camelCase identifiers, unique within their enum.
function enumValNameError(name) {
  if (!name.trim()) return 'Name can’t be empty';
  if (/^[0-9]/.test(name)) return 'Can’t start with a number';
  if (/\s/.test(name)) return 'No spaces allowed';
  if (/[^A-Za-z0-9]/.test(name)) return 'Only letters and numbers allowed';
  if (!/^[a-z]/.test(name)) return 'Must be camelCase (start with a lowercase letter)';
  if (DART_KEYWORDS.has(name)) return `“${name}” is a Dart keyword`;
  if (ENUM_MEMBERS.has(name)) return `“${name}” is used by every Dart enum`;
  return null;
}
export function enumValError(en, v) {
  const fmt = enumValNameError(v.name);
  if (fmt) return fmt;
  if (en.values.some(o => o !== v && o.name.trim() === v.name.trim())) return 'Duplicate value';
  return null;
}

// Deep validity for export gating: a model is broken if its name is invalid OR
// any of its field names are (modelError only checks the name itself).
export function anyModelError() {
  return state.models.some(m => modelError(m) !== null || m.properties.some(p => propError(m, p) !== null));
}

// Likewise an enum is broken if its name OR any of its value names are invalid.
export function anyEnumError() {
  return state.enums.some(en => enumError(en) !== null || en.values.some(v => enumValError(en, v) !== null));
}

// Sync enum name warnings (renaming can change a model's collision status too).
function refreshEnumWarns() {
  state.enums.forEach(en => {
    const err = enumError(en);
    const w = document.querySelector(`[data-enumwarn="${en.id}"]`);
    if (w) { w.title = err || ''; w.style.display = err ? '' : 'none'; }
    const input = document.querySelector(`[data-ename="${en.id}"]`);
    if (input) input.classList.toggle('invalid', !!err);
  });
  refreshAllWarns();
}

function refreshEnumValWarns(en) {
  en.values.forEach(v => {
    const err = enumValError(en, v);
    const w = document.querySelector(`[data-evalwarn="${v.id}"]`);
    if (w) { w.title = err || ''; w.style.display = err ? '' : 'none'; }
    const input = document.querySelector(`[data-evid="${v.id}"]`);
    if (input) input.classList.toggle('invalid', !!err);
  });
}

function addEnum() {
  const n = state.nextEnumId++;
  state.enums.push({ id: 'e' + n, name: 'Enum' + n, values: [{ id: 'ev' + state.nextEnumValId++, name: 'valueOne' }] });
  saveHistory();
  renderModels();
}

function deleteEnum(id) {
  state.enums = state.enums.filter(e => e.id !== id);
  saveHistory();
  renderModels();
}

function addEnumValue(en) {
  if (!en) return;
  en.values.push({ id: 'ev' + state.nextEnumValId++, name: 'value' });
  saveHistory();
  renderModels();
}

function deleteEnumValue(en, valId) {
  if (!en) return;
  en.values = en.values.filter(v => v.id !== valId);
  saveHistory();
  renderModels();
}

// Sync every card's warning icon + input outline (no re-render). Renaming one
// model can change another's duplicate status, so refresh them all.
function refreshAllWarns() {
  state.models.forEach(m => {
    const err = modelError(m);
    const warn = document.querySelector(`.model-warn[data-warn="${m.id}"]`);
    if (warn) { warn.title = err || ''; warn.style.display = err ? '' : 'none'; }
    const input = document.querySelector(`.model-name-input[data-model="${m.id}"]`);
    if (input) input.classList.toggle('invalid', !!err);
  });
}

function addModel() {
  const n = state.nextModelId++;
  state.models.push({ id: 'm' + n, name: 'Model' + n, properties: [] });
  saveHistory();
  renderModels();
}

function deleteModel(id) {
  state.models = state.models.filter(m => m.id !== id);
  saveHistory();
  renderModels();
}

// Pick a free name by stripping any trailing digits and appending the next
// unused number, e.g. "User" → "User2", "User2" → "User3".
function uniqueName(name) {
  const base = name.replace(/\d+$/, '') || name;
  const taken = new Set([...state.models.map(m => m.name), ...state.enums.map(e => e.name)]);
  let n = 2;
  while (taken.has(base + n)) n++;
  return base + n;
}

function duplicateModel(id) {
  const src = getModel(id);
  if (!src) return;
  const clone = JSON.parse(JSON.stringify(src));
  clone.id = 'm' + state.nextModelId++;
  clone.name = uniqueName(src.name);
  clone.properties.forEach(p => { p.id = 'p' + state.nextPropId++; });
  state.models.splice(state.models.indexOf(src) + 1, 0, clone);
  saveHistory();
  renderModels();
}

function addProperty(model) {
  if (!model) return;
  model.properties.push({ id: 'p' + state.nextPropId++, name: 'field', type: makeType('String'), required: true });
  saveHistory();
  renderModels();
}

// Toggle a field between required and optional (default is required).
function toggleRequired(model, propId) {
  if (!model) return;
  const p = model.properties.find(p => p.id === propId);
  if (!p) return;
  p.required = !(p.required !== false);
  saveHistory();
  renderModels();
}

function deleteProperty(model, propId) {
  if (!model) return;
  model.properties = model.properties.filter(p => p.id !== propId);
  saveHistory();
  renderModels();
}

// Replace the type subtree at `path` (array of arg indices) within a property.
function setTypeAtPath(prop, path, newType) {
  if (path.length === 0) { prop.type = newType; return; }
  let node = prop.type;
  for (let i = 0; i < path.length - 1; i++) node = node.args[path[i]];
  node.args[path[path.length - 1]] = newType;
}

// Recursively render the cascading dropdowns for a type (and its generic args).
function renderTypePicker(t, modelId, propId, path) {
  const modelNames = state.models.map(m => m.name);
  const enumNames = state.enums.map(e => e.name);
  const options = [
    ...PRIMITIVES.map(v => ({ value: v, label: v, group: 'Primitive' })),
    ...COLLECTIONS.map(v => ({ value: v, label: v, group: 'Collection' })),
    ...modelNames.map(v => ({ value: v, label: v, group: 'Models' })),
    ...enumNames.map(v => ({ value: v, label: v, group: 'Enums' })),
  ];
  // Keep an unknown base (e.g. a renamed/deleted model/enum reference) selectable.
  const known = [...PRIMITIVES, ...COLLECTIONS, ...modelNames, ...enumNames];
  if (!known.includes(t.base)) options.unshift({ value: t.base, label: t.base });

  let html = ddTrigger({ value: t.base, options, data: { model: modelId, prop: propId, path: path.join('.') } });
  if (t.base === 'List' || t.base === 'Set') {
    html += `<span class="mtype-b">&lt;</span>${renderTypePicker(t.args[0], modelId, propId, [...path, 0])}<span class="mtype-b">&gt;</span>`;
  } else if (t.base === 'Map') {
    html += `<span class="mtype-b">&lt;</span>${renderTypePicker(t.args[0], modelId, propId, [...path, 0])}`
          + `<span class="mtype-c">,</span>${renderTypePicker(t.args[1], modelId, propId, [...path, 1])}`
          + `<span class="mtype-b">&gt;</span>`;
  }
  return html;
}

function renderCard(m) {
  const props = m.properties.map(p => {
    const perr = propError(m, p);
    const required = p.required !== false;
    return `
    <div class="model-prop">
      <input class="prop-name-input${perr ? ' invalid' : ''}" data-model="${m.id}" data-prop="${p.id}" value="${esc(p.name)}" spellcheck="false" placeholder="name">
      <span class="prop-warn" data-pwarn="${p.id}" title="${perr ? esc(perr) : ''}"${perr ? '' : ' style="display:none"'}>&#9888;</span>
      <div class="prop-type">${renderTypePicker(p.type, m.id, p.id, [])}</div>
      <button class="prop-req ${required ? 'required' : 'optional'}" data-model="${m.id}" data-req-prop="${p.id}" title="${required ? 'Required — click to make optional' : 'Optional — click to make required'}">${required ? 'required' : 'optional'}</button>
      <button class="prop-del" data-model="${m.id}" data-del-prop="${p.id}" title="Remove property">&times;</button>
    </div>`;
  }).join('');

  const err = modelError(m);
  return `
  <div class="model-card">
    <div class="model-card-head">
      <input class="model-name-input${err ? ' invalid' : ''}" data-model="${m.id}" value="${esc(m.name)}" spellcheck="false" placeholder="ModelName">
      <span class="model-warn" data-warn="${m.id}" title="${err ? esc(err) : ''}"${err ? '' : ' style="display:none"'}>&#9888;</span>
      <button class="model-dup" data-dup-model="${m.id}" title="Duplicate model">&#10697;</button>
      <button class="model-del" data-del-model="${m.id}" title="Delete model">&times;</button>
    </div>
    <div class="model-props">${props || ''}</div>
    <button class="prop-add" data-add-prop="${m.id}">+ Add property</button>
  </div>`;
}

function renderEnumCard(en) {
  const err = enumError(en);
  const vals = en.values.map(v => {
    const verr = enumValError(en, v);
    return `
    <div class="model-prop">
      <input class="prop-name-input${verr ? ' invalid' : ''}" data-evid="${v.id}" data-eid="${en.id}" value="${esc(v.name)}" spellcheck="false" placeholder="value" style="flex:1;width:auto">
      <span class="prop-warn" data-evalwarn="${v.id}" title="${verr ? esc(verr) : ''}"${verr ? '' : ' style="display:none"'}>&#9888;</span>
      <button class="prop-del" data-eid="${en.id}" data-del-eval="${v.id}" title="Remove value">&times;</button>
    </div>`;
  }).join('');

  return `
  <div class="model-card">
    <div class="model-card-head">
      <input class="model-name-input${err ? ' invalid' : ''}" data-ename="${en.id}" value="${esc(en.name)}" spellcheck="false" placeholder="EnumName">
      <span class="model-warn" data-enumwarn="${en.id}" title="${err ? esc(err) : ''}"${err ? '' : ' style="display:none"'}>&#9888;</span>
      <button class="model-del" data-del-enum="${en.id}" title="Delete enum">&times;</button>
    </div>
    <div class="model-props">${vals || ''}</div>
    <button class="prop-add" data-add-eval="${en.id}">+ Add value</button>
  </div>`;
}

export function renderModels() {
  const board = document.getElementById('model-board');
  if (!board) return;
  board.innerHTML = `
    <div class="model-section">
      <div class="model-board-head">
        <span class="model-board-title">Enums</span>
        <button class="model-add-btn" id="enum-new">+ New Enum</button>
      </div>
      <div class="model-cards">
        ${state.enums.map(renderEnumCard).join('')}
        ${state.enums.length === 0 ? `<div class="model-empty">No enums yet — click “+ New Enum” to create one.</div>` : ''}
      </div>
    </div>
    <div class="model-section">
      <div class="model-board-head">
        <span class="model-board-title">Models</span>
        <button class="model-add-btn" id="model-new">+ New Model</button>
      </div>
      <div class="model-cards">
        ${state.models.map(renderCard).join('')}
        ${state.models.length === 0 ? `<div class="model-empty">No models yet — click “+ New Model” to create one.</div>` : ''}
      </div>
    </div>`;
}

export function initModels() {
  const board = document.getElementById('model-board');
  if (!board) return;

  board.addEventListener('click', e => {
    const t = e.target;
    if (t.id === 'model-new') return addModel();
    if (t.dataset.addProp) return addProperty(getModel(t.dataset.addProp));
    if (t.dataset.dupModel) return duplicateModel(t.dataset.dupModel);
    if (t.dataset.delModel) return deleteModel(t.dataset.delModel);
    if (t.dataset.reqProp) return toggleRequired(getModel(t.dataset.model), t.dataset.reqProp);
    if (t.dataset.delProp) return deleteProperty(getModel(t.dataset.model), t.dataset.delProp);
    if (t.id === 'enum-new') return addEnum();
    if (t.dataset.addEval) return addEnumValue(getEnum(t.dataset.addEval));
    if (t.dataset.delEnum) return deleteEnum(t.dataset.delEnum);
    if (t.dataset.delEval) return deleteEnumValue(getEnum(t.dataset.eid), t.dataset.delEval);
  });

  // Live name edits: update state without re-rendering so focus/caret is kept.
  board.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.ename != null) {
      const en = getEnum(t.dataset.ename); if (en) { en.name = t.value; refreshEnumWarns(); }
    } else if (t.dataset.evid != null) {
      const en = getEnum(t.dataset.eid);
      const v = en && en.values.find(v => v.id === t.dataset.evid);
      if (v) { v.name = t.value; refreshEnumValWarns(en); }
    } else if (t.classList.contains('model-name-input')) {
      const m = getModel(t.dataset.model); if (m) { m.name = t.value; refreshAllWarns(); }
    } else if (t.classList.contains('prop-name-input')) {
      const m = getModel(t.dataset.model);
      const p = m && m.properties.find(p => p.id === t.dataset.prop);
      if (p) { p.name = t.value; refreshPropWarns(m); }
    }
  });

  // Type picker selection (custom dropdown fires dd:change).
  board.addEventListener('dd:change', e => {
    const t = e.target;
    const m = getModel(t.dataset.model);
    const p = m && m.properties.find(p => p.id === t.dataset.prop);
    if (!p) return;
    const path = t.dataset.path === '' ? [] : t.dataset.path.split('.').map(Number);
    setTypeAtPath(p, path, makeType(e.detail.value));
    saveHistory();
    renderModels();
  });

  // Remember each name as it was when editing began…
  board.addEventListener('focusin', e => {
    const t = e.target;
    if (t.tagName === 'INPUT') nameAtFocus.set(t, t.value);
  });

  // …and on commit (blur/enter) carry a rename through everything that uses the
  // name, record history, and re-render so type dropdowns pick it up.
  board.addEventListener('change', e => {
    const t = e.target;
    const from = nameAtFocus.has(t) ? nameAtFocus.get(t) : null;
    nameAtFocus.set(t, t.value);
    const to = t.value;
    // Only a name that's valid and free is carried through — never merged into
    // another model's or enum's references.
    const free = (n) => !state.models.some(m => m.name === n && m.id !== t.dataset.model) && !state.enums.some(x => x.name === n && x.id !== t.dataset.ename);
    if (t.dataset.ename != null) {
      const en = getEnum(t.dataset.ename);
      if (en && from && !enumError(en) && free(to)) renameTypeRefs(from, to);
    } else if (t.dataset.evid != null) {
      const en = getEnum(t.dataset.eid);
      const v = en && en.values.find(x => x.id === t.dataset.evid);
      if (v && from && !enumValError(en, v)) renameEnumValueRefs(en, from, to);
    } else if (t.classList.contains('model-name-input')) {
      const m = getModel(t.dataset.model);
      if (m && from && !modelError(m) && free(to)) renameTypeRefs(from, to);
    } else if (t.classList.contains('prop-name-input')) {
      const m = getModel(t.dataset.model);
      const p = m && m.properties.find(x => x.id === t.dataset.prop);
      if (p && from && !propError(m, p)) renameFieldRefs(m, from, to);
    } else return;
    saveHistory();
    renderModels();
  });
}
