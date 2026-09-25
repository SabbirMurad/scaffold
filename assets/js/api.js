import { state } from './state.js';
import { esc } from './utils.js';
import { validModelNames } from './models.js';
import { providerPreview, previewCandidates } from './data.js';
import { ddTrigger } from './dropdown.js';
import { saveHistory } from './history.js';

// Provider tab: a provider groups related REST endpoints that share one base URL.
// Each provider has a name (camelCase) and an output model. Each endpoint under it
// has its own name, method, version + route, headers, params, optional body, and
// an output that references a model or raw JSON. Providers and endpoints share the
// type/output namespace with the Model tab.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

const getProvider = (id) => state.providers.find(p => p.id === id);
// Endpoint ids are globally unique, so we can resolve one across all providers.
function findApi(id) {
  for (const p of state.providers) {
    const a = p.apis.find(x => x.id === id);
    if (a) return { provider: p, api: a };
  }
  return null;
}
const getApi = (id) => { const f = findApi(id); return f ? f.api : null; };
const getHeader = (api, id) => api && api.headers.find(h => h.id === id);
const getParam = (api, id) => api && (api.params || []).find(p => p.id === id);

// ───────── Naming validation (camelCase, same as Color / Typography) ─────────
function nameError(name) {
  if (!name.trim()) return 'Name can’t be empty';
  if (/^[0-9]/.test(name)) return 'Can’t start with a number';
  if (/\s/.test(name)) return 'No spaces allowed';
  if (/[^A-Za-z0-9]/.test(name)) return 'Only letters and numbers allowed';
  if (!/^[a-z]/.test(name)) return 'Must be camelCase (start with a lowercase letter)';
  return null;
}

export function provNameError(p) {
  const fmt = nameError(p.name);
  if (fmt) return fmt;
  if (state.providers.some(o => o !== p && o.name.trim() === p.name.trim())) return 'Another provider has this name';
  return null;
}

export function apiNameError(provider, api) {
  const fmt = nameError(api.name);
  if (fmt) return fmt;
  if (provider.apis.some(o => o !== api && o.name.trim() === api.name.trim())) return 'Duplicate endpoint name';
  return null;
}

// True when an output references a model that no longer exists (or JSON where it
// isn't allowed). `allowJson` is true for endpoints, false for providers.
function outputRefBad(output, allowJson, models) {
  if (!output.model) return false;
  if (output.model === 'json') return !allowJson;
  return !models.includes(output.model);
}

// Aggregate check used to gate the global export button.
export function anyProviderError() {
  const models = validModelNames();
  for (const p of state.providers) {
    if (provNameError(p)) return true;
    if (outputRefBad(p.output, false, models)) return true;
    for (const a of p.apis) {
      if (apiNameError(p, a)) return true;
      if (outputRefBad(a.output, true, models)) return true;
    }
  }
  return false;
}

// Join base URL + version + route into one path, then append ?key=value query params.
function fullUrl(api) {
  const path = [state.apiBaseUrl, api.version, api.route]
    .map(s => (s || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  const qs = (api.params || [])
    .filter(p => p.key.trim())
    .map(p => `${p.key.trim()}=${p.value.trim()}`)
    .join('&');
  return qs ? `${path}?${qs}` : path;
}

function apiOutputStr(api) {
  if (!api.output.model) return '—';
  if (api.output.model === 'json') return api.output.type === 'list' ? 'List<dynamic>' : 'dynamic';
  return api.output.type === 'list' ? `List<${api.output.model}>` : api.output.model;
}
function provOutputStr(p) {
  if (!p.output.model) return '—';
  return p.output.type === 'list' ? `List<${p.output.model}>` : p.output.model;
}

// ───────── CRUD ─────────
function addProvider() {
  const n = state.nextProviderId++;
  state.providers.push({ id: 'pr' + n, name: 'provider' + n, output: { type: 'single', model: '' }, apis: [] });
  saveHistory();
  renderApi();
}
function delProvider(id) {
  state.providers = state.providers.filter(p => p.id !== id);
  saveHistory();
  renderApi();
}

function addApi(provider) {
  if (!provider) return;
  const n = state.nextApiId++;
  provider.apis.push({
    id: 'a' + n, name: 'endpoint' + n,
    method: 'GET', version: 'v1', route: '',
    params: [], headers: [], body: '',
    output: { type: 'single', model: '' },
  });
  saveHistory();
  renderApi();
}
function delApi(id) {
  const f = findApi(id);
  if (!f) return;
  f.provider.apis = f.provider.apis.filter(a => a.id !== id);
  saveHistory();
  renderApi();
}

function addHeader(api) { if (!api) return; api.headers.push({ id: 'h' + state.nextHeaderId++, key: '', value: '' }); saveHistory(); renderApi(); }
function delHeader(api, id) { if (!api) return; api.headers = api.headers.filter(h => h.id !== id); saveHistory(); renderApi(); }
function addParam(api) { if (!api) return; if (!api.params) api.params = []; api.params.push({ id: 'q' + state.nextParamId++, key: '', value: '' }); saveHistory(); renderApi(); }
function delParam(api, id) { if (!api) return; api.params = (api.params || []).filter(p => p.id !== id); saveHistory(); renderApi(); }

// Live-refresh a card's URL preview without a full re-render.
function updateUrl(api) {
  const el = document.querySelector(`[data-url="${api.id}"]`);
  if (!el) return;
  const u = fullUrl(api);
  el.innerHTML = u ? esc(u) : '<span class="api-url-empty">set base URL &amp; route</span>';
}

// Live-refresh provider / endpoint name warnings (no re-render, keeps focus).
function refreshProvWarns() {
  state.providers.forEach(p => {
    const err = provNameError(p);
    const w = document.querySelector(`[data-provwarn="${p.id}"]`);
    if (w) { w.title = err || ''; w.style.display = err ? '' : 'none'; }
    const inp = document.querySelector(`[data-provname="${p.id}"]`);
    if (inp) inp.classList.toggle('invalid', !!err);
  });
}
function refreshApiWarns(provider) {
  provider.apis.forEach(a => {
    const err = apiNameError(provider, a);
    const w = document.querySelector(`[data-apiwarn="${a.id}"]`);
    if (w) { w.title = err || ''; w.style.display = err ? '' : 'none'; }
    const inp = document.querySelector(`[data-apiname="${a.id}"]`);
    if (inp) inp.classList.toggle('invalid', !!err);
  });
}

function renderEndpointCard(provider, api) {
  const models = validModelNames();
  const hasBody = BODY_METHODS.includes(api.method);
  const nerr = apiNameError(provider, api);

  const headerRows = api.headers.map(h => `
    <div class="api-header-row">
      <input class="api-h-key" data-api="${api.id}" data-h="${h.id}" value="${esc(h.key)}" spellcheck="false" placeholder="Header">
      <input class="api-h-val" data-api="${api.id}" data-h="${h.id}" value="${esc(h.value)}" spellcheck="false" placeholder="Value">
      <button class="prop-del" data-api="${api.id}" data-del-h="${h.id}" title="Remove header">&times;</button>
    </div>`).join('');

  const paramRows = (api.params || []).map(p => `
    <div class="api-header-row">
      <input class="api-p-key" data-api="${api.id}" data-p="${p.id}" value="${esc(p.key)}" spellcheck="false" placeholder="Key">
      <input class="api-p-val" data-api="${api.id}" data-p="${p.id}" value="${esc(p.value)}" spellcheck="false" placeholder="Value">
      <button class="prop-del" data-api="${api.id}" data-del-p="${p.id}" title="Remove parameter">&times;</button>
    </div>`).join('');

  // Endpoint output may be a model OR raw JSON; a missing/deleted model stays
  // visible and flagged rather than silently dropped.
  const modelOptions = [
    { value: '', label: '— none —' },
    { value: 'json', label: 'JSON (dynamic)' },
    ...models.map(nm => ({ value: nm, label: nm })),
  ];
  if (api.output.model && api.output.model !== 'json' && !models.includes(api.output.model)) {
    modelOptions.push({ value: api.output.model, label: '⚠ ' + api.output.model });
  }

  const methodDD = ddTrigger({
    value: api.method,
    options: METHODS.map(m => ({ value: m, label: m, cls: `method-${m}` })),
    data: { api: api.id, field: 'method' },
    triggerClass: 'dd-method',
    labelCls: `method-${api.method}`,
  });
  const outTypeDD = ddTrigger({
    value: api.output.type,
    options: [{ value: 'single', label: 'Single' }, { value: 'list', label: 'List' }],
    data: { api: api.id, field: 'outType' },
  });
  const outModelDD = ddTrigger({ value: api.output.model, options: modelOptions, data: { api: api.id, field: 'outModel' } });

  const u = fullUrl(api);
  return `
  <div class="api-card">
    <div class="api-name-row">
      <input class="api-name-input${nerr ? ' invalid' : ''}" data-apiname="${api.id}" value="${esc(api.name)}" spellcheck="false" placeholder="endpointName">
      <span class="model-warn" data-apiwarn="${api.id}" title="${nerr ? esc(nerr) : ''}"${nerr ? '' : ' style="display:none"'}>&#9888;</span>
      <button class="model-del" data-del-api="${api.id}" title="Delete endpoint">&times;</button>
    </div>
    <div class="api-card-head">
      ${methodDD}
      <input class="api-version" data-api="${api.id}" data-field="version" value="${esc(api.version)}" spellcheck="false" placeholder="v1">
      <input class="api-route" data-api="${api.id}" data-field="route" value="${esc(api.route)}" spellcheck="false" placeholder="users/:id">
    </div>
    <div class="api-url" data-url="${api.id}">${u ? esc(u) : '<span class="api-url-empty">set base URL &amp; route</span>'}</div>

    <div class="api-sec">
      <div class="api-sec-title">Params</div>
      <div class="api-params">${paramRows}</div>
      <button class="prop-add" data-add-p="${api.id}">+ Add param</button>
    </div>

    <div class="api-sec">
      <div class="api-sec-title">Headers</div>
      <div class="api-headers">${headerRows}</div>
      <button class="prop-add" data-add-h="${api.id}">+ Add header</button>
    </div>

    ${hasBody ? `
    <div class="api-sec">
      <div class="api-sec-title">Body</div>
      <textarea class="api-body" data-api="${api.id}" data-field="body" rows="3" spellcheck="false" placeholder="{ }">${esc(api.body)}</textarea>
    </div>` : ''}

    <div class="api-sec">
      <div class="api-sec-title">Output</div>
      <div class="api-output">
        ${outTypeDD}
        ${outModelDD}
        <span class="api-out-preview">${esc(apiOutputStr(api))}</span>
      </div>
    </div>
  </div>`;
}

function renderProviderCard(p) {
  const models = validModelNames();
  const perr = provNameError(p);

  const provModelOptions = [
    { value: '', label: '— none —' },
    ...models.map(nm => ({ value: nm, label: nm })),
  ];
  if (p.output.model && !models.includes(p.output.model)) {
    provModelOptions.push({ value: p.output.model, label: '⚠ ' + p.output.model });
  }
  const outTypeDD = ddTrigger({
    value: p.output.type,
    options: [{ value: 'single', label: 'Single' }, { value: 'list', label: 'List' }],
    data: { prov: p.id, field: 'provOutType' },
  });
  const outModelDD = ddTrigger({ value: p.output.model, options: provModelOptions, data: { prov: p.id, field: 'provOutModel' } });

  return `
  <div class="provider-card">
    <div class="provider-head">
      <input class="model-name-input${perr ? ' invalid' : ''}" data-provname="${p.id}" value="${esc(p.name)}" spellcheck="false" placeholder="providerName">
      <span class="model-warn" data-provwarn="${p.id}" title="${perr ? esc(perr) : ''}"${perr ? '' : ' style="display:none"'}>&#9888;</span>
      <button class="model-del" data-del-prov="${p.id}" title="Delete provider">&times;</button>
    </div>
    <div class="provider-config">
      <div class="provider-output">
        <span class="provider-output-label">Output</span>
        ${outTypeDD}
        ${outModelDD}
        <span class="api-out-preview">${esc(provOutputStr(p))}</span>
      </div>
      <button class="prop-add provider-add" data-add-api="${p.id}">+ Add endpoint</button>
    </div>
    ${providerSourceRow(p)}
    <div class="provider-endpoints">
      ${p.apis.map(a => renderEndpointCard(p, a)).join('')}
      ${p.apis.length === 0 ? `<div class="api-hint" style="margin:2px 0 0">No endpoints yet.</div>` : ''}
    </div>
  </div>`;
}

// What the provider's state is: the endpoint build() loads it with, and the mock
// set that stands in for it in the design tab.
function providerSourceRow(p) {
  if (!p.output.model) return '';
  const loads = loadCandidates(p);
  const loadDD = ddTrigger({
    value: p.load || '',
    options: [{ value: '', label: '— none —' }, ...loads.map(a => ({ value: a.id, label: a.name }))],
    data: { prov: p.id, field: 'provLoad' },
  });
  const auto = providerPreview(p);
  const previewDD = ddTrigger({
    value: p.preview || '',
    options: [
      { value: '', label: auto && !p.preview ? `Auto (${auto.name})` : 'Auto' },
      ...previewCandidates(p).map(s => ({ value: s.id, label: s.name })),
    ],
    data: { prov: p.id, field: 'provPreview' },
  });
  return `
    <div class="provider-source">
      <div class="provider-output"><span class="provider-output-label">Loads with</span>${loadDD}
        <span class="api-hint">${loads.length ? 'build() returns this endpoint\u2019s result' : `add an endpoint whose output is ${esc(provOutputStr(p))}`}</span></div>
      <div class="provider-output"><span class="provider-output-label">Preview data</span>${previewDD}
        <span class="api-hint">${previewCandidates(p).length ? 'shown for this provider in the design tab' : `create ${p.output.type === 'list' ? 'a list' : 'a single'} ${esc(p.output.model)} in Mock Data to preview it`}</span></div>
    </div>`;
}

// Endpoints whose result is the provider's state (same model, same single/list).
export function loadCandidates(p) {
  return p.apis.filter(a => a.output.model === p.output.model && a.output.type === p.output.type);
}

export function renderApi() {
  const board = document.getElementById('api-board');
  if (!board) return;
  const noModels = validModelNames().length === 0;
  board.innerHTML = `
    <div class="api-baseurl">
      <span class="api-baseurl-label">Base URL</span>
      <input class="api-baseurl-input" id="api-baseurl" value="${esc(state.apiBaseUrl)}" spellcheck="false" placeholder="https://api.example.com">
    </div>
    <div class="model-board-head">
      <span class="model-board-title">Providers</span>
      <button class="model-add-btn" id="provider-new">+ New Provider</button>
    </div>
    ${noModels ? `<div class="api-hint" style="margin-bottom:12px">No error-free models yet — create a valid model to use as an output.</div>` : ''}
    <div class="provider-list">
      ${state.providers.map(renderProviderCard).join('')}
      ${state.providers.length === 0 ? `<div class="model-empty">No providers yet — click “+ New Provider” to create one.</div>` : ''}
    </div>`;
}

export function initApi() {
  const board = document.getElementById('api-board');
  if (!board) return;

  board.addEventListener('click', e => {
    const t = e.target;
    if (t.id === 'provider-new') return addProvider();
    if (t.dataset.delProv) return delProvider(t.dataset.delProv);
    if (t.dataset.addApi) return addApi(getProvider(t.dataset.addApi));
    if (t.dataset.delApi) return delApi(t.dataset.delApi);
    if (t.dataset.addH) return addHeader(getApi(t.dataset.addH));
    if (t.dataset.delH) return delHeader(getApi(t.dataset.api), t.dataset.delH);
    if (t.dataset.addP) return addParam(getApi(t.dataset.addP));
    if (t.dataset.delP) return delParam(getApi(t.dataset.api), t.dataset.delP);
  });

  // Text edits: update state in place, refresh URL/name warnings, no re-render.
  board.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'api-baseurl') { state.apiBaseUrl = t.value; state.providers.forEach(p => p.apis.forEach(updateUrl)); return; }
    if (t.dataset.provname != null) { const p = getProvider(t.dataset.provname); if (p) { p.name = t.value; refreshProvWarns(); } return; }
    if (t.dataset.apiname != null) { const f = findApi(t.dataset.apiname); if (f) { f.api.name = t.value; refreshApiWarns(f.provider); } return; }
    const api = getApi(t.dataset.api);
    if (!api) return;
    if (t.dataset.field === 'version') { api.version = t.value; updateUrl(api); }
    else if (t.dataset.field === 'route') { api.route = t.value; updateUrl(api); }
    else if (t.dataset.field === 'body') { api.body = t.value; }
    else if (t.classList.contains('api-h-key')) { const h = getHeader(api, t.dataset.h); if (h) h.key = t.value; }
    else if (t.classList.contains('api-h-val')) { const h = getHeader(api, t.dataset.h); if (h) h.value = t.value; }
    else if (t.classList.contains('api-p-key')) { const p = getParam(api, t.dataset.p); if (p) { p.key = t.value; updateUrl(api); } }
    else if (t.classList.contains('api-p-val')) { const p = getParam(api, t.dataset.p); if (p) { p.value = t.value; updateUrl(api); } }
  });

  // Commit text edits to history on blur/enter (a single entry per field).
  board.addEventListener('change', () => saveHistory());

  // Dropdowns re-render: method toggles the body section, output changes the preview.
  board.addEventListener('dd:change', e => {
    const t = e.target;
    const v = e.detail.value;
    if (t.dataset.prov != null) {
      const p = getProvider(t.dataset.prov);
      if (!p) return;
      if (t.dataset.field === 'provOutType') p.output.type = v;
      else if (t.dataset.field === 'provOutModel') p.output.model = v;
      else if (t.dataset.field === 'provLoad') p.load = v || null;
      else if (t.dataset.field === 'provPreview') p.preview = v || null;
      else return;
      saveHistory();
      return renderApi();
    }
    const api = getApi(t.dataset.api);
    if (!api) return;
    if (t.dataset.field === 'method') api.method = v;
    else if (t.dataset.field === 'outType') api.output.type = v;
    else if (t.dataset.field === 'outModel') api.output.model = v;
    else return;
    saveHistory();
    renderApi();
  });
}
