// Icon SVG is drawn into the page as markup (render.js → applyIcon), and it can
// come from anyone: a pasted Figma selection, an imported .scaffold design file,
// a collaborator's edit, Claude. Markup drawn into the page can:
//   - run script (event handlers like onload / onerror, <script>, javascript:
//     links, <foreignObject> holding HTML) — inside the app, with its powers;
//   - restyle the app: a <style> inside an inline SVG applies to the whole page,
//     and a class can pick up the app's own rules;
//   - cover the app: style="position:fixed;inset:0" on the <svg> takes every click;
//   - take the app's element ids (DOM clobbering): an id="ai-prompt" makes the
//     app's own getElementById find the icon — and icons with the same ids
//     (#grad) draw with each other's gradients.
//
// safeSvg keeps what draws the picture and makes it inert: only known SVG
// elements and presentation attributes survive; <style> rules are copied onto
// the elements they match and the <style> and classes dropped; style
// attributes keep only paint and text properties; every id gets a prefix of
// this drawing's own (with its #id / url(#id) references rewritten); links may
// only point inside the drawing or at an embedded raster image, and nothing
// can load from elsewhere. Results are cached, since the canvas redraws often.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Elements that draw (no script, foreignObject, animation of attributes, or
// anything that embeds other documents). <style> is read, then removed.
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
  'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile',
  'feTurbulence', 'image',
]);

// Attributes that shape or paint; everything else (on*, class, and anything
// unknown) is dropped.
const ATTRIBUTES = new Set([
  'id', 'style', 'transform', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points', 'pathLength',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity',
  'color', 'display', 'visibility', 'overflow', 'clip-path', 'clip-rule', 'mask', 'filter',
  'marker-start', 'marker-mid', 'marker-end', 'vector-effect', 'shape-rendering', 'paint-order',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'patternUnits', 'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits',
  'maskContentUnits', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient',
  'filterUnits', 'primitiveUnits', 'in', 'in2', 'result', 'stdDeviation', 'dx', 'dy', 'mode',
  'values', 'type', 'operator', 'k1', 'k2', 'k3', 'k4', 'radius', 'scale', 'xChannelSelector',
  'yChannelSelector', 'flood-color', 'flood-opacity', 'lighting-color', 'baseFrequency',
  'numOctaves', 'seed', 'stitchTiles', 'tableValues', 'slope', 'intercept', 'amplitude',
  'exponent', 'surfaceScale', 'diffuseConstant', 'specularConstant', 'specularExponent',
  'kernelMatrix', 'order', 'divisor', 'bias', 'targetX', 'targetY', 'edgeMode',
  'preserveAlpha', 'azimuth', 'elevation', 'pointsAtX', 'pointsAtY', 'pointsAtZ',
  'limitingConeAngle', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'word-spacing', 'text-decoration',
  'textLength', 'lengthAdjust', 'startOffset', 'method', 'spacing', 'href', 'xlink:href',
  'xmlns', 'xmlns:xlink', 'version', 'enable-background', 'mix-blend-mode', 'isolation',
]);

// The CSS properties a style may set: SVG's paint and text properties — never
// layout (position, inset, width, z-index…), animation, cursor or content.
const STYLE_PROPS = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'color',
  'display', 'visibility', 'clip-path', 'clip-rule', 'mask', 'filter', 'marker-start', 'marker-mid',
  'marker-end', 'vector-effect', 'shape-rendering', 'paint-order', 'stop-color', 'stop-opacity',
  'flood-color', 'flood-opacity', 'lighting-color', 'mix-blend-mode', 'isolation', 'transform',
  'transform-origin', 'transform-box', 'font', 'font-family', 'font-size', 'font-weight', 'font-style',
  'font-stretch', 'font-variant', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'letter-spacing', 'word-spacing', 'text-decoration', 'white-space', 'color-interpolation-filters',
  'enable-background',
]);

// A link may point inside the drawing, or at an embedded raster image — never
// at another document or a javascript: URL.
const safeLink = (v) => /^#[\w.:-]+$/.test(v) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v);

// CSS can't run script, but it can load things (url(), @import) — only local
// fragment references (url(#grad)) are kept.
const safeCss = (css) => !/@import|expression\s*\(|javascript:|url\(\s*(?!['"]?#)/i.test(css); // the quote inside the lookahead: url('#g') is local

const cache = new Map();
const CACHE_MAX = 500;

export function safeSvg(markup) {
  if (!markup) return '';
  const src = String(markup);
  if (cache.has(src)) return cache.get(src);

  let out = '';
  const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
  const root = doc.documentElement;
  if (root && root.localName === 'svg' && root.namespaceURI === SVG_NS && !doc.querySelector('parsererror')) {
    inlineStyles(root);
    clean(root);
    // The <svg> itself: sized and clipped by the canvas, never styled from inside —
    // a transform or overflow:visible could spread it over the app.
    root.removeAttribute('style');
    root.removeAttribute('overflow');
    prefixIds(root, `s${hash(src)}-`);
    out = new XMLSerializer().serializeToString(root);
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(src, out);
  return out;
}

function clean(el) {
  for (const child of [...el.children]) {
    if (child.namespaceURI !== SVG_NS || !ELEMENTS.has(child.localName)) { child.remove(); continue; }
    clean(child);
  }
  for (const attr of [...el.attributes]) {
    const name = attr.name;
    const value = attr.value.trim();
    if (!ATTRIBUTES.has(name)) { el.removeAttributeNode(attr); continue; }
    if ((name === 'href' || name === 'xlink:href') && !safeLink(value)) { el.removeAttributeNode(attr); continue; }
    if (name === 'style') {
      const kept = safeStyle(value);
      if (kept) el.setAttribute('style', kept); else el.removeAttribute('style');
      continue;
    }
    // A paint or reference attribute may only point inside the drawing.
    if (/url\(/i.test(value) && !/^url\(\s*['"]?#[\w.:-]+['"]?\s*\)$/i.test(value)) el.removeAttributeNode(attr);
  }
  // <image> is kept only with an embedded raster image.
  if (el.localName === 'image' || el.localName === 'feImage') {
    const href = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href');
    if (!href) el.remove();
  }
}

// A style attribute's declarations, keeping only the allowed properties with
// values that can't load anything. '' when none are left.
function safeStyle(css) {
  return splitDeclarations(css)
    .filter(([prop, value]) => STYLE_PROPS.has(prop) && safeCss(value) && !/[<>]/.test(value))
    .map(([prop, value]) => `${prop}:${value}`)
    .join(';');
}
function splitDeclarations(css) {
  return String(css).split(';').map(d => {
    const i = d.indexOf(':');
    return i < 0 ? null : [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()];
  }).filter(d => d && d[0] && d[1]);
}

// Copy each <style> rule onto the elements it matches (before their own style,
// which wins), then remove the <style> and every class — so a drawing styled by
// classes (Illustrator, Figma exports) looks the same without its stylesheet
// reaching the page. Rules that aren't simple style rules (@font-face, @media,
// @keyframes…) are dropped.
function inlineStyles(root) {
  const styles = [...root.getElementsByTagNameNS(SVG_NS, 'style')];
  const applied = new Map(); // element → declarations, in rule order
  if (styles.length && typeof CSSStyleSheet === 'function') {
    for (const style of styles) {
      let sheet;
      try { sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent || ''); } catch { continue; }
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        let targets;
        try { targets = root.querySelectorAll(rule.selectorText); } catch { continue; }
        const decls = splitDeclarations(rule.style.cssText);
        targets.forEach(el => applied.set(el, [...(applied.get(el) || []), ...decls]));
      }
    }
  }
  applied.forEach((decls, el) => {
    const own = el.getAttribute('style');
    el.setAttribute('style', decls.map(([p, v]) => `${p}:${v}`).join(';') + (own ? ';' + own : ''));
  });
  styles.forEach(s => s.remove());
  root.querySelectorAll('[class]').forEach(el => el.removeAttribute('class'));
  root.removeAttribute('class');
}

// Give every id this drawing's prefix and rewrite the references to them —
// #id links and url(#id) paints. A reference to an id the drawing doesn't have
// (another element on the page) is removed.
function prefixIds(root, prefix) {
  const ids = new Map();
  [root, ...root.querySelectorAll('[id]')].forEach(el => {
    const id = el.getAttribute('id');
    if (!id) return;
    ids.set(id, prefix + id);
    el.setAttribute('id', prefix + id);
  });
  const fix = (value) => value.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/gi, (whole, q, id) =>
    (ids.has(id) ? `url(#${ids.get(id)})` : 'none'));
  [root, ...root.querySelectorAll('*')].forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name;
      if (name === 'href' || name === 'xlink:href') {
        if (!attr.value.startsWith('#')) continue; // an embedded image
        const id = attr.value.slice(1);
        if (ids.has(id)) attr.value = '#' + ids.get(id); else el.removeAttributeNode(attr);
      } else if (/url\(/i.test(attr.value)) {
        attr.value = fix(attr.value);
      }
    }
  });
}

// A short, stable hash of the source: the same drawing gets the same prefix.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}
