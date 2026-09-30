// Icon SVG is drawn into the page as markup (render.js → applyIcon), and it can
// come from anyone: a pasted Figma selection, an imported .scaffold design file,
// a collaborator's edit. SVG can carry script (event handlers like onload /
// onerror, <script>, javascript: links, <foreignObject> holding HTML), and markup
// drawn into the page runs it — inside the app, with the app's powers.
//
// safeSvg keeps what draws a picture and drops everything else: only known
// SVG elements and presentation attributes survive, links may only point inside
// the drawing (#id) or at an embedded raster image, and styles can't load
// anything. Results are cached, since the canvas redraws often.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Elements that draw (no script, foreignObject, animation of attributes, or
// anything that embeds other documents).
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'marker',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
  'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile',
  'feTurbulence', 'image', 'style',
]);

// Attributes that shape or paint; everything else (on*, and anything unknown)
// is dropped.
const ATTRIBUTES = new Set([
  'id', 'class', 'style', 'transform', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y',
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

// A link may point inside the drawing, or at an embedded raster image — never
// at another document or a javascript: URL.
const safeLink = (v) => /^#[\w.:-]+$/.test(v) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(v);

// CSS can't run script, but it can load things (url(), @import) — only local
// fragment references (url(#grad)) are kept.
const safeCss = (css) => !/@import|expression\s*\(|javascript:|url\(\s*['"]?(?!#)/i.test(css);

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
    clean(root);
    out = new XMLSerializer().serializeToString(root);
  }

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(src, out);
  return out;
}

function clean(el) {
  for (const child of [...el.children]) {
    if (child.namespaceURI !== SVG_NS || !ELEMENTS.has(child.localName)) { child.remove(); continue; }
    if (child.localName === 'style' && !safeCss(child.textContent || '')) { child.remove(); continue; }
    clean(child);
  }
  for (const attr of [...el.attributes]) {
    const name = attr.name;
    const value = attr.value.trim();
    if (!ATTRIBUTES.has(name)) { el.removeAttributeNode(attr); continue; }
    if ((name === 'href' || name === 'xlink:href') && !safeLink(value)) { el.removeAttributeNode(attr); continue; }
    if (name === 'style' && !safeCss(value)) { el.removeAttributeNode(attr); continue; }
    // A paint or reference attribute may only point inside the drawing.
    if (/url\(/i.test(value) && !/^url\(\s*['"]?#[\w.:-]+['"]?\s*\)$/i.test(value)) el.removeAttributeNode(attr);
  }
  // <image> is kept only with an embedded raster image.
  if (el.localName === 'image' || el.localName === 'feImage') {
    const href = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href');
    if (!href) el.remove();
  }
}
