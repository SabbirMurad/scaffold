import { state } from './state.js';
import { esc } from './utils.js';
import { colorCss } from './colors.js';
import { ddTrigger } from './dropdown.js';
import { saveHistory } from './history.js';
import { ensureFontLoaded } from './google-fonts.js';

// Typography tab: reusable text styles (a grid of specimen cards). Selecting a
// card edits it in the left controller; the color is picked from the Color tab
// the same way design nodes reference colour variables.

const WEIGHTS = ['300', '400', '500', '600', '700'];
const SAMPLE_LINE = 'The quick brown fox jumps over the lazy dog';
const SAMPLE_PARA = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs — how vexingly quick daft zebras jump!';
const SAMPLE_GLYPHS = 'AaBbCcDd Ee 0123456789';

const getTypo = (id) => state.typography.find(t => t.id === id);
const getColor = (id) => state.colors.find(c => c.id === id);
const cssFamily = (f) => (/\s/.test(f) ? `'${f}'` : f);

// Validate a style name against camelCase rules — same as the Color tab.
function nameError(name) {
  if (!name.trim()) return 'Name can’t be empty';
  if (/^[0-9]/.test(name)) return 'Can’t start with a number';
  if (/\s/.test(name)) return 'No spaces allowed';
  if (/[^A-Za-z0-9]/.test(name)) return 'Only letters and numbers allowed';
  if (!/^[a-z]/.test(name)) return 'Must be camelCase (start with a lowercase letter)';
  return null;
}

// Full validation: name format, then uniqueness across styles.
export function typoError(t) {
  const fmt = nameError(t.name);
  if (fmt) return fmt;
  if (state.typography.some(o => o !== t && o.name.trim() === t.name.trim())) return 'Another style has this name';
  return null;
}

// True when any text style has a validation error (gates the export button).
export function anyTypoError() {
  return state.typography.some(t => typoError(t) !== null);
}

// Sync the controller's name warning icon + input outline without rebuilding.
function refreshTypoWarn(t) {
  const err = typoError(t);
  const warn = document.querySelector('#typo-panel [data-twarn]');
  if (warn) { warn.title = err || ''; warn.style.display = err ? '' : 'none'; }
  const input = document.querySelector('#typo-panel [data-tname]');
  if (input) input.classList.toggle('invalid', !!err);
}

// Sync every board card's warning icon (renaming one can change another's
// duplicate status, so refresh them all).
function refreshAllCardWarns() {
  state.typography.forEach(t => {
    const err = typoError(t);
    const w = document.querySelector(`[data-tcardwarn="${t.id}"]`);
    if (w) { w.title = err || ''; w.style.display = err ? '' : 'none'; }
  });
}

// Inline CSS for a text style, resolving its referenced colour variable.
// Text colour must be solid (a gradient isn't a valid `color`), so anything else
// falls back to the default text colour.
function typoCss(t) {
  ensureFontLoaded(t.fontFamily);
  const c = t.colorId ? getColor(t.colorId) : null;
  const col = c && c.fillType === 'solid' ? colorCss(c) : 'var(--text)';
  return `font-family:${cssFamily(t.fontFamily)};font-size:${t.fontSize}px;font-weight:${t.fontWeight};`
       + `line-height:${t.lineHeight};letter-spacing:${t.letterSpacing}px;color:${col}`;
}

function metaText(t) {
  return `${t.fontFamily} · ${t.fontSize}px · ${t.fontWeight} · lh ${t.lineHeight}`;
}

function addTypo() {
  const n = state.nextTypoId++;
  state.typography.push({
    id: 't' + n, name: 'style' + n, fontFamily: 'IBM Plex Sans',
    fontSize: 16, fontWeight: '400', lineHeight: 1.4, letterSpacing: 0, colorId: null,
  });
  state.selectedTypoId = 't' + n;
  saveHistory();
  renderTypography();
}

function deleteTypo(id) {
  state.typography = state.typography.filter(t => t.id !== id);
  if (state.selectedTypoId === id) state.selectedTypoId = state.typography.length ? state.typography[0].id : null;
  saveHistory();
  renderTypography();
}

function renderCard(t) {
  const sel = state.selectedTypoId === t.id;
  const css = typoCss(t);
  const err = typoError(t);
  return `
  <div class="typo-card ${sel ? 'selected' : ''}" data-typo="${t.id}">
    <div class="typo-card-head">
      <span class="typo-name-wrap">
        <span class="typo-name" data-tcardname="${t.id}">${esc(t.name)}</span>
        <span class="model-warn" data-tcardwarn="${t.id}" title="${err ? esc(err) : ''}"${err ? '' : ' style="display:none"'}>&#9888;</span>
      </span>
      <span class="typo-meta" data-tcardmeta="${t.id}">${esc(metaText(t))}</span>
      <button class="model-del" data-tcarddel="${t.id}" title="Delete style">&times;</button>
    </div>
    <div class="typo-samples">
      <div class="typo-sample typo-sample-single" style="${css}">${esc(SAMPLE_LINE)}</div>
      <div class="typo-sample" style="${css}">${esc(SAMPLE_PARA)}</div>
      <div class="typo-sample" style="${css}">${esc(SAMPLE_GLYPHS)}</div>
    </div>
  </div>`;
}

function renderBoard() {
  const board = document.getElementById('typo-board');
  if (!board) return;
  board.innerHTML = `
    <div class="model-board-head">
      <span class="model-board-title">Typography</span>
      <button class="model-add-btn" id="typo-new">+ New</button>
    </div>
    <div class="typo-cards">
      ${state.typography.map(renderCard).join('')}
      ${state.typography.length === 0 ? `<div class="model-empty">No text styles yet — click “+ New” to create one.</div>` : ''}
    </div>`;
}

function renderPanel() {
  const panel = document.getElementById('typo-panel');
  if (!panel) return;
  const t = getTypo(state.selectedTypoId);
  if (!t) {
    panel.innerHTML = `
      <div class="panel-header"><span class="panel-title">Type</span></div>
      <div class="empty-state">Select a style<br>to edit it</div>`;
    return;
  }
  const familyBtn = `<button class="font-picker-btn" data-fontpick style="font-family:${cssFamily(t.fontFamily)}"><span class="font-picker-name">${esc(t.fontFamily)}</span><span class="font-picker-caret">&#9662;</span></button>`;
  const weightDD = ddTrigger({ value: t.fontWeight, options: WEIGHTS.map(w => ({ value: w, label: w })), data: { tfield: 'fontWeight' }, triggerClass: 'dd-block' });
  const err = typoError(t);
  panel.innerHTML = `
    <div class="panel-header">
      <span class="panel-title">Type</span>
      <button class="panel-action" data-del-typo="${t.id}" title="Delete style">&times;</button>
    </div>
    <div class="typo-panel-body">
      <div class="prop-section">
        <div class="prop-row" style="gap:6px">
          <input class="prop-input ${err ? 'invalid' : ''}" data-tname value="${esc(t.name)}" spellcheck="false" placeholder="styleName" style="width:100%">
          <span class="model-warn" data-twarn title="${err ? esc(err) : ''}"${err ? '' : ' style="display:none"'}>&#9888;</span>
        </div>
      </div>
      <div class="prop-section">
        <div class="prop-section-title">Color</div>
        ${state.colors.length === 0 ? `
        <div class="api-hint" style="margin-bottom:8px">No colors created yet.</div>
        <button class="goto-colors-btn" id="typo-goto-colors">+ Create a color</button>` : `
        <div class="color-pick-grid">
          <button class="color-pick none ${!t.colorId ? 'selected' : ''}" data-tcolor="" title="None"></button>
          ${state.colors.filter(c => c.fillType === 'solid').map(c => `<button class="color-pick ${t.colorId === c.id ? 'selected' : ''}" data-tcolor="${c.id}" title="${esc(c.name)}" style="background:${colorCss(c)}"></button>`).join('')}
        </div>`}
      </div>
      <div class="prop-section">
        <div class="prop-section-title">Font</div>
        <div class="prop-row">
          <span class="prop-label-wide">Family</span>
          ${familyBtn}
        </div>
        <div class="prop-row">
          <span class="prop-label">Sz</span>
          <input class="prop-input" data-tnum="fontSize" type="number" min="1" value="${t.fontSize}">
          <span class="prop-label">W</span>
          ${weightDD}
        </div>
        <div class="prop-row">
          <span class="prop-label-wide">Line height</span>
          <input class="prop-input" data-tnum="lineHeight" type="number" step="0.1" min="0" value="${t.lineHeight}">
        </div>
        <div class="prop-row">
          <span class="prop-label-wide">Letter sp.</span>
          <input class="prop-input" data-tnum="letterSpacing" type="number" step="0.1" value="${t.letterSpacing}">
        </div>
      </div>
    </div>`;
}

export function renderTypography() {
  renderBoard();
  renderPanel();
}

// Live-update the selected card (name, meta line, sample styles) without a full
// re-render, so the controller input keeps focus while typing.
function refreshCardLive(t) {
  const card = document.querySelector(`.typo-card[data-typo="${t.id}"]`);
  if (!card) return;
  const nm = card.querySelector(`[data-tcardname="${t.id}"]`);
  const meta = card.querySelector(`[data-tcardmeta="${t.id}"]`);
  if (nm) nm.textContent = t.name;
  if (meta) meta.textContent = metaText(t);
  card.querySelectorAll('.typo-sample').forEach(s => { s.style.cssText = typoCss(t); });
}

export function initTypography() {
  const board = document.getElementById('typo-board');
  const panel = document.getElementById('typo-panel');

  if (board) {
    board.addEventListener('click', e => {
      if (e.target.id === 'typo-new') return addTypo();
      if (e.target.dataset.tcarddel) return deleteTypo(e.target.dataset.tcarddel);
      const card = e.target.closest('.typo-card');
      if (card && card.dataset.typo !== state.selectedTypoId) { state.selectedTypoId = card.dataset.typo; renderTypography(); }
    });
  }

  if (panel) {
    panel.addEventListener('click', e => {
      const el = e.target;
      if (el.dataset.delTypo) return deleteTypo(el.dataset.delTypo);
      if (el.id === 'typo-goto-colors') return document.querySelector('.mode-tab[data-mode="color"]')?.click();
      const t = getTypo(state.selectedTypoId);
      if (!t) return;
      if (el.closest('[data-fontpick]')) {
        document.dispatchEvent(new CustomEvent('font:open', { detail: {
          current: t.fontFamily,
          onPick: (family) => { t.fontFamily = family; ensureFontLoaded(family); saveHistory(); renderTypography(); },
        } }));
        return;
      }
      if (el.dataset.tcolor != null) { t.colorId = el.dataset.tcolor || null; saveHistory(); renderTypography(); }
    });

    // Live edits (name + numeric fields) — update the card in place, keep focus.
    panel.addEventListener('input', e => {
      const t = getTypo(state.selectedTypoId);
      if (!t) return;
      const el = e.target;
      if (el.dataset.tname != null) { t.name = el.value; refreshCardLive(t); refreshTypoWarn(t); refreshAllCardWarns(); }
      else if (el.dataset.tnum) { t[el.dataset.tnum] = parseFloat(el.value) || 0; refreshCardLive(t); }
    });

    // Commit text/number edits to history on blur.
    panel.addEventListener('change', () => saveHistory());

    // Font family / weight dropdowns.
    panel.addEventListener('dd:change', e => {
      const t = getTypo(state.selectedTypoId);
      if (!t) return;
      t[e.target.dataset.tfield] = e.detail.value;
      saveHistory();
      renderTypography();
    });
  }
}
