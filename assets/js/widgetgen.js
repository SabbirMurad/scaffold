import { state, getNode } from './state.js';
import { flexKind, isStack } from './nodes.js';
import { isImageRef, refId, imageDataUri } from './images.js';

// ───────── Design → Flutter widget-tree generation ─────────
//
// Turns a screen frame's node tree into a Flutter widget tree for the screen's
// build() method. It honours the design's own layout model:
//   • container/frame with layout row|column  → Row / Column (with spacing + alignment)
//   • container/frame with layout wrap         → Wrap
//   • container/frame with layout stack        → Stack + Positioned
//   • container/frame with no layout           → its single child (aligned + padded)
//   • free-positioned children (stack/section) → Stack + Positioned
// Sizes use flutter_screenutil (.w/.h/.r/.sp); colours reference VColors and text
// styles reference VTextStyle when the node points at a variable. Icons export
// their SVG to assets/icons/<name>.svg and render via flutter_svg's SvgPicture.asset.
//
// First pass — known gaps: node flips, and dashed/dotted stroke styles.

// Format a number: integer stays whole, otherwise trimmed to 2 dp.
const d = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(2)));
};

// A minimal Dart-call AST node. `pos` = positional args, `props` = named args,
// plus a single `child` or a `children` list. Values may be strings (raw Dart) or
// nested AST nodes.
const W = (name, props = {}, opts = {}) =>
  ({ name, pos: opts.pos || [], props, child: opts.child ?? null, children: opts.children ?? null });

// Pretty-print an AST node (or raw string) at a given indent depth.
function printW(w, indent = 0) {
  if (w == null) return 'const SizedBox()';
  if (typeof w === 'string') return w;
  const hasBody = w.pos.length || Object.keys(w.props).length || w.child != null || w.children != null;
  if (!hasBody) return `${w.name}()`;
  const pad = '  '.repeat(indent);
  const ip = '  '.repeat(indent + 1);
  const parts = [`${w.name}(`];
  w.pos.forEach(a => parts.push(`${ip}${printW(a, indent + 1)},`));
  for (const [k, v] of Object.entries(w.props)) parts.push(`${ip}${k}: ${printW(v, indent + 1)},`);
  if (w.child != null) parts.push(`${ip}child: ${printW(w.child, indent + 1)},`);
  if (w.children != null) {
    parts.push(`${ip}children: [`);
    w.children.forEach(c => parts.push(`${'  '.repeat(indent + 2)}${printW(c, indent + 2)},`));
    parts.push(`${ip}],`);
  }
  parts.push(`${pad})`);
  return parts.join('\n');
}

// ── Dart literals ──
function dartStr(s) {
  return `'${String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\n/g, '\\n')}'`;
}
function argb(hex, alpha) {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  h = h.slice(0, 6).padEnd(6, '0');
  const a = Math.round((alpha == null ? 1 : alpha) * 255);
  return (a.toString(16).padStart(2, '0') + h).toUpperCase();
}
function colorLiteral(hex, alpha = 1) {
  if (!hex || hex === 'transparent') return 'Colors.transparent';
  return `Color(0x${argb(hex, alpha)})`;
}

// A solid colour expression: the referenced VColors constant if the node points at
// a colour variable, else a raw Color literal, else null (no colour).
function solidColor(ctx, colorId, fallbackHex, alpha = 1) {
  if (colorId) {
    const c = state.colors.find(x => x.id === colorId);
    if (c) { ctx.colors = true; return `VColors.${c.name}`; }
  }
  if (fallbackHex && fallbackHex !== 'transparent') return colorLiteral(fallbackHex, alpha);
  return null;
}

// ── screenutil-suffixed dimensions ──
const sw = (ctx, n) => { ctx.screenutil = true; return `${d(n)}.w`; };
const sh = (ctx, n) => { ctx.screenutil = true; return `${d(n)}.h`; };
const sr = (ctx, n) => { ctx.screenutil = true; return `${d(n)}.r`; };
const ssp = (ctx, n) => { ctx.screenutil = true; return `${d(n)}.sp`; };

// EdgeInsets from a {t,r,b,l} box, or null when all-zero.
function edgeInsets(ctx, box) {
  const b = box || { t: 0, r: 0, b: 0, l: 0 };
  if (!b.t && !b.r && !b.b && !b.l) return null;
  if (b.l === b.r && b.t === b.b) {
    const parts = [];
    if (b.l) parts.push(`horizontal: ${sw(ctx, b.l)}`);
    if (b.t) parts.push(`vertical: ${sh(ctx, b.t)}`);
    return `EdgeInsets.symmetric(${parts.join(', ')})`;
  }
  return `EdgeInsets.only(left: ${sw(ctx, b.l)}, top: ${sh(ctx, b.t)}, right: ${sw(ctx, b.r)}, bottom: ${sh(ctx, b.b)})`;
}

// ── decoration (fill / gradient / border / radius / shadow) ──
function gradientExpr(ctx, node) {
  const g = node.gradient || { angle: 90, stops: [] };
  const stops = [...(g.stops || [])].sort((a, b) => a.pos - b.pos);
  const colors = stops.map(s => colorLiteral(s.color, s.alpha == null ? 1 : s.alpha)).join(', ');
  const positions = stops.map(s => d((s.pos || 0) / 100)).join(', ');
  if (node.fillType === 'radial') {
    return `RadialGradient(colors: [${colors}], stops: [${positions}])`;
  }
  const rad = ((g.angle || 0) * Math.PI) / 180;
  return `LinearGradient(colors: [${colors}], stops: [${positions}], transform: GradientRotation(${d(rad)}))`;
}

function borderRadiusExpr(ctx, node) {
  if (node.shape === 'circle') return null; // handled via BoxShape.circle
  if (node.radiusMode === 'corners') {
    const r = node.radii || { tl: 0, tr: 0, br: 0, bl: 0 };
    if (!r.tl && !r.tr && !r.br && !r.bl) return null;
    return `BorderRadius.only(topLeft: Radius.circular(${sr(ctx, r.tl)}), topRight: Radius.circular(${sr(ctx, r.tr)}), `
      + `bottomRight: Radius.circular(${sr(ctx, r.br)}), bottomLeft: Radius.circular(${sr(ctx, r.bl)}))`;
  }
  if (node.radius > 0) return `BorderRadius.circular(${sr(ctx, node.radius)})`;
  return null;
}

function shadowListExpr(ctx, node) {
  return '[' + node.shadows.map(s => {
    const col = solidColor(ctx, s.colorId, '#000000', s.alpha == null ? 0.25 : s.alpha)
      || colorLiteral('#000000', s.alpha == null ? 0.25 : s.alpha);
    return `BoxShadow(color: ${col}, offset: Offset(${sw(ctx, s.x || 0)}, ${sh(ctx, s.y || 0)}), `
      + `blurRadius: ${sr(ctx, s.blur || 0)}, spreadRadius: ${sr(ctx, s.spread || 0)})`;
  }).join(', ') + ']';
}

// A BoxDecoration AST for a box node, or null when nothing to decorate.
function decorationExpr(ctx, node) {
  const props = {};
  const isGrad = node.fillType === 'linear' || node.fillType === 'radial';
  if (isGrad) props.gradient = gradientExpr(ctx, node);
  else { const col = solidColor(ctx, node.colorId, node.fill); if (col) props.color = col; }
  if (node.strokeW > 0) {
    const sc = solidColor(ctx, node.strokeColorId, node.stroke) || 'Colors.black';
    props.border = `Border.all(color: ${sc}, width: ${sw(ctx, node.strokeW)})`;
  }
  if (node.shape === 'circle') props.shape = 'BoxShape.circle';
  else { const br = borderRadiusExpr(ctx, node); if (br) props.borderRadius = br; }
  if (node.shadows && node.shadows.length) props.boxShadow = shadowListExpr(ctx, node);
  return Object.keys(props).length ? W('BoxDecoration', props) : null;
}

// ── alignment ──
const H_MAIN = { left: 'start', center: 'center', right: 'end' };
const V_MAIN = { top: 'start', center: 'center', bottom: 'end' };
const ALIGN_2D = {
  'left|top': 'topLeft', 'center|top': 'topCenter', 'right|top': 'topRight',
  'left|center': 'centerLeft', 'center|center': 'center', 'right|center': 'centerRight',
  'left|bottom': 'bottomLeft', 'center|bottom': 'bottomCenter', 'right|bottom': 'bottomRight',
};
function mainAxisAlign(node, fk) {
  const a = node.alignment || {};
  return fk === 'row' ? (H_MAIN[a.h] || 'start') : (V_MAIN[a.v] || 'start');
}
function crossAxisAlign(node, fk) {
  const a = node.alignment || {};
  return fk === 'row' ? (V_MAIN[a.v] || 'start') : (H_MAIN[a.h] || 'start');
}
function alignment2D(node) {
  const a = node.alignment || { h: 'left', v: 'top' };
  if (a.h === 'left' && a.v === 'top') return null; // Flutter default — omit
  return `Alignment.${ALIGN_2D[`${a.h}|${a.v}`] || 'topLeft'}`;
}

// ── sizing ──
// Explicit width/height for a box, honouring its sizing mode. `omitW`/`omitH`
// suppress an axis (used when a flex parent's Expanded owns the main axis).
function sizeProps(ctx, node, opts) {
  const props = {};
  if (!opts.omitW) {
    if (node.wMode === 'fixed') props.width = sw(ctx, node.w);
    else if (node.wMode === 'fill') props.width = 'double.infinity';
  }
  if (!opts.omitH) {
    if (node.hMode === 'fixed') props.height = sh(ctx, node.h);
    else if (node.hMode === 'fill') props.height = 'double.infinity';
  }
  return props;
}

// ── leaf builders ──
function textStyleExpr(ctx, node) {
  if (node.typoId) {
    const t = state.typography.find(s => s.id === node.typoId);
    if (t) {
      ctx.typo = true;
      // Per-text overrides layer over the style: VTextStyle.x.copyWith(...).
      const over = {};
      if (node.fontSizeOverride != null) over.fontSize = ssp(ctx, node.fontSizeOverride);
      if (node.fontWeightOverride) over.fontWeight = `FontWeight.w${node.fontWeightOverride}`;
      const col = solidColor(ctx, node.colorId, null);
      if (col) over.color = col;
      return Object.keys(over).length ? W(`VTextStyle.${t.name}.copyWith`, over) : `VTextStyle.${t.name}`;
    }
  }
  const props = { fontSize: ssp(ctx, node.fontSize || 14), fontWeight: `FontWeight.w${node.fontWeight || '400'}` };
  const col = solidColor(ctx, node.colorId, node.color);
  if (col) props.color = col;
  return W('TextStyle', props);
}
function textAlignExpr(node) {
  const h = (node.alignment && node.alignment.h) || 'left';
  if (h === 'center') return 'TextAlign.center';
  if (h === 'right') return 'TextAlign.right';
  return null;
}
function buildText(ctx, node) {
  const props = { style: textStyleExpr(ctx, node) };
  const ta = textAlignExpr(node);
  if (ta) props.textAlign = ta;
  let w = W('Text', props, { pos: [dartStr(node.text || '')] });
  // Fixed-width text wraps inside a SizedBox so it matches the design's wrap width.
  if (!node.autoSize && node.wMode !== 'hug') w = W('SizedBox', { width: sw(ctx, node.w) }, { child: w });
  return w;
}
const FIT = {
  cover: 'BoxFit.cover', contain: 'BoxFit.contain', fill: 'BoxFit.fill',
  fitWidth: 'BoxFit.fitWidth', fitHeight: 'BoxFit.fitHeight',
};
const IMG_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};
// Decode a base64 data-URI into raw bytes.
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// Register an image's bytes for export under assets/images/<name>.<ext> and return
// that asset path. Bytes come from a base64 data-URI: either an `img:` ref that was
// pre-resolved by resolveRefsForExport, or a bare data-URI still inline on the node.
// A bare remote URL, or an unresolved ref, returns null. Identical images share one
// file (named by a content hash).
function registerImage(ctx, node) {
  let src = node.src || '';
  if (isImageRef(src)) src = imageDataUri(refId(src)) || '';
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(src);
  if (!m || !m[2]) return null;
  const ext = IMG_EXT[(m[1] || 'image/png').toLowerCase()] || 'png';
  const b64 = m[3];
  const path = `assets/images/image_${hashStr(b64)}.${ext}`;
  ctx.images.set(path, b64ToBytes(b64));
  return path;
}
function buildImage(ctx, node, opts) {
  const props = sizeProps(ctx, node, opts);
  const deco = {};
  const br = borderRadiusExpr(ctx, node);
  if (br) deco.borderRadius = br;
  const assetPath = node.src ? registerImage(ctx, node) : null;
  if (assetPath) {
    deco.image = `DecorationImage(image: AssetImage(${dartStr(assetPath)}), fit: ${FIT[node.fit] || 'BoxFit.cover'})`;
  } else if (node.src && !isImageRef(node.src)) {
    // A bare remote URL (the picker's CORS fallback) → NetworkImage.
    deco.image = `DecorationImage(image: NetworkImage(${dartStr(node.src)}), fit: ${FIT[node.fit] || 'BoxFit.cover'})`;
  } else {
    // No image, or an image whose bytes couldn't be resolved → plain fill.
    const col = solidColor(ctx, node.colorId, node.fill) || 'Color(0x1AFFFFFF)';
    deco.color = col;
  }
  props.decoration = W('BoxDecoration', deco);
  return W('Container', props);
}
// djb2 hash → base36, to name icon files that have no Iconify id deterministically.
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
// Register an icon's SVG for export under assets/icons/<name>.svg and return that
// asset path. Named from the Iconify id (e.g. mdi:home → mdi_home) when present,
// else a content hash so identical icons share one file across screens.
function iconAssetPath(ctx, node) {
  const base = node.iconId || ('icon_' + hashStr(node.svg));
  const name = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'icon';
  const path = `assets/icons/${name}.svg`;
  ctx.icons.set(path, node.svg);
  return path;
}
function buildIcon(ctx, node, opts) {
  // No SVG assigned yet → just reserve the space.
  if (!node.svg) return W('SizedBox', { width: sw(ctx, node.w), height: sh(ctx, node.h) });
  ctx.svg = true;
  const path = iconAssetPath(ctx, node);
  const tint = solidColor(ctx, node.colorId, null);
  const props = { width: sw(ctx, node.w), height: sh(ctx, node.h), fit: 'BoxFit.contain' };
  // The design icons are monochrome (currentColor); recolour via a source-in filter.
  if (tint) props.colorFilter = `ColorFilter.mode(${tint}, BlendMode.srcIn)`;
  return W('SvgPicture.asset', props, { pos: [dartStr(path)] });
}

// ── layout builders ──
function buildFlex(ctx, node, kids, fk) {
  const props = {
    mainAxisAlignment: `MainAxisAlignment.${mainAxisAlign(node, fk)}`,
    crossAxisAlignment: `CrossAxisAlignment.${crossAxisAlign(node, fk)}`,
  };
  if ((fk === 'row' && node.wMode === 'hug') || (fk === 'column' && node.hMode === 'hug')) {
    props.mainAxisSize = 'MainAxisSize.min';
  }
  if (node.gap) props.spacing = fk === 'row' ? sw(ctx, node.gap) : sh(ctx, node.gap);
  const children = kids.map(k => buildFlexChild(ctx, k, fk));
  return W(fk === 'row' ? 'Row' : 'Column', props, { children });
}
function buildFlexChild(ctx, k, fk) {
  const fillMain = (fk === 'row' && k.wMode === 'fill') || (fk === 'column' && k.hMode === 'fill');
  if (fillMain) {
    return W('Expanded', {}, { child: buildNode(ctx, k, fk === 'row' ? { omitW: true } : { omitH: true }) });
  }
  return buildNode(ctx, k, {});
}
function buildWrap(ctx, node, kids) {
  const props = {};
  if (node.gapH) props.spacing = sw(ctx, node.gapH);
  if (node.gapV) props.runSpacing = sh(ctx, node.gapV);
  return W('Wrap', props, { children: kids.map(k => buildNode(ctx, k, {})) });
}
function buildStack(ctx, node, kids) {
  const children = kids.map(k =>
    W('Positioned', { left: sw(ctx, k.x), top: sh(ctx, k.y) }, { child: buildNode(ctx, k, {}) }));
  return W('Stack', {}, { children });
}

// A container/frame box: build its content per layout, then wrap in a Container
// when it needs a size, padding, margin, alignment, or decoration. `isRoot` (the
// screen frame) skips its own size/background — those go on the Scaffold.
function buildBox(ctx, node, opts) {
  const kids = (node.children || []).map(id => getNode(id)).filter(c => c && c.visible);
  const fk = flexKind(node);
  let content;
  if (fk === 'row' || fk === 'column') content = buildFlex(ctx, node, kids, fk);
  else if (fk === 'wrap') content = buildWrap(ctx, node, kids);
  else if (isStack(node)) content = buildStack(ctx, node, kids);
  else content = kids.length ? buildNode(ctx, kids[0], {}) : null; // single-child wrapper

  const cprops = {};
  if (!opts.isRoot) Object.assign(cprops, sizeProps(ctx, node, opts));
  const pad = edgeInsets(ctx, node.padding);
  if (pad) cprops.padding = pad;
  if (node.type === 'container') { const m = edgeInsets(ctx, node.margin); if (m) cprops.margin = m; }
  if (!fk && !isStack(node) && content) { const al = alignment2D(node); if (al) cprops.alignment = al; }
  const deco = opts.isRoot ? null : decorationExpr(ctx, node);
  if (deco) cprops.decoration = deco;

  if (!Object.keys(cprops).length) return content; // nothing to wrap — pass content through
  return W('Container', cprops, { child: content });
}

// Wrap a built widget in opacity / rotation effects (applies to every node type).
function applyEffects(ctx, node, w) {
  let out = w;
  if (node.rotation) out = W('Transform.rotate', { angle: d((node.rotation * Math.PI) / 180) }, { child: out });
  if (node.opacity != null && node.opacity < 1) out = W('Opacity', { opacity: d(node.opacity) }, { child: out });
  return out;
}

// Dispatch a node to its builder + shared effects.
function buildNode(ctx, node, opts = {}) {
  if (!node) return null;
  let w;
  if (node.type === 'text') w = buildText(ctx, node);
  else if (node.type === 'image') w = buildImage(ctx, node, opts);
  else if (node.type === 'icon') w = buildIcon(ctx, node, opts);
  else w = buildBox(ctx, node, opts);
  return applyEffects(ctx, node, w);
}

// Public: build a screen frame's Scaffold body. Returns the Dart expression for
// `build()` plus a `ctx` of which imports it needs.
export function generateScreenBody(frame) {
  // ctx also collects the asset files the screen uses so the exporter can drop them
  // into the zip: icon SVGs (path → svg markup) under assets/icons/, and image bytes
  // (path → Uint8Array) under assets/images/.
  const ctx = { screenutil: false, colors: false, typo: false, svg: false, icons: new Map(), images: new Map() };
  const bg = solidColor(ctx, frame.colorId, frame.fill);
  const inner = buildBox(ctx, frame, { isRoot: true });
  const props = {};
  if (bg) props.backgroundColor = bg;
  props.body = W('SafeArea', {}, { child: inner || W('SizedBox') });
  return { code: printW(W('Scaffold', props), 2), ctx };
}
