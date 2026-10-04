// Web code generation: a web page's screens as server-rendered pages for a
// project built from the rust_backend_template (actix + Tera; the Rust server
// serves each page — no client routing).
//
// Each screen becomes pages/<section>/<screen>.html — a whole HTML document in
// the template's own style (its <head> includes "common.html") — and
// assets/css/pages/<section>/<screen>.css. The design's colour variables become
// assets/css/variable.css (one set of --v-* tokens per theme) and its text
// styles assets/css/typography.css (.t-<style> classes).
//
// Search engines get everything in the HTML: semantic tags (the HTML tag set in
// the editor, else a sensible default — the page's largest text is its <h1>),
// the screen's SEO title / description / share image, real <a href> links,
// images as <img> with alt text and their size, lazy below the first one.
//
// The layout mirrors the canvas (render.js): rows / columns / wraps are flexbox,
// stacks position their children, sizes follow fixed / fill / hug. Wide fixed
// widths become a max-width so a 1920px design still fits a narrower window.
//
// Data (repeat / show-if / bindings) and components as Tera macros come next;
// until then an instance is drawn from its component, a repeat shows its design
// once, and a bound text shows its design text.

import { state, getNode, getMasterNode, getColorById, getTypoById } from './state.js';
import { flexKind, isSingleChild, isStack } from './nodes.js';
import { imageFile, iconFile } from './widgetgen.js';
import { scopeFor, rootScope, aliasOf } from './data.js';
import { componentStandalone } from './widgetgen.js';
import { isTabs, tabPanels, tabLabel, activeTab } from './widgets.js';

// ── names ────────────────────────────────────────────────────────────────────
const kebab = (s) => String(s || '').trim()
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const colorVar = (c) => `--v-${kebab(c.name) || 'color'}`;
export const styleClass = (t) => `t-${kebab(t.name) || 'text'}`;

// Text for HTML: escaped, and with { } made literal so Tera never reads a
// design's own text as a template tag.
const escText = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

// ── colours ──────────────────────────────────────────────────────────────────
function solidCss(fill, alpha) {
  if (!fill || fill === 'transparent') return 'transparent';
  const a = alpha == null ? 1 : alpha;
  if (a >= 1) return fill;
  let h = fill.replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  const n = parseInt(h.slice(0, 6) || '0', 16) || 0;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function gradientCss(v) {
  const g = v.gradient || { angle: 90, stops: [] };
  const stops = [...(g.stops || [])].sort((a, b) => a.pos - b.pos).map(s => `${solidCss(s.color, s.alpha)} ${s.pos}%`).join(', ');
  return v.fillType === 'radial' ? `radial-gradient(circle at center, ${stops})` : `linear-gradient(${g.angle}deg, ${stops})`;
}
const valueCss = (v) => (v.fillType === 'linear' || v.fillType === 'radial') ? gradientCss(v) : solidCss(v.fill, v.alpha);

// A colour variable reference, or null when there's no (usable) variable.
function varRef(colorId, { solidOnly = false } = {}) {
  const c = colorId ? getColorById(colorId) : null;
  if (!c || (solidOnly && c.fillType !== 'solid')) return null;
  return `var(${colorVar(c)})`;
}
// A colour at an opacity, keeping it themeable when it's a variable.
const withAlpha = (color, alpha) => alpha == null || alpha >= 1 ? color
  : `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;

// The theme a page opens in: a light one when there is one.
function defaultTheme() {
  return state.themes.find(t => t.brightness === 'light') || state.themes[0] || null;
}

// assets/css/variable.css — every colour variable, per theme.
export function generateVariablesCss() {
  const themes = state.themes.length ? state.themes : [{ id: null, name: 'default' }];
  const def = defaultTheme();
  const L = ['/* Design tokens — the colour variables from Scaffold, one value per theme.',
    '   <html data-theme="…"> picks the theme; the first block is the default. */', ''];
  const block = (sel, theme) => {
    L.push(`${sel} {`);
    if (theme && theme.brightness) L.push(`  color-scheme: ${theme.brightness};`);
    state.colors.forEach(c => {
      const v = (theme && theme.id && c.values && c.values[theme.id]) || c;
      L.push(`  ${colorVar(c)}: ${valueCss(v)};`);
    });
    L.push('}', '');
  };
  if (def) block(`:root,\n[data-theme="${kebab(def.name)}"]`, def);
  themes.filter(t => t !== def).forEach(t => block(`[data-theme="${kebab(t.name)}"]`, t));
  return L.join('\n');
}

// assets/css/typography.css — a class per text style.
export function generateTypographyCss() {
  const L = ['/* Text styles from Scaffold — one class each (.t-<style>). */', ''];
  state.typography.forEach(t => {
    L.push(`.${styleClass(t)} {`);
    L.push(`  font-family: ${fontStack(t.fontFamily)};`);
    L.push(`  font-size: ${t.fontSize}px;`);
    L.push(`  font-weight: ${t.fontWeight || 400};`);
    if (t.lineHeight) L.push(`  line-height: ${t.lineHeight};`);
    if (t.letterSpacing) L.push(`  letter-spacing: ${t.letterSpacing}px;`);
    const col = varRef(t.colorId, { solidOnly: true });
    if (col) L.push(`  color: ${col};`);
    L.push('}', '');
  });
  return L.join('\n');
}

const fontStack = (family) => `${/\s/.test(family) ? `'${family}'` : family}, system-ui, sans-serif`;

// Google Fonts for the text styles the page uses (with font-display: swap).
function fontsLink(frame) {
  const used = new Set();
  walkTexts(frame, n => { if (n.typoId) used.add(n.typoId); });
  const weights = new Map();
  state.typography.filter(t => used.has(t.id)).forEach(t => {
    if (!t.fontFamily) return;
    if (!weights.has(t.fontFamily)) weights.set(t.fontFamily, new Set());
    weights.get(t.fontFamily).add(String(t.fontWeight || 400));
  });
  if (!weights.size) return '';
  const fams = [...weights].map(([f, w]) => `family=${f.trim().replace(/\s+/g, '+')}:wght@${[...w].sort((a, b) => a - b).join(';')}`);
  return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fams.join('&')}&display=swap">`;
}

// ── a page ───────────────────────────────────────────────────────────────────
// `opts`: { projectName, route (this screen's path), href(frame) → a target
// screen's path or null, cssHref (this page's stylesheet), imagePath(node) }.
export function generateWebPage(frame, opts) {
  const ctx = {
    opts, rules: [], used: new Map(), firstImage: true, inline: 0, widgets: new Set(),
    maxText: maxTextSize(frame), h1: hasExplicitH1(frame),
  };
  const comps = usedComponents(frame);
  const bodyClass = className(ctx, frame, 'page');
  ctx.rules.push(rule(bodyClass, frameCss(frame)));
  const children = kids(frame).map(c => node(ctx, c, frame, 1)).filter(Boolean).join('\n');

  const seo = frame.seo || {};
  const title = (seo.title || '').trim() || humanize(frame.name);
  const fullTitle = opts.projectName && !title.toLowerCase().includes(opts.projectName.toLowerCase())
    ? `${title} — ${opts.projectName}` : title;
  const desc = (seo.description || '').trim();
  const shareNode = seo.imageId ? getNode(seo.imageId) : null;
  const shareImage = shareNode ? opts.imagePath(shareNode) : null;
  const theme = defaultTheme();
  // Absolute URLs (canonical, og:*) need the site's address: the page's handler
  // can pass it as `site_url`; without it they stay relative.
  const abs = (path) => `{{ site_url | default(value="") }}${path}`;

  const head = [
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>${escText(fullTitle)}</title>`,
    desc ? `<meta name="description" content="${escAttr(desc)}">` : '',
    `<link rel="canonical" href="${abs(opts.route)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escAttr(fullTitle)}">`,
    desc ? `<meta property="og:description" content="${escAttr(desc)}">` : '',
    `<meta property="og:url" content="${abs(opts.route)}">`,
    shareImage ? `<meta property="og:image" content="${abs(shareImage)}">` : '',
    `<meta name="twitter:card" content="${shareImage ? 'summary_large_image' : 'summary'}">`,
    '{% include "common.html" %}',
    fontsLink(frame),
    '<link rel="stylesheet" href="/assets/css/reset_v1.0.css">',
    '<link rel="stylesheet" href="/assets/css/variable.css">',
    '<link rel="stylesheet" href="/assets/css/typography.css">',
    ...comps.map(id => `<link rel="stylesheet" href="/${componentCssPath(id)}">`),
    `<link rel="stylesheet" href="${opts.cssHref}">`,
    // Interactive elements (Web Components): deferred, after the page is parsed.
    ...usedWidgets(frame).map(tag => `<script type="module" src="/${widgetScriptPath(tag)}"></script>`),
  ].filter(Boolean).map(l => '  ' + l).join('\n');

  // Data images: paintImage() from the project's own utils (never generated).
  const script = ctx.paintsImages ? `
  <script type="module">
    import { paintImage } from '/assets/js/utils/image.js';
    document.querySelectorAll('[data-image]').forEach((el) => {
      paintImage(el, { uuid: el.dataset.image, blur_hash: el.dataset.blurHash || undefined });
    });
  </script>` : '';
  const html = `${componentImports(comps)}${contextNote(frame)}<!DOCTYPE html>
<html lang="en"${theme ? ` data-theme="${kebab(theme.name)}"` : ''}>

<head>
${head}
</head>

<body class="${bodyClass}">
${children}${script}
</body>

</html>
`;
  const css = `/* ${frame.name} — generated by Scaffold. */\n\n` + ctx.rules.filter(Boolean).join('\n\n') + '\n';
  return { html, css };
}

const humanize = (name) => { const s = String(name || 'Page').replace(/[_-]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const kids = (n) => (n.children || []).map(getNode).filter(Boolean);

// A class per element, from its layer name, unique on the page.
function className(ctx, n, fallback) {
  let base = kebab(n.name) || fallback || n.type;
  // Inside a component, classes carry its name (they share pages with others').
  if (ctx.prefix && base !== ctx.prefix && !base.startsWith(ctx.prefix + '-')) base = `${ctx.prefix}-${base}`;
  if (/^[0-9]/.test(base)) base = `${fallback || n.type}-${base}`; // a CSS class can't start with a digit
  const count = (ctx.used.get(base) || 0) + 1;
  ctx.used.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}
const rule = (cls, decls) => {
  const lines = Object.entries(decls).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `  ${k}: ${v};`);
  return lines.length ? `.${cls} {\n${lines.join('\n')}\n}` : '';
};
const pad = (n) => '  '.repeat(n);

// ── elements ─────────────────────────────────────────────────────────────────
function node(ctx, n, parent, depth) {
  if (!n || n.visible === false) return '';
  if (n.type === 'instance') return instanceEl(ctx, n, parent, depth);
  const cls = n.type === 'text' ? null : className(ctx, n); // a text names itself (textEl)
  const css = { ...placementCss(n, parent), ...sizeCss(n, parent), ...effectsCss(n) };
  let out;
  if (n.type === 'text') out = textEl(ctx, n, cls, css, depth);
  else if (n.type === 'image') out = imageEl(ctx, n, cls, css, depth);
  else if (n.type === 'icon') out = iconEl(ctx, n, cls, css, depth);
  else out = boxEl(ctx, n, cls, css, depth);
  return out ? withShowIf(n, out, depth) : '';
}

// A container (or a section / layout node): its tag, or a link when tapping it
// navigates, or a button when it goes back. A repeating one draws its children
// once per item of its list ({% for %}).
function boxEl(ctx, n, cls, css, depth) {
  if (isTabs(n)) return tabsEl(ctx, n, cls, css, depth);
  Object.assign(css, layoutCss(n), boxPaintCss(n));
  ctx.rules.push(rule(cls, css));
  const loop = n.repeat && n.repeat.source ? dataRef(n, n.repeat.source) : null;
  const inDepth = loop ? depth + 2 : depth + 1;
  let inner = kids(n).map(c => node(ctx, c, n, inDepth)).filter(Boolean).join('\n');
  if (loop && inner) {
    const src = loop.nullable ? `${loop.expr} | default(value=[])` : loop.expr;
    inner = `${pad(depth + 1)}{% for ${aliasOf(n)} in ${src} %}\n${inner}\n${pad(depth + 1)}{% endfor %}`;
  }
  // A colour from data, over the design's fill.
  const fill = n.bind && n.bind.fill ? dataRef(n, n.bind.fill) : null;
  const style = fill ? ` style="background: ${teraOut(fill)}"` : '';
  // A box that's tapped is itself the link / button.
  const tag = n.htmlTag || 'div';
  const { open, close } = linkTag(ctx, n, cls, style) || { open: `<${tag} class="${cls}"${style}>`, close: `</${tag}>` };
  return inner ? `${pad(depth)}${open}\n${inner}\n${pad(depth)}${close}` : `${pad(depth)}${open}${close}`;
}

// Tabs (widgets.js) as <app-tabs>: the bar and every panel are in the page —
// readable by search engines and without JavaScript, the inactive panels just
// `hidden` — and assets/js/components/app-tabs.js switches between them.
function tabsEl(ctx, n, cls, css, depth) {
  const w = n.widget || {};
  Object.assign(css, layoutCss(n), boxPaintCss(n));
  ctx.rules.push(rule(cls, css));
  const panels = tabPanels(n);
  const active = activeTab(n, { followSelection: false });
  const on = varRef(w.activeColorId, { solidOnly: true }) || 'currentColor';
  const off = varRef(w.inactiveColorId, { solidOnly: true }) || withAlpha('currentColor', 0.6);
  const ind = varRef(w.indicatorColorId, { solidOnly: true }) || on;
  ctx.rules.push(rule(`${cls}-bar`, { display: 'flex', 'flex-shrink': '0', width: '100%', 'min-height': '48px',
    'box-shadow': `inset 0 -1px 0 ${withAlpha(off, 0.25)}`, 'overflow-x': w.stretch ? '' : 'auto', 'scrollbar-width': 'none' }));
  const t = w.typoId ? getTypoById(w.typoId) : null;
  ctx.rules.push(rule(`${cls}-tab`, { flex: w.stretch ? '1 1 0' : '0 0 auto', padding: '0 16px', background: 'none', border: '0',
    font: t ? '' : 'inherit', 'font-weight': t ? '' : '600', color: off, cursor: 'pointer', 'white-space': 'nowrap' })); // a text style brings its own font
  ctx.rules.push(rule(`${cls}-tab[aria-selected="true"]`, { color: on, 'box-shadow': `inset 0 -2px 0 ${ind}` }));
  // A laid-out panel is display:flex, which would beat the browser's [hidden].
  ctx.rules.push(rule(`${cls} > [role="tabpanel"][hidden]`, { display: 'none' }));
  const tabClass = `${t ? styleClass(t) + ' ' : ''}${cls}-tab`;
  const tabs = panels.map((p, i) => `${pad(depth + 2)}<button type="button" role="tab" class="${tabClass}" aria-selected="${i === active}"${i === active ? '' : ' tabindex="-1"'}>${escText(tabLabel(p, i))}</button>`);
  // Each panel's own element, marked as a tab panel (hidden unless active).
  const body = panels.map((p, i) => {
    const html = node(ctx, p, n, depth + 1);
    const attrs = ` role="tabpanel"${i === active ? '' : ' hidden'}`;
    return /<[a-z]/.test(html) ? html.replace(/<([a-z][\w-]*)/, `<$1${attrs}`)
      : `${pad(depth + 1)}<div${attrs}>\n${html}\n${pad(depth + 1)}</div>`; // a component call: wrapped
  }).filter(Boolean);
  ctx.widgets.add('app-tabs');
  return [`${pad(depth)}<app-tabs class="${cls}">`,
    `${pad(depth + 1)}<div class="${cls}-bar" role="tablist">`, ...tabs, `${pad(depth + 1)}</div>`,
    ...body, `${pad(depth)}</app-tabs>`].join('\n');
}

// The Web Components a page uses (its components' included): their scripts.
export function usedWidgets(root) {
  const out = new Set(), seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n.id) || n.visible === false) return;
    seen.add(n.id);
    if (isTabs(n)) out.add('app-tabs');
    if (n.type === 'instance') walk(getMasterNode(n.componentId));
    kids(n).forEach(walk);
  };
  walk(root);
  return [...out];
}
export const widgetScriptPath = (tag) => `assets/js/components/${tag}.js`;

// What tapping a node does, as HTML: a real link for "navigate to a screen" (so
// crawlers follow it) — its conditional routes picked on the server — and a
// button for "go back". Null when it does neither (or goes to no web page).
function linkTag(ctx, n, cls, attrs = '') {
  const a = n.action;
  const href = navHref(ctx, n);
  if (href) return { open: `<a class="${cls}" href="${href}"${attrs}>`, close: '</a>' };
  if (a && a.type === 'back') return { open: `<button type="button" class="${cls}" onclick="history.back()"${attrs}>`, close: '</button>' };
  return null;
}
// Where a navigate action goes, as an href (with {% if %} for conditional
// routes), or null.
function navHref(ctx, n) {
  const a = n.action;
  if (!a || a.type !== 'navigate') return null;
  const hrefOf = (id) => { const t = id ? getNode(id) : null; const h = t ? ctx.opts.href(t) : null; return h ? escAttr(h) : null; };
  const fallback = hrefOf(a.targetFrameId);
  const branches = (a.routes || []).map(r => {
    const h = r && hrefOf(r.target);
    const c = h && teraCond(n, r.when);
    return c ? `{% if ${c} %}${h}` : null;
  }).filter(Boolean).map((b, i) => i ? b.replace('{% if', '{% elif') : b);
  return branches.length ? `${branches.join('')}${fallback ? `{% else %}${fallback}` : ''}{% endif %}` : fallback;
}

// ── components (Tera macros) ─────────────────────────────────────────────────
// A component is one macro in pages/components/<name>.html, with its styles in
// assets/css/components/<name>.css; every instance is a call:
//   {% import "components/food_card.html" as food_card %}
//   {{ food_card::food_card(class_name="…", href="…") }}
// `class_name` brings what the instance sets where it sits (its place in the
// parent, size, opacity…), `href` where tapping it goes. A macro can't see the
// page's data, so — as in the Flutter export — a component that reads data
// (bindings, show-if, repeat, conditional routes) is written in place, as is
// one whose root is a single text / image / icon.

export function componentMacroName(componentId) {
  const name = (id) => {
    const c = getComponent(id), m = c && getNode(c.rootId);
    let s = kebab((m && m.name) || (c && c.name) || 'component').replace(/-/g, '_') || 'component';
    return /^[0-9]/.test(s) ? 'c_' + s : s;
  };
  const base = name(componentId);
  const same = state.components.filter(c => name(c.id) === base);
  const i = same.findIndex(c => c.id === componentId);
  return i > 0 ? `${base}_${i + 1}` : base;
}
export const componentTemplatePath = (id) => `pages/components/${componentMacroName(id)}.html`;
export const componentCssPath = (id) => `assets/css/components/${componentMacroName(id)}.css`;
const getComponent = (id) => state.components.find(c => c.id === id);

// Whether a component is a macro (see above).
export function isMacroComponent(componentId) {
  const master = getMasterNode(componentId);
  return !!master && !['text', 'image', 'icon'].includes(master.type) && componentStandalone(componentId);
}

// The macro components a subtree uses, nested ones included (each once).
export function usedComponents(root) {
  const out = new Set(), seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n.id) || n.visible === false) return;
    seen.add(n.id);
    if (n.type === 'instance') {
      if (isMacroComponent(n.componentId)) out.add(n.componentId);
      walk(getMasterNode(n.componentId));
    }
    kids(n).forEach(walk);
  };
  if (root.type === 'instance') walk(root); else kids(root).forEach(walk);
  return [...out];
}
// Imports for the top of a template. Trimmed (-%}) so nothing renders before
// <!DOCTYPE>.
const componentImports = (ids) => ids.map(id => {
  const m = componentMacroName(id);
  return `{% import "${componentTemplatePath(id).replace(/^pages\//, '')}" as ${m} -%}\n`;
}).join('');

// An instance on a page (or in another component).
function instanceEl(ctx, n, parent, depth) {
  const master = getMasterNode(n.componentId);
  if (!master || ctx.inline > 8) return ''; // deleted, or a component inside itself
  const routes = n.action && n.action.routes && n.action.routes.length;
  if (!isMacroComponent(n.componentId) || routes) {
    ctx.inline++;
    const out = node(ctx, { ...master, x: n.x, y: n.y, margin: n.margin, opacity: n.opacity ?? master.opacity,
      rotation: n.rotation || master.rotation, showIf: n.showIf, action: n.action || master.action }, parent, depth);
    ctx.inline--;
    return out;
  }
  // The instance's own class: how it sits here (sizes are its component's).
  const placed = { ...master, x: n.x, y: n.y, margin: n.margin };
  const cls = className(ctx, { name: `${master.name} item` }, 'component'); // not the component's own class
  ctx.rules.push(rule(cls, { ...placementCss(placed, parent), ...sizeCss(placed, parent), ...effectsCss(n) }));
  const m = componentMacroName(n.componentId);
  const href = n.action ? navHref(ctx, n) : null;
  const args = [`class_name="${cls}"`];
  if (href) args.push(`href="${href}"`);
  const call = `${pad(depth)}{{ ${m}::${m}(${args.join(', ')}) }}`;
  return withShowIf(n, call, depth);
}

// pages/components/<name>.html and its stylesheet, for one macro component.
export function generateWebComponent(componentId, opts) {
  const master = getMasterNode(componentId);
  const m = componentMacroName(componentId);
  const prefix = m.replace(/_/g, '-');
  const ctx = {
    opts, rules: [], used: new Map(), firstImage: false, inline: 0, prefix, widgets: new Set(),
    maxText: 0, h1: true, // a component never holds the page's <h1>
  };
  const cls = className(ctx, { name: prefix }, 'component');
  ctx.rules.push(rule(cls, { ...layoutCss(master), ...boxPaintCss(master), ...effectsCss(master) }));
  const inner = kids(master).map(c => node(ctx, c, master, 2)).filter(Boolean).join('\n');
  const tag = master.htmlTag || 'div';
  const own = navHref(ctx, master) || '';
  const classes = `${cls}{% if class_name %} {{ class_name | safe }}{% endif %}`;
  // Tapping it: its own link, or the one the instance passes in.
  const open = master.action && master.action.type === 'back'
    ? `<button type="button" class="${classes}" onclick="history.back()">`
    : `{% if href %}<a class="${classes}" href="{{ href | safe }}">{% else %}<${tag} class="${classes}">{% endif %}`;
  const close = master.action && master.action.type === 'back' ? '</button>' : `{% if href %}</a>{% else %}</${tag}>{% endif %}`;
  const deps = usedComponents(master).filter(id => id !== componentId);
  const html = `${componentImports(deps)}{# ${master.name} — a Scaffold component. Its styles: /${componentCssPath(componentId)} #}
{% macro ${m}(class_name="", href="${own}") -%}
  ${open}
${inner}
  ${close}
{%- endmacro ${m} %}
`;
  const css = `/* ${master.name} — generated by Scaffold. */\n\n` + ctx.rules.filter(Boolean).join('\n\n') + '\n';
  return { html, css, deps };
}
// A leaf (text / image / icon) that's tapped goes inside a link of its own.
function linkWrap(ctx, n, cls, inner) {
  const link = linkTag(ctx, n, `${cls}-link`);
  return link ? `${link.open}${inner}${link.close}` : inner;
}

// Texts: the tag set in the editor, else the page's largest text is its <h1>
// and other short, bold or big lines are headings (h2 for big, h3 for the
// rest); sentences — longer, or ending in a full stop — are paragraphs.
function textTag(ctx, n) {
  if (n.htmlTag) return n.htmlTag;
  const size = textSize(n);
  const s = (n.text || '').trim();
  const headingLike = s.length <= 100 && !/[.!?…]$/.test(s) && (textWeight(n) >= 600 || size >= 32);
  if (!ctx.h1 && headingLike && size >= ctx.maxText && size >= 24) { ctx.h1 = true; return 'h1'; }
  if (headingLike && size >= 28) return 'h2';
  if (headingLike && size >= 18) return 'h3';
  return 'p';
}
function textEl(ctx, n, _cls, css, depth) {
  const t = n.typoId ? getTypoById(n.typoId) : null;
  Object.assign(css, textCss(n, t));
  // A class of its own only when it needs rules beyond its text style — named
  // after the layer, or its words when the layer still has a default name.
  const named = n.name && !/^text(\s*\d+)?$/i.test(n.name.trim()) ? n : { ...n, name: (n.text || '').split(/\s+/).slice(0, 4).join(' ').slice(0, 32) };
  const cls = Object.keys(css).length || linkTag(ctx, n, '') ? className(ctx, named, 'text') : null;
  if (cls) ctx.rules.push(rule(cls, css));
  const classes = [t ? styleClass(t) : '', cls || ''].filter(Boolean).join(' ');
  const tag = textTag(ctx, n);
  // Text from data (Tera escapes it), else the design's own.
  const bound = n.bind && n.bind.text ? dataRef(n, n.bind.text) : null;
  const body = bound ? teraOut(bound, n.text) : escText(n.text || '').replace(/\n/g, '<br>');
  const color = n.bind && n.bind.color ? dataRef(n, n.bind.color) : null;
  const attr = (classes ? ` class="${classes}"` : '') + (color ? ` style="color: ${teraOut(color)}"` : '');
  return pad(depth) + linkWrap(ctx, n, cls || 'text', `<${tag}${attr}>${body}</${tag}>`);
}

// Images: a design image is its exported file, as an <img> with its alt text and
// size (the first one loads at once, the rest when scrolled to). Data images
// (painted with paintImage) come with the data step.
function imageEl(ctx, n, cls, css, depth) {
  const fit = { cover: 'cover', contain: 'contain', fill: 'fill' }[n.fit] || 'cover';
  Object.assign(css, { 'object-fit': fit }, radiusCss(n), strokeCss(n));
  const bg = n.colorId ? varRef(n.colorId) : (n.fill && n.fill !== 'transparent' ? solidCss(n.fill, n.alpha) : null);
  if (bg) css.background = bg;
  const src = n.bind && n.bind.src ? dataRef(n, n.bind.src) : null;
  if (src) return dataImageEl(ctx, n, cls, css, depth, src, fit);
  const path = ctx.opts.imagePath(n);
  if (!path) {
    // No picture to export (e.g. a placeholder): its box.
    ctx.rules.push(rule(cls, css));
    return `${pad(depth)}<div class="${cls}" aria-hidden="true"></div>`;
  }
  ctx.rules.push(rule(cls, css));
  const alt = n.decorative ? '' : (n.alt || '').trim();
  const eager = ctx.firstImage;
  ctx.firstImage = false;
  const attrs = [`class="${cls}"`, `src="${escAttr(path)}"`, `alt="${escAttr(alt)}"`,
    `width="${Math.round(n.w)}"`, `height="${Math.round(n.h)}"`,
    eager ? 'fetchpriority="high"' : 'loading="lazy"', 'decoding="async"'];
  return pad(depth) + linkWrap(ctx, n, cls, `<img ${attrs.join(' ')}>`);
}

// The alt text of an image: from data, typed, or empty when decorative.
function altAttr(n) {
  if (n.decorative) return 'alt=""';
  const bound = n.bind && n.bind.alt ? dataRef(n, n.bind.alt) : null;
  return bound ? `alt="${teraOut(bound, n.alt || '')}"` : `alt="${escAttr((n.alt || '').trim())}"`;
}

// An image from data. An ImageModel (the image pipeline, /image/webp/<uuid>) is
// painted the project's way — paintImage() lays its blur hash, then the photo,
// on the data-image box — with a real <img> of the same file inside for search
// engines and screen readers (one download: the browser shares it). A plain
// URL is just an <img>. Lazy: data images are rarely the first thing on a page.
function dataImageEl(ctx, n, cls, css, depth, ref, fit) {
  const size = `width="${Math.round(n.w)}" height="${Math.round(n.h)}"`;
  const model = state.models.find(m => m.name === ref.type.base);
  if (model && model.builtin === 'image') {
    ctx.paintsImages = true;
    css.overflow = 'hidden';
    delete css['object-fit'];
    ctx.rules.push(rule(cls, css));
    ctx.rules.push(rule(`${cls} > img`, { display: 'block', width: '100%', height: '100%', 'object-fit': fit }));
    const e = ref.expr;
    const img = `<img src="/image/webp/{{ ${e}.uuid }}" ${altAttr(n)} ${size} loading="lazy" decoding="async">`;
    const box = `<div class="${cls}" data-image="{{ ${e}.uuid }}" data-blur-hash="{{ ${e}.blur_hash }}">${img}</div>`;
    const html = ref.nullable ? `{% if ${e} %}${box}{% else %}<div class="${cls}"></div>{% endif %}` : box;
    return pad(depth) + linkWrap(ctx, n, cls, html);
  }
  ctx.rules.push(rule(cls, css));
  const img = `<img class="${cls}" src="${teraOut(ref)}" ${altAttr(n)} ${size} loading="lazy" decoding="async">`;
  const html = ref.nullable ? `{% if ${ref.expr} %}${img}{% else %}<div class="${cls}"></div>{% endif %}` : img;
  return pad(depth) + linkWrap(ctx, n, cls, html);
}

// Icons: the exported SVG as a mask, filled with the icon's colour variable —
// decoration for screen readers.
function iconEl(ctx, n, cls, css, depth) {
  if (!n.svg) return '';
  const file = `/assets/icon/${iconFile(n).name}`;
  Object.assign(css, {
    display: 'inline-block', 'flex-shrink': '0',
    'background-color': varRef(n.colorId, { solidOnly: true }) || '#ffffff',
    '-webkit-mask': `url('${file}') center / contain no-repeat`,
    mask: `url('${file}') center / contain no-repeat`,
  });
  ctx.rules.push(rule(cls, css));
  return pad(depth) + linkWrap(ctx, n, cls, `<span class="${cls}" aria-hidden="true"></span>`);
}

// ── CSS ──────────────────────────────────────────────────────────────────────
const ALIGN_H = { left: 'flex-start', center: 'center', right: 'flex-end' };
const ALIGN_V = { top: 'flex-start', center: 'center', bottom: 'flex-end' };
const px = (v) => `${Math.round((v || 0) * 100) / 100}px`;
const box = (b) => b ? `${px(b.t)} ${px(b.r)} ${px(b.b)} ${px(b.l)}` : '';
const nonZero = (b) => b && (b.t || b.r || b.b || b.l);

// The screen itself is the page: full width, at least the window's height.
function frameCss(f) {
  return { 'min-height': '100vh', ...layoutCss(f), ...boxPaintCss(f) };
}

// How a node lays out its children (as the canvas does).
function layoutCss(n) {
  const css = {};
  const kind = flexKind(n);
  const a = n.alignment || { h: 'left', v: 'top' };
  if (kind === 'row' || kind === 'column') {
    Object.assign(css, { display: 'flex', 'flex-direction': kind, gap: px(n.gap) });
    css['justify-content'] = kind === 'row' ? ALIGN_H[a.h] : ALIGN_V[a.v];
    css['align-items'] = kind === 'row' ? ALIGN_V[a.v] : ALIGN_H[a.h];
  } else if (kind === 'wrap') {
    Object.assign(css, { display: 'flex', 'flex-wrap': 'wrap', gap: `${px(n.gapV)} ${px(n.gapH)}`, 'align-content': 'flex-start' });
  } else if (isStack(n)) {
    css.position = 'relative';
  } else if (isSingleChild(n)) {
    Object.assign(css, { display: 'flex', 'justify-content': ALIGN_H[a.h], 'align-items': ALIGN_V[a.v] });
  }
  if (nonZero(n.padding)) css.padding = box(n.padding);
  if (n.scroll && n.scroll !== 'none') {
    if (kind === 'row') { css['overflow-x'] = 'auto'; css['scrollbar-width'] = 'none'; }
    else if (kind === 'column') css['overflow-y'] = 'auto';
  }
  return css;
}

// Where a node sits in its parent: a flex item, or placed at x/y in a stack.
function placementCss(n, parent) {
  const css = {};
  if (parent && isStack(parent)) {
    Object.assign(css, { position: 'absolute', left: px(n.x), top: px(n.y) });
  } else if (parent && flexKind(parent)) {
    const fk = flexKind(parent);
    const fillsMain = (fk === 'row' && n.wMode === 'fill' && !(n.type === 'text' && n.autoSize))
      || (fk === 'column' && n.hMode === 'fill' && n.type !== 'text');
    if (fillsMain) { css.flex = '1 1 0'; css[fk === 'row' ? 'min-width' : 'min-height'] = '0'; }
    else if (n.type !== 'text') css['flex-shrink'] = '0'; // a text may wrap to fit
  }
  if (nonZero(n.margin)) css.margin = box(n.margin);
  return css;
}

// Width / height from the sizing modes. A wide fixed width becomes a max-width,
// so the design keeps its size on a big screen and still fits a small one.
const FLUID_FROM = 480;
function sizeCss(n, parent) {
  const css = {};
  const fk = parent ? flexKind(parent) : null;
  const mainW = fk === 'row' && n.wMode === 'fill';
  const mainH = fk === 'column' && n.hMode === 'fill' && n.type !== 'text';
  const fixedW = (w) => w >= FLUID_FROM ? { width: '100%', 'max-width': px(w) } : { width: px(w) };
  if (n.type === 'text') {
    if (!n.autoSize && !mainW) Object.assign(css, n.wMode === 'fill' ? { width: '100%' } : fixedW(n.w));
    return css;
  }
  if (!mainW) {
    if (n.wMode === 'fill') css.width = '100%';
    else if (n.wMode === 'hug') css.width = 'fit-content';
    else Object.assign(css, fixedW(n.w));
  }
  if (!mainH) {
    if (n.hMode === 'fill') css.height = '100%';
    else if (n.hMode !== 'hug') {
      // A box with content grows past its design height rather than clip it.
      css[(n.children || []).length ? 'min-height' : 'height'] = px(n.h);
    }
  }
  return css;
}

function radiusCss(n) {
  if (n.shape === 'circle') return { 'border-radius': '50%' };
  if (n.radiusMode === 'corners') {
    const r = n.radii || {};
    return (r.tl || r.tr || r.br || r.bl) ? { 'border-radius': `${px(r.tl)} ${px(r.tr)} ${px(r.br)} ${px(r.bl)}` } : {};
  }
  return n.radius > 0 ? { 'border-radius': px(n.radius) } : {};
}

function strokeCss(n) {
  if (!(n.strokeW > 0)) return {};
  const color = (n.type === 'container' || n.type === 'image' || n.type === 'frame')
    ? (varRef(n.strokeColorId, { solidOnly: true }) || (n.strokeColorId ? null : solidCss(n.stroke, n.strokeOpacity)))
    : solidCss(n.stroke, n.strokeOpacity);
  if (!color || color === 'transparent') return {};
  const line = `${px(n.strokeW)} ${n.strokeStyle || 'solid'} ${color}`;
  const s = n.strokeSides;
  if (!s) return { border: line };
  const css = {};
  if (s.t) css['border-top'] = line;
  if (s.r) css['border-right'] = line;
  if (s.b) css['border-bottom'] = line;
  if (s.l) css['border-left'] = line;
  return css;
}

function shadowColor(s) {
  const base = varRef(s.colorId, { solidOnly: true }) || '#000000';
  return withAlpha(base, s.alpha == null ? 0.25 : s.alpha);
}

// A box's fill, border, corners, shadows.
function boxPaintCss(n) {
  const css = {};
  const fill = n.colorId ? varRef(n.colorId)
    : (n.fillType === 'linear' || n.fillType === 'radial') ? gradientCss(n)
    : (n.fill && n.fill !== 'transparent' ? solidCss(n.fill, n.alpha) : null);
  if (fill) css.background = fill;
  Object.assign(css, radiusCss(n), strokeCss(n));
  const shadows = (n.shadows || []);
  if (shadows.length) css['box-shadow'] = shadows.map(s => `${s.inset ? 'inset ' : ''}${px(s.x)} ${px(s.y)} ${px(s.blur)} ${px(s.spread)} ${shadowColor(s)}`).join(', ');
  return css;
}

// What any element can have: opacity, rotation / mirroring, blurs.
function effectsCss(n) {
  const css = {};
  if (n.opacity != null && n.opacity < 1) css.opacity = String(Math.round(n.opacity * 100) / 100);
  const t = [];
  if (n.rotation) t.push(`rotate(${n.rotation}deg)`);
  if (n.flipH) t.push('scaleX(-1)');
  if (n.flipV) t.push('scaleY(-1)');
  if (t.length) css.transform = t.join(' ');
  if (n.layerBlur > 0) css.filter = `blur(${px(n.layerBlur)})`;
  if (n.backdropBlur > 0) { css['backdrop-filter'] = `blur(${px(n.backdropBlur)})`; css['-webkit-backdrop-filter'] = css['backdrop-filter']; }
  return css;
}

// A text's own settings on top of its text style class.
function textCss(n, t) {
  const css = {};
  if (t) {
    if (n.fontSizeOverride != null) css['font-size'] = px(n.fontSizeOverride);
    if (n.fontWeightOverride) css['font-weight'] = n.fontWeightOverride;
  } else {
    Object.assign(css, { 'font-size': px(n.fontSize || 16), 'font-weight': n.fontWeight || '400', 'line-height': '1.4' });
  }
  const own = varRef(n.colorId, { solidOnly: true });
  if (own) css.color = own;
  else if (!t && n.color) css.color = n.color;
  const align = n.alignment && n.alignment.h;
  if (align && align !== 'left') css['text-align'] = align;
  if (n.italic) css['font-style'] = 'italic';
  if (n.decoration === 'underline') css['text-decoration'] = 'underline';
  else if (n.decoration === 'lineThrough') css['text-decoration'] = 'line-through';
  if (n.textCase === 'upper') css['text-transform'] = 'uppercase';
  else if (n.textCase === 'lower') css['text-transform'] = 'lowercase';
  if (n.shadows && n.shadows.length) css['text-shadow'] = n.shadows.map(s => `${px(s.x)} ${px(s.y)} ${px(s.blur)} ${shadowColor(s)}`).join(', ');
  return css;
}

// ── data (Tera) ──────────────────────────────────────────────────────────────
// The page renders on the server from a context the page's handler passes: one
// variable per mock set / provider the page reads (named the same), holding that
// data as JSON. Bindings, repeats and conditions become Tera expressions over it.

// A data path as Tera: { expr, type, nullable }. A path through an optional
// field (or a provider's data, which may not have loaded) can be null.
function dataRef(n, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  const scope = scopeFor(n);
  const root = scope[parts[0]];
  if (!root) return null;
  let type = root.type, nullable = root.source === 'provider';
  for (const field of parts.slice(1)) {
    const m = state.models.find(x => x.name === type.base);
    const f = m && m.properties.find(p => p.name === field);
    if (!f) return null;
    type = f.type;
    if (f.required === false) nullable = true;
  }
  return { expr: parts.join('.'), type, nullable, root: parts[0], rootSource: root.source };
}

// A Tera string literal: in whichever quote the text doesn't use.
function teraStr(s) {
  const v = String(s ?? '');
  for (const q of ['"', "'", '`']) if (!v.includes(q)) return q + v + q;
  return '"' + v.replace(/"/g, '”') + '"';
}

const isList = (t) => t && (t.base === 'List' || t.base === 'Set');
const isEnumT = (t) => t && state.enums.some(e => e.name === t.base);

// Text shown from data: {{ path }} (Tera escapes it), a list joined with commas,
// and the design's own text where an optional value is missing.
function teraOut(ref, fallback = '') {
  let expr = ref.expr;
  if (isList(ref.type)) expr += ' | join(sep=", ")';
  return ref.nullable ? `{{ ${expr} | default(value=${teraStr(fallback)}) }}` : `{{ ${expr} }}`;
}

// A condition (show-if, a conditional route) as a Tera test, matching the
// editor's own (data.js evalCond): "true / set", equals, greater than, empty…
function teraCond(n, cond) {
  const ref = cond && cond.path ? dataRef(n, cond.path) : null;
  if (!ref) return null;
  const e = ref.expr, t = ref.type.base;
  const num = (v) => String(Number(v) || 0);
  const lit = () => (t === 'int' || t === 'double') ? num(cond.value)
    : t === 'bool' ? String(cond.value === true || cond.value === 'true')
    : teraStr(cond.value);
  const set = ref.nullable ? `${e} is defined and ${e}` : e; // truthy: not missing, not empty / 0 / false
  switch (cond.op) {
    case 'truthy': case 'notEmpty': return set;
    case 'falsy': case 'empty': return `not (${set})`;
    case '==': return `${e} == ${lit()}`;
    case '!=': return `${e} != ${lit()}`;
    case '>': case '<': case '>=': case '<=':
      return `${isList(ref.type) ? `${e} | length` : e} ${cond.op} ${num(cond.value)}`;
    default: return set;
  }
}

// Wrap an element in {% if %} for its show-if condition.
function withShowIf(n, html, depth) {
  const cond = n.showIf ? teraCond(n, n.showIf) : null;
  return cond ? `${pad(depth)}{% if ${cond} %}\n${html}\n${pad(depth)}{% endif %}` : html;
}

// The variables a page reads, for the comment at its top.
function contextNote(frame) {
  const roots = new Map();
  const note = (n, path) => { const r = path ? dataRef(n, path) : null; if (r && r.rootSource) roots.set(r.root, r.rootSource); };
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    if (n.repeat && n.repeat.source) note(n, n.repeat.source);
    if (n.showIf && n.showIf.path) note(n, n.showIf.path);
    Object.values(n.bind || {}).forEach(p => note(n, p));
    ((n.action && n.action.routes) || []).forEach(r => r && r.when && note(n, r.when.path));
    if (n.type === 'instance') walk(getMasterNode(n.componentId));
    kids(n).forEach(walk);
  };
  walk(frame);
  if (!roots.size) return '';
  const scope = rootScope();
  const lines = [...roots].map(([name, source]) => {
    const t = scope[name] && scope[name].type;
    const what = t ? (isList(t) ? `a list of ${t.args[0].base}` : `a ${t.base}`) : 'data';
    return `     ${name}: ${what} (${source === 'provider' ? `the "${name}" provider's data` : `like the "${name}" mock data`})`;
  });
  return `{#\n  Context this page reads (passed by its handler, as JSON):\n${lines.join('\n')}\n#}`; // no newline after: nothing comes before <!DOCTYPE>
}

// ── page facts ───────────────────────────────────────────────────────────────
function textWeight(n) {
  const t = n.typoId ? getTypoById(n.typoId) : null;
  return parseInt(n.fontWeightOverride || (t ? t.fontWeight : n.fontWeight) || '400', 10);
}
function textSize(n) {
  const t = n.typoId ? getTypoById(n.typoId) : null;
  return n.fontSizeOverride ?? (t ? t.fontSize : (n.fontSize || 16));
}
function walkTexts(frame, fn) {
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n.id) || n.visible === false) return;
    seen.add(n.id);
    if (n.type === 'text') fn(n);
    if (n.type === 'instance') walk(getMasterNode(n.componentId));
    kids(n).forEach(walk);
  };
  walk(frame);
}
function maxTextSize(frame) { let m = 0; walkTexts(frame, n => { m = Math.max(m, textSize(n)); }); return m; }
function hasExplicitH1(frame) { let h = false; walkTexts(frame, n => { if (n.htmlTag === 'h1') h = true; }); return h; }

// ── Web Components ───────────────────────────────────────────────────────────
// The scripts for interactive elements, written into the project once each
// (assets/js/components/<tag>.js). Each enhances HTML the server already
// rendered complete, so the page reads the same without them.
const WIDGET_SCRIPTS = {
  'app-tabs': `// <app-tabs> — tabs rendered on the server: a role="tablist" bar of
// role="tab" buttons, then one role="tabpanel" per tab, all in the HTML (the
// inactive ones \`hidden\`). This only switches between them: click, or the
// arrow keys / Home / End on the bar. Generated by Scaffold.
class AppTabs extends HTMLElement {
  connectedCallback() {
    if (this.tabs) return;
    const bar = this.querySelector(':scope > [role="tablist"]');
    if (!bar) return;
    this.tabs = [...bar.querySelectorAll(':scope > [role="tab"]')];
    this.panels = [...this.querySelectorAll(':scope > [role="tabpanel"]')];
    const uid = 'tabs-' + Math.random().toString(36).slice(2, 8);
    this.tabs.forEach((tab, i) => {
      const panel = this.panels[i];
      if (!tab.id) tab.id = uid + '-tab-' + i;
      if (panel) {
        if (!panel.id) panel.id = uid + '-panel-' + i;
        tab.setAttribute('aria-controls', panel.id);
        panel.setAttribute('aria-labelledby', tab.id);
      }
      tab.addEventListener('click', () => this.select(i));
      tab.addEventListener('keydown', (e) => {
        const last = this.tabs.length - 1;
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: last }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        this.select(to < 0 ? last : to > last ? 0 : to, true);
      });
    });
  }

  // Show tab \`index\`; \`focus\` moves the keyboard focus to it.
  select(index, focus = false) {
    this.tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (this.panels[i]) this.panels[i].hidden = !on;
    });
    if (focus) this.tabs[index].focus();
    this.dispatchEvent(new CustomEvent('tab-change', { detail: { index }, bubbles: true }));
  }
}

if (!customElements.get('app-tabs')) customElements.define('app-tabs', AppTabs);
`,
};
export const widgetScript = (tag) => WIDGET_SCRIPTS[tag] || '';
