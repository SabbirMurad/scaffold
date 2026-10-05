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
//   Carousel — node.widget = { kind: 'carousel', active, arrows, dots,
//          autoplay (seconds, 0 = off), loop, dotColorId, activeDotColorId }
//   The container's children are its slides, one shown at a time, with
//   arrows over it and dots below. On the canvas the arrows / dots (or
//   selecting inside a slide) pick the slide; in Play they slide it, and
//   autoplay runs; Flutter gets AppCarousel (PageView), the web <app-carousel>.
//
//   Accordion — node.widget = { kind: 'accordion', open: [indexes], single,
//          typoId, iconColorId, dividerColorId }
//   The container's children are its sections; each section's layer name is
//   its heading, drawn as a row with a chevron above it. Clicking a heading
//   opens / closes it (on the canvas: which start open); "single" keeps one
//   open at a time. Flutter gets AppAccordion; the web, <details> / <summary>.
//
// Everything else about the container — size, padding, fill, corners — is a
// container's as usual; its layout is a column (bar / slide, then dots).

import { state, getNode, getColorById, getTypoById } from './state.js';
import { colorCss } from './colors.js';

export const WIDGET_KINDS = [
  { value: 'none', label: 'None' },
  { value: 'tabs', label: 'Tabs' },
  { value: 'carousel', label: 'Carousel' },
  { value: 'accordion', label: 'Accordion' },
];
export const widgetKind = (n) => (n && n.widget && n.widget.kind) || null;
export const isTabs = (n) => widgetKind(n) === 'tabs';
export const isCarousel = (n) => widgetKind(n) === 'carousel';
export const isAccordion = (n) => widgetKind(n) === 'accordion';
// A container that shows its children one (or some) at a time.
export const isWidget = (n) => isTabs(n) || isCarousel(n) || isAccordion(n);
export const TAB_BAR_H = 48;

// The tab panels and their labels.
export const tabPanels = (n) => (n.children || []).map(getNode).filter(c => c && c.visible !== false);
export const tabLabel = (panel, i) => (panel && panel.name && panel.name.trim()) || `Tab ${i + 1}`;

// The tab / slide shown: on the canvas, the one holding the selection, else the chosen one.
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
  if (kind === 'carousel') {
    n.widget = { kind: 'carousel', active: 0, arrows: true, dots: true, autoplay: 0, loop: true,
      ...(n.widget && n.widget.kind === 'carousel' ? n.widget : {}) };
    n.layout = 'column';
    n.gap = 12;
    n.alignment = { h: 'center', v: 'top' }; // the dots sit centred under the slide
    n.repeat = null;
    if (!(n.children || []).length && makePanel) { makePanel(n, 'Slide 1'); makePanel(n, 'Slide 2'); makePanel(n, 'Slide 3'); }
  }
  if (kind === 'accordion') {
    n.widget = { kind: 'accordion', open: [0], single: true, ...(n.widget && n.widget.kind === 'accordion' ? n.widget : {}) };
    n.layout = 'column';
    n.gap = 0;
    n.repeat = null;
    if (!(n.children || []).length && makePanel) {
      makePanel(n, 'What is it?'); makePanel(n, 'How does it work?'); makePanel(n, 'What does it cost?');
    }
  }
}

// Draw a widget's chrome into its element (children already in it).
export function drawWidget(el, n, active, onPick) {
  if (isTabs(n)) drawTabs(el, n, active, onPick);
  else if (isCarousel(n)) drawCarousel(el, n, active, onPick);
  else if (isAccordion(n)) drawAccordion(el, n, onPick);
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

// ── carousel ─────────────────────────────────────────────────────────────────
const chevron = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const PREV_SVG = chevron('M15 5l-7 7 7 7');
export const NEXT_SVG = chevron('M9 5l7 7-7 7');
const slidesOf = (el) => [...el.children].filter(c => c.classList.contains('node'));

// Arrows over the slide, dots under it; only the active slide shows.
export function drawCarousel(el, n, active, onPick) {
  const w = n.widget || {};
  const slides = slidesOf(el);
  el.dataset.carousel = '';
  if (w.loop !== false) el.dataset.loop = '';
  if (w.autoplay > 0) el.dataset.autoplay = String(w.autoplay);
  rememberDisplay(el);
  const pick = (i) => { if (onPick) onPick(i); showSlide(el, i); };
  if (w.arrows !== false && slides.length > 1) {
    [['-1', PREV_SVG, 'left'], ['1', NEXT_SVG, 'right']].forEach(([delta, svg, side]) => {
      const b = document.createElement('div');
      b.className = 'carousel-arrow';
      b.dataset.carouselStep = delta;
      b.innerHTML = svg;
      Object.assign(b.style, { position: 'absolute', top: '50%', [side]: '8px', transform: 'translateY(-50%)', zIndex: '2',
        width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(255,255,255,0.92)', color: '#1a1a1a',
        display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', cursor: 'pointer' });
      if (onPick) b.addEventListener('mousedown', () => pick(step(el, Number(delta))));
      el.appendChild(b);
    });
  }
  if (w.dots !== false && slides.length > 1) {
    const dots = document.createElement('div');
    dots.className = 'carousel-dots';
    dots.dataset.carouselDots = '';
    Object.assign(dots.style, { display: 'flex', gap: '6px', flex: '0 0 auto', alignItems: 'center', height: '8px' });
    slides.forEach((_, i) => {
      const d = document.createElement('div');
      d.dataset.carouselDot = String(i);
      d.dataset.on = solid(w.activeDotColorId, '#1a1a1a');
      d.dataset.off = solid(w.dotColorId, 'rgba(128,128,128,0.45)');
      Object.assign(d.style, { height: '8px', borderRadius: '4px', cursor: 'pointer', transition: 'width .2s' });
      if (onPick) d.addEventListener('mousedown', () => pick(i));
      dots.appendChild(d);
    });
    el.appendChild(dots);
  }
  showSlide(el, active);
}

// The slide `delta` away from the current one, wrapping when the carousel loops.
function step(el, delta) {
  const count = slidesOf(el).length;
  const next = Number(el.dataset.slide || 0) + delta;
  if (el.hasAttribute('data-loop')) return (next + count) % count;
  return Math.min(Math.max(next, 0), count - 1);
}

export function showSlide(el, i) {
  el.dataset.slide = String(i);
  slidesOf(el).forEach((p, k) => { p.style.display = k === i ? (p.dataset.display || '') : 'none'; });
  el.querySelectorAll(':scope > [data-carousel-dots] > [data-carousel-dot]').forEach((d, k) => {
    d.style.width = k === i ? '20px' : '8px';
    d.style.background = k === i ? d.dataset.on : d.dataset.off;
  });
}

// ── Play ─────────────────────────────────────────────────────────────────────
// A tap on a drawn tab, carousel arrow or dot. True when it was one.
export function tapWidget(target) {
  if (!target.closest) return false;
  const tab = target.closest('[data-tab]');
  if (tab && tab.parentElement && tab.parentElement.hasAttribute('data-tabs')) {
    showTab(tab.parentElement, Number(tab.dataset.tab));
    return true;
  }
  const arrow = target.closest('[data-carousel-step]');
  if (arrow) { const el = arrow.parentElement; showSlide(el, step(el, Number(arrow.dataset.carouselStep))); return true; }
  const dot = target.closest('[data-carousel-dot]');
  if (dot) { showSlide(dot.parentElement.parentElement, Number(dot.dataset.carouselDot)); return true; }
  const head = target.closest('[data-acc-head]');
  if (head && head.parentElement.hasAttribute('data-accordion')) { toggleSection(head.parentElement, Number(head.dataset.accHead)); return true; }
  return false;
}

// Start the autoplaying carousels on a Play screen; returns a stop function.
export function startAutoplay(root) {
  const timers = [...root.querySelectorAll('[data-carousel][data-autoplay]')].map(el =>
    setInterval(() => showSlide(el, step(el, 1)), Number(el.dataset.autoplay) * 1000));
  return () => timers.forEach(clearInterval);
}

// ── accordion ────────────────────────────────────────────────────────────────
export const CHEVRON_DOWN_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// The sections open at first: those chosen (widget.open), and on the canvas any
// holding the selection. With "one at a time", one at most.
export function openSections(n, { followSelection = true } = {}) {
  const w = n.widget || {};
  const count = tabPanels(n).length;
  let open = (Array.isArray(w.open) ? w.open : [0]).filter(i => Number.isInteger(i) && i >= 0 && i < count);
  if (followSelection) {
    const panels = tabPanels(n);
    for (const id of state.selected) {
      for (let p = getNode(id); p && p.parentId; p = getNode(p.parentId)) {
        if (p.parentId === n.id) { const i = panels.indexOf(p); if (i >= 0) open = w.single === false ? [...new Set([...open, i])] : [i]; break; }
      }
    }
  }
  return w.single === false ? open : open.slice(0, 1);
}

// A heading above each section; only open sections show.
export function drawAccordion(el, n, onPick) {
  const w = n.widget || {};
  const panels = slidesOf(el);
  const typo = w.typoId ? getTypoById(w.typoId) : null;
  el.dataset.accordion = '';
  if (w.single !== false) el.dataset.single = '';
  rememberDisplay(el);
  const divider = solid(w.dividerColorId, 'rgba(128,128,128,0.25)');
  tabPanels(n).forEach((p, i) => {
    const head = document.createElement('div');
    head.className = 'accordion-head';
    head.dataset.accHead = String(i);
    head.innerHTML = `<span></span>${CHEVRON_DOWN_SVG}`;
    head.firstChild.textContent = tabLabel(p, i).replace(/^Tab /, 'Section ');
    Object.assign(head.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', width: '100%',
      flex: '0 0 auto', padding: '14px 0', cursor: 'pointer', userSelect: 'none', borderBottom: `1px solid ${divider}`,
      fontFamily: typo ? `'${typo.fontFamily}'` : 'inherit', fontSize: (typo ? typo.fontSize : 15) + 'px',
      fontWeight: typo ? typo.fontWeight : 600, color: solid(typo && typo.colorId, 'inherit'),
    });
    const icon = head.querySelector('svg');
    icon.style.color = solid(w.iconColorId, 'currentColor');
    icon.style.transition = 'transform .2s';
    icon.style.flex = '0 0 auto';
    if (onPick) head.addEventListener('mousedown', () => { onPick(i); toggleSection(el, i); });
    el.insertBefore(head, panels[i] || null);
  });
  showSections(el, openSections(n, { followSelection: !!onPick }));
}

export function showSections(el, open) {
  const set = new Set(open);
  slidesOf(el).forEach((p, k) => { p.style.display = set.has(k) ? (p.dataset.display || '') : 'none'; });
  el.querySelectorAll(':scope > [data-acc-head]').forEach((h, k) => {
    h.dataset.open = set.has(k) ? '1' : '';
    h.querySelector('svg').style.transform = set.has(k) ? 'rotate(180deg)' : '';
  });
}

// Open / close section `i` of a drawn accordion (one open at a time if single).
function toggleSection(el, i) {
  const heads = [...el.querySelectorAll(':scope > [data-acc-head]')];
  const open = heads.map((h, k) => (h.dataset.open ? k : -1)).filter(k => k >= 0);
  const next = open.includes(i) ? open.filter(k => k !== i) : (el.hasAttribute('data-single') ? [i] : [...open, i]);
  showSections(el, next);
}

// What a click on a widget's tab / dot / arrow / heading changes in the design:
// the active tab or slide, or which sections start open. True when it changed.
export function pickInModel(n, i) {
  const w = n.widget;
  if (!w) return false;
  if (w.kind === 'accordion') {
    const open = openSections(n, { followSelection: false });
    w.open = open.includes(i) ? open.filter(k => k !== i) : (w.single === false ? [...open, i] : [i]);
    return true;
  }
  if (w.active === i) return false;
  w.active = i;
  return true;
}
