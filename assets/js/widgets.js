// Interactive elements: a container set to behave as one (node.widget).
//
//   Tabs — node.widget = { kind: 'tabs', active, typoId, activeColorId,
//          inactiveColorId, indicatorColorId, stretch }
//   The container's children are its panels, one per tab; each panel's layer
//   name is its tab's label. The container draws a tab bar above the active
//   panel (the bar is drawn, not a layer). On the canvas a tab is picked by
//   clicking it, or by selecting anything inside its panel; in Play, in the
//   Flutter app (TabBar) and on the web (<app-tabs>) by tapping it.
//
// Everything else about the container — size, padding, fill, corners — is a
// container's as usual; its layout is a column (bar, then panel).

import { state, getNode, getColorById, getTypoById } from './state.js';
import { colorCss } from './colors.js';

export const WIDGET_KINDS = [
  { value: 'none', label: 'None' },
  { value: 'tabs', label: 'Tabs' },
];
export const widgetKind = (n) => (n && n.widget && n.widget.kind) || null;
export const isTabs = (n) => widgetKind(n) === 'tabs';
export const TAB_BAR_H = 48;

// The tab panels and their labels.
export const tabPanels = (n) => (n.children || []).map(getNode).filter(c => c && c.visible !== false);
export const tabLabel = (panel, i) => (panel && panel.name && panel.name.trim()) || `Tab ${i + 1}`;

// The tab shown: on the canvas, the one holding the selection, else the chosen one.
export function activeTab(n, { followSelection = true } = {}) {
  const panels = tabPanels(n);
  if (followSelection) {
    for (const id of state.selected) {
      for (let p = getNode(id); p && p.parentId; p = getNode(p.parentId)) {
        if (p.parentId === n.id) { const i = panels.indexOf(p); if (i >= 0) return i; break; }
      }
    }
  }
  const a = n.widget && Number.isInteger(n.widget.active) ? n.widget.active : 0;
  return Math.min(Math.max(a, 0), Math.max(panels.length - 1, 0));
}

// Make a container (or end it being) a widget. `makePanel(parent, name)` adds a
// panel container — so a fresh Tabs starts with two tabs to fill.
export function setWidgetKind(n, kind, makePanel) {
  if (!kind || kind === 'none') { delete n.widget; return; }
  if (kind === 'tabs') {
    n.widget = { kind: 'tabs', active: 0, stretch: false, ...(n.widget && n.widget.kind === 'tabs' ? n.widget : {}) };
    n.layout = 'column';
    n.gap = 0;
    n.repeat = null; // tabs are its panels, not a list
    if (!(n.children || []).length && makePanel) { makePanel(n, 'Tab 1'); makePanel(n, 'Tab 2'); }
  }
}

// ── drawing (canvas + Play) ──────────────────────────────────────────────────
const solid = (colorId, fallback) => { const c = colorId ? getColorById(colorId) : null; return c ? colorCss(c) : fallback; };

// Draw the tab bar into `el` (the container's element, children already in it)
// and show only the active panel. `onPick(i)` — the canvas sets the tab.
export function drawTabs(el, n, active, onPick) {
  const w = n.widget || {};
  const panels = [...el.children].filter(c => c.classList.contains('node'));
  const typo = w.typoId ? getTypoById(w.typoId) : null;
  const on = solid(w.activeColorId, '#1a1a1a'), off = solid(w.inactiveColorId, '#8a8f98');
  const bar = document.createElement('div');
  bar.className = 'tabs-bar';
  bar.dataset.tabs = '';
  Object.assign(bar.style, { display: 'flex', flex: '0 0 auto', height: TAB_BAR_H + 'px', width: '100%',
    boxShadow: `inset 0 -1px 0 ${solid(w.inactiveColorId, '#8a8f98')}33`, position: 'relative' });
  tabPanels(n).forEach((p, i) => {
    const b = document.createElement('div');
    b.className = 'tabs-tab';
    b.dataset.tab = String(i);
    b.textContent = tabLabel(p, i);
    Object.assign(b.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px', cursor: 'pointer',
      flex: w.stretch ? '1 1 0' : '0 0 auto', whiteSpace: 'nowrap', userSelect: 'none',
      fontFamily: typo ? `'${typo.fontFamily}'` : 'inherit', fontSize: (typo ? typo.fontSize : 14) + 'px',
      fontWeight: typo ? typo.fontWeight : 600, letterSpacing: typo && typo.letterSpacing ? typo.letterSpacing + 'px' : '',
    });
    b.dataset.on = on; b.dataset.off = off; b.dataset.ind = solid(w.indicatorColorId, on);
    if (onPick) b.addEventListener('mousedown', () => { onPick(i); showTab(bar, i); }); // the press still selects the tabs
    bar.appendChild(b);
  });
  rememberDisplay(el);
  el.insertBefore(bar, panels[0] || null);
  showTab(bar, active);
}

// Show tab `i` of a drawn tabs element (Play's taps come here too).
export function showTab(bar, i) {
  const tabs = [...bar.children];
  const panels = [...bar.parentElement.children].filter(c => c.classList.contains('node'));
  tabs.forEach((b, k) => {
    const sel = k === i;
    b.style.color = sel ? b.dataset.on : b.dataset.off;
    b.style.boxShadow = sel ? `inset 0 -2px 0 ${b.dataset.ind}` : '';
  });
  panels.forEach((p, k) => { p.style.display = k === i ? '' : 'none'; });
  // A panel's own layout display (flex) is set when drawn: restore it.
  panels.forEach((p, k) => { if (k === i && p.dataset.display) p.style.display = p.dataset.display; });
}
// Before hiding, each panel remembers its display (flex for laid-out panels).
export function rememberDisplay(el) {
  [...el.children].forEach(c => { if (c.classList.contains('node')) c.dataset.display = c.style.display || ''; });
}

// Play: a tap on a drawn tab.
export function tapTab(target) {
  const b = target.closest && target.closest('[data-tab]');
  if (!b || !b.parentElement || !b.parentElement.hasAttribute('data-tabs')) return false;
  showTab(b.parentElement, Number(b.dataset.tab));
  return true;
}
