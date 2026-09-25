import { state } from './state.js';
import { esc, showToast } from './utils.js';
import { ddTrigger } from './dropdown.js';
import { saveHistory } from './history.js';

// Mock Data tab: generate fake instances (single object or list) for any model
// defined in the Model tab. Values are faked from each field's type, with light
// name heuristics (e.g. an "email" String becomes an email-shaped string).

const getModel = (id) => state.models.find(m => m.id === id);
const getModelByName = (name) => state.models.find(m => m.name === name);
const getEnumByName = (name) => state.enums.find(e => e.name === name);
const getMock = (id) => state.mockSets.find(s => s.id === id);

// ───────── Fake value pools ─────────
const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Olivia', 'Ethan', 'Mia', 'Lucas', 'Sophia', 'Aria', 'Kai', 'Zoe', 'Leo', 'Nora', 'Ian'];
const LAST = ['Smith', 'Khan', 'Patel', 'Garcia', 'Chen', 'Rahman', 'Silva', 'Kim', 'Haque', 'Lopez', 'Novak', 'Owens', 'Reed'];
const WORDS = ['lorem', 'ipsum', 'dolor', 'amet', 'nimbus', 'orbit', 'pixel', 'vector', 'ember', 'cobalt', 'echo', 'delta', 'quartz', 'fable', 'maple'];
const DOMAINS = ['example.com', 'mail.io', 'test.dev', 'demo.app', 'inbox.co'];
const CITIES = ['Dhaka', 'Austin', 'Berlin', 'Lagos', 'Tokyo', 'Madrid', 'Toronto', 'Cairo'];
const COUNTRIES = ['Bangladesh', 'USA', 'Germany', 'Nigeria', 'Japan', 'Spain', 'Canada'];
const STATUSES = ['active', 'pending', 'inactive', 'archived'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = () => cap(words(randInt(6, 12))) + '.';
const uuidish = () => 'xxxxxxxx-xxxx-4xxx'.replace(/x/g, () => randInt(0, 15).toString(16));
const isoDate = () => new Date(Date.now() - randInt(0, 365) * 86400000).toISOString().slice(0, 10);

// Fake a String, biased by the field's name so output looks realistic.
function fakeString(field) {
  const f = (field || '').toLowerCase();
  if (f.includes('email')) return `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}@${pick(DOMAINS)}`;
  if (f.includes('first')) return pick(FIRST);
  if (f.includes('last') || f.includes('surname')) return pick(LAST);
  if (f.includes('name')) return `${pick(FIRST)} ${pick(LAST)}`;
  if (f.includes('user')) return (pick(FIRST) + pick(LAST)).toLowerCase();
  if (f.includes('phone') || f.includes('mobile')) return `+1${randInt(200, 999)}${randInt(1000000, 9999999)}`;
  if (f.includes('city')) return pick(CITIES);
  if (f.includes('country')) return pick(COUNTRIES);
  if (f.includes('address') || f.includes('street')) return `${randInt(1, 999)} ${cap(pick(WORDS))} St`;
  if (f.includes('avatar') || f.includes('image') || f.includes('photo') || f.includes('picture')) return `https://picsum.photos/seed/${randInt(1, 999)}/200`;
  if (f.includes('url') || f.includes('link') || f.includes('website')) return `https://${pick(DOMAINS)}`;
  if (f.includes('color') || f.includes('colour')) return pick(['#1ECC7A', '#5b8af5', '#f5576c', '#f7971e']);
  if (f.includes('uuid') || f === 'id' || f.endsWith('_id') || f.endsWith('id')) return uuidish();
  if (f.includes('date') || f.includes('time') || f.endsWith('_at')) return isoDate();
  if (f.includes('status') || f.includes('state')) return pick(STATUSES);
  if (f.includes('title')) return cap(words(randInt(2, 4)));
  if (f.includes('slug')) return words(randInt(1, 2)).replace(/\s/g, '-');
  if (f.includes('desc') || f.includes('bio') || f.includes('about') || f.includes('content') || f.includes('body') || f.includes('text') || f.includes('message') || f.includes('note')) return sentence();
  return cap(words(randInt(1, 2)));
}

// Fake a value for a type tree. `depth` bounds nested model references so
// self-referential or deeply linked models can't recurse forever.
function fakeValue(type, field, depth) {
  if (!type) return null;
  const base = type.base;
  if (base === 'String') return fakeString(field);
  if (base === 'int') {
    const f = (field || '').toLowerCase();
    if (f.includes('age')) return randInt(18, 80);
    if (f.includes('year')) return randInt(1990, 2024);
    if (f.includes('count') || f.includes('qty') || f.includes('quantity') || f.includes('stock')) return randInt(0, 200);
    if (f.includes('price') || f.includes('amount') || f.includes('total')) return randInt(1, 5000);
    if (f === 'id' || f.endsWith('id')) return randInt(1, 9999);
    return randInt(0, 1000);
  }
  if (base === 'double') {
    const f = (field || '').toLowerCase();
    if (f.includes('price') || f.includes('amount')) return Math.round(randInt(1, 5000) * 100 * Math.random()) / 100;
    if (f.includes('rating')) return Math.round(Math.random() * 50) / 10;
    return Math.round(Math.random() * 100000) / 100;
  }
  if (base === 'bool') return Math.random() < 0.5;
  if (base === 'List' || base === 'Set') {
    return Array.from({ length: randInt(2, 4) }, () => fakeValue(type.args[0], field, depth));
  }
  if (base === 'Map') {
    const obj = {};
    for (let i = 0; i < randInt(2, 3); i++) obj[String(fakeValue(type.args[0], 'key', depth))] = fakeValue(type.args[1], field, depth);
    return obj;
  }
  const en = getEnumByName(base);
  if (en) return en.values.length ? pick(en.values).name : null;
  const m = getModelByName(base);
  if (m) return depth >= 2 ? null : genObject(m, depth + 1); // nested model (bounded)
  return null;
}

function genObject(model, depth) {
  const obj = {};
  model.properties.forEach(p => { obj[p.name] = fakeValue(p.type, p.name, depth); });
  return obj;
}

// (Re)generate a mock set's data from its model + kind/count.
export function generate(set) {
  const m = getModel(set.modelId);
  if (!m) { set.data = null; return; }
  if (set.kind === 'list') {
    const n = Math.max(1, Math.min(50, set.count || 5));
    set.data = Array.from({ length: n }, () => genObject(m, 0));
  } else {
    set.data = genObject(m, 0);
  }
}

// A sensible default variable name, e.g. User → "user" (single) / "users" (list).
export function defaultName(model, kind) {
  const base = model.name.charAt(0).toLowerCase() + model.name.slice(1);
  return kind === 'list' ? base + 'List' : base;
}

// ───────── Dart object serialisation ─────────
const indentStr = (n) => '  '.repeat(n);
const dartString = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;

// Render a single value as a Dart literal, using the field's type to know how
// (enums → Type.value, models → nested constructor, collections → [] / {} ...).
function dartValue(val, type, indent) {
  if (val == null) return 'null';
  const base = type ? type.base : null;
  if (base === 'String') return dartString(val);
  if (base === 'int' || base === 'double') return String(val);
  if (base === 'bool') return String(val);
  if (base === 'List' || base === 'Set') {
    const [open, close] = base === 'Set' ? ['{', '}'] : ['[', ']'];
    if (!Array.isArray(val) || !val.length) return open + close;
    const pad = indentStr(indent + 1);
    return `${open}\n${val.map(v => pad + dartValue(v, type.args[0], indent + 1)).join(',\n')}\n${indentStr(indent)}${close}`;
  }
  if (base === 'Map') {
    const entries = Object.entries(val);
    if (!entries.length) return '{}';
    const pad = indentStr(indent + 1);
    return `{\n${entries.map(([k, v]) => `${pad}${dartValue(k, type.args[0], indent + 1)}: ${dartValue(v, type.args[1], indent + 1)}`).join(',\n')}\n${indentStr(indent)}}`;
  }
  if (getEnumByName(base)) return `${base}.${val}`;
  const m = getModelByName(base);
  if (m && typeof val === 'object') return dartObject(m, val, indent);
  return typeof val === 'string' ? dartString(val) : String(val);
}

// Render a model instance as a Dart constructor call with named arguments.
function dartObject(model, obj, indent) {
  const pad = indentStr(indent + 1);
  const fields = model.properties.map(p => `${pad}${p.name}: ${dartValue(obj ? obj[p.name] : null, p.type, indent + 1)}`);
  return `${model.name}(\n${fields.join(',\n')}\n${indentStr(indent)})`;
}

// The full Dart snippet for a mock set: a `final` variable holding the object
// (single) or a list of objects.
export function toDart(set) {
  const m = getModel(set.modelId);
  if (!m || set.data == null) return '// model was deleted — pick another';
  const name = (set.name || '').trim() || defaultName(m, set.kind);
  if (set.kind === 'list') {
    const items = set.data.map(o => '  ' + dartObject(m, o, 1));
    return `final ${name} = [\n${items.join(',\n')}\n];`;
  }
  return `final ${name} = ${dartObject(m, set.data, 0)};`;
}

// ───────── Structured value editor ─────────
// The card body renders the object like Dart code, but only the *values* are
// editable inputs — the field names (keys) and class/structure are static text.
// Each value control carries its path (within set.data) as a JSON data attribute.

export function getAt(root, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), root);
}
function setAt(root, path, val) {
  let o = root;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  if (o) o[path[path.length - 1]] = val;
}

const pAttr = (path) => esc(JSON.stringify(path));

// Editor HTML for one value, driven by its declared type.
function renderValue(value, type, path) {
  const base = type ? type.base : 'String';
  if (base === 'String') return `<input class="mock-val mock-val-str" data-mp="${pAttr(path)}" data-vt="String" value="${esc(value == null ? '' : value)}" spellcheck="false">`;
  if (base === 'int' || base === 'double') return `<input class="mock-val mock-val-num" data-mp="${pAttr(path)}" data-vt="${base}" type="number" value="${value == null ? 0 : value}">`;
  if (base === 'bool') return ddTrigger({ value: String(!!value), options: [{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }], data: { mp: JSON.stringify(path), vt: 'bool' }, triggerClass: 'dd-mockval' });
  const en = getEnumByName(base);
  if (en) return ddTrigger({ value: String(value), options: en.values.map(v => ({ value: v.name, label: `${base}.${v.name}` })), data: { mp: JSON.stringify(path), vt: 'enum' }, triggerClass: 'dd-mockval' });
  if (base === 'List' || base === 'Set') {
    const [open, close] = base === 'Set' ? ['{', '}'] : ['[', ']'];
    const items = Array.isArray(value) ? value : [];
    if (!items.length) return `<span class="mock-punct">${open}${close}</span>`;
    const rows = items.map((it, i) => `<div class="mock-line">${renderValue(it, type.args[0], [...path, i])}<span class="mock-punct">,</span></div>`).join('');
    return `<span class="mock-punct">${open}</span><div class="mock-nest">${rows}</div><span class="mock-punct">${close}</span>`;
  }
  if (base === 'Map') {
    const entries = value && typeof value === 'object' ? Object.entries(value) : [];
    if (!entries.length) return `<span class="mock-punct">{}</span>`;
    const rows = entries.map(([k, v]) => `<div class="mock-line"><span class="mock-key">${esc(k)}:</span> ${renderValue(v, type.args[1], [...path, k])}<span class="mock-punct">,</span></div>`).join('');
    return `<span class="mock-punct">{</span><div class="mock-nest">${rows}</div><span class="mock-punct">}</span>`;
  }
  const m = getModelByName(base);
  if (m && value && typeof value === 'object') return renderObject(m, value, path);
  return `<input class="mock-val mock-val-str" data-mp="${pAttr(path)}" data-vt="String" value="${esc(value == null ? '' : value)}">`;
}

// Editor HTML for a model instance: static "ClassName(", static field names,
// editable values, static ")".
function renderObject(model, obj, path) {
  const fields = model.properties.map(p =>
    `<div class="mock-line"><span class="mock-key">${esc(p.name)}:</span> ${renderValue(obj ? obj[p.name] : null, p.type, [...path, p.name])}<span class="mock-punct">,</span></div>`
  ).join('');
  return `<span class="mock-ctor">${esc(model.name)}(</span><div class="mock-nest">${fields}</div><span class="mock-punct">)</span>`;
}

// The whole editor for a mock set (single object, or a list with add/remove).
function renderEditor(set) {
  const m = getModel(set.modelId);
  if (!m || set.data == null) return `<div class="mock-editor"><span class="mock-punct">// model was deleted — pick another</span></div>`;
  if (set.kind === 'list') {
    const items = (set.data || []).map((o, i) =>
      `<div class="mock-item">${renderObject(m, o, [i])}<span class="mock-punct">,</span><button class="mock-itemdel" data-list-del="${i}" title="Remove item">&times;</button></div>`
    ).join('');
    return `<div class="mock-editor"><span class="mock-punct">[</span><div class="mock-nest">${items}<button class="mock-additem" data-list-add title="Add item">+ add item</button></div><span class="mock-punct">]</span></div>`;
  }
  return `<div class="mock-editor">${renderObject(m, set.data, [])}</div>`;
}

// ───────── Actions ─────────
function addMock() {
  if (!state.models.length) return;
  const m = state.models[0];
  const set = { id: 'mock' + state.nextMockId++, name: defaultName(m, 'single'), modelId: m.id, kind: 'single', count: 5, data: null };
  generate(set);
  state.mockSets.push(set);
  saveHistory();
  renderMock();
}

function deleteMock(id) {
  state.mockSets = state.mockSets.filter(s => s.id !== id);
  saveHistory();
  renderMock();
}

function regenerate(set) {
  if (!set) return;
  generate(set);
  saveHistory();
  renderMock();
}

function setModel(set, modelId) {
  if (!set) return;
  set.modelId = modelId;
  generate(set);
  saveHistory();
  renderMock();
}

function setKind(set, kind) {
  if (!set || set.kind === kind) return;
  set.kind = kind;
  generate(set);
  saveHistory();
  renderMock();
}

// ───────── Rendering ─────────
function renderCard(set) {
  const modelOpts = state.models.map(mm => ({ value: mm.id, label: mm.name }));
  return `
  <div class="mock-card" data-set="${set.id}">
    <div class="model-card-head">
      <input class="model-name-input" data-mockname="${set.id}" value="${esc(set.name)}" spellcheck="false" placeholder="variableName">
      <button class="model-del" data-del-mock="${set.id}" title="Delete mock">&times;</button>
    </div>
    <div class="mock-controls">
      <span class="mock-ctrl-label">Model</span>
      ${ddTrigger({ value: set.modelId, options: modelOpts, data: { mockmodel: set.id }, triggerClass: 'dd-block' })}
      <div class="shape-toggle mock-kind">
        <button class="shape-btn ${set.kind === 'single' ? 'active' : ''}" data-mockkind="single" data-mock="${set.id}">Single</button>
        <button class="shape-btn ${set.kind === 'list' ? 'active' : ''}" data-mockkind="list" data-mock="${set.id}">List</button>
      </div>
      ${set.kind === 'list' ? `
      <span class="mock-ctrl-label">Count</span>
      <input class="prop-input" data-mockcount="${set.id}" type="number" min="1" max="50" value="${set.count || 5}" style="width:60px;flex:0 0 auto">` : ''}
    </div>
    <div class="mock-json-wrap">
      <div class="mock-json-actions">
        <button class="mock-btn" data-regen="${set.id}" title="Generate new values">↻ Regenerate</button>
        <button class="mock-btn" data-copy="${set.id}" title="Copy Dart code">⧉ Copy</button>
      </div>
      ${renderEditor(set)}
    </div>
  </div>`;
}

export function renderMock() {
  const board = document.getElementById('mock-board');
  if (!board) return;
  if (!state.models.length) {
    board.innerHTML = `
      <div class="model-board-head">
        <span class="model-board-title">Mock Data</span>
      </div>
      <div class="model-empty">No models yet — create one in the Model tab first.
        <div style="margin-top:10px"><button class="model-add-btn" id="mock-goto-model">Go to Model tab</button></div>
      </div>`;
    return;
  }
  board.innerHTML = `
    <div class="model-board-head">
      <span class="model-board-title">Mock Data</span>
      <button class="model-add-btn" id="mock-new">+ New Mock</button>
    </div>
    <div class="model-cards">
      ${state.mockSets.map(renderCard).join('')}
      ${state.mockSets.length === 0 ? `<div class="model-empty">No mock data yet — click “+ New Mock” to generate some.</div>` : ''}
    </div>`;
}

export function initMock() {
  const board = document.getElementById('mock-board');
  if (!board) return;

  // The set a value control belongs to (paths are relative to its data).
  const setFor = (t) => { const card = t.closest('.mock-card'); return card ? getMock(card.dataset.set) : null; };

  board.addEventListener('click', e => {
    const t = e.target;
    if (t.id === 'mock-new') return addMock();
    if (t.id === 'mock-goto-model') return document.querySelector('.mode-tab[data-mode="model"]')?.click();
    if (t.dataset.delMock) return deleteMock(t.dataset.delMock);
    if (t.dataset.regen) return regenerate(getMock(t.dataset.regen));
    if (t.dataset.mockkind) return setKind(getMock(t.dataset.mock), t.dataset.mockkind);
    if (t.dataset.copy) {
      const set = getMock(t.dataset.copy);
      if (set) navigator.clipboard?.writeText(toDart(set)).then(() => showToast('Dart code copied')).catch(() => {});
      return;
    }
    // List add / remove an item (the only structural edits in the value editor).
    if (t.dataset.listAdd != null) {
      const set = setFor(t);
      if (set && Array.isArray(set.data)) { set.data.push(genObject(getModel(set.modelId), 0)); saveHistory(); refreshEditor(set); }
      return;
    }
    if (t.dataset.listDel != null) {
      const set = setFor(t);
      if (set && Array.isArray(set.data)) { set.data.splice(Number(t.dataset.listDel), 1); saveHistory(); refreshEditor(set); }
      return;
    }
  });

  // Live edits: name/count, and value inputs in the structured editor.
  board.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.mockname != null) {
      const set = getMock(t.dataset.mockname); if (set) set.name = t.value;
    } else if (t.dataset.mockcount != null) {
      const set = getMock(t.dataset.mockcount);
      if (set) { set.count = Math.max(1, Math.min(50, parseInt(t.value, 10) || 1)); generate(set); refreshEditor(set); }
    } else if (t.classList.contains('mock-val')) {
      const set = setFor(t);
      if (!set) return;
      const path = JSON.parse(t.dataset.mp);
      let v = t.value;
      if (t.dataset.vt === 'int') v = parseInt(t.value, 10) || 0;
      else if (t.dataset.vt === 'double') v = parseFloat(t.value) || 0;
      setAt(set.data, path, v);
    }
  });

  board.addEventListener('change', () => saveHistory());

  // Model picker + bool/enum value dropdowns.
  board.addEventListener('dd:change', e => {
    const t = e.target;
    if (t.dataset.mockmodel) return setModel(getMock(t.dataset.mockmodel), e.detail.value);
    if (t.dataset.mp != null && (t.dataset.vt === 'bool' || t.dataset.vt === 'enum')) {
      const set = setFor(t);
      if (!set) return;
      const path = JSON.parse(t.dataset.mp);
      setAt(set.data, path, t.dataset.vt === 'bool' ? e.detail.value === 'true' : e.detail.value);
      saveHistory();
      refreshEditor(set); // refresh the dropdown's visible label
    }
  });
}

// Re-render just one card's structured editor (after count / list / dropdown
// changes) without rebuilding the whole board, preserving other inputs' focus.
function refreshEditor(set) {
  const card = document.querySelector(`.mock-card[data-set="${set.id}"]`);
  const ed = card && card.querySelector('.mock-editor');
  if (ed) ed.outerHTML = renderEditor(set);
}
