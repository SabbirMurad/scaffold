import { state, getNode, getMasterNode } from './state.js';
import { isScreenFrame, isRouteScreen, isOverlayFrame } from './nodes.js';
import { lottieFile, lottiesUsed, lottiePlayerSource } from './lottie.js';
import { typeToString, modelError, enumError } from './models.js';
import { generateScreenBody, generateComponentBody, generateOverlayBody, overlayClass, overlayFile, componentClass, imageFile, iconFile } from './widgetgen.js';
import { makeZip } from './zip.js';
import { toDart as mockDart } from './mock.js';
import { activePage, pageOf } from './pages.js';
import { generateWebPage, generateWebComponent, generateBaseCss, generateVariablesCss, generateTypographyCss, usedComponents, usedOverlays, componentTemplatePath, componentCssPath, usedWidgets, widgetScriptPath, widgetScript } from './webgen.js';

// Screen frame id → its AppRoutes constant, for taps in generated views. Filled
// while an export runs (screenItems decides the names).
let routeNames = new Map();

// Flutter/Dart model code generation. Walks each model's typed fields and emits
// a Dart class with a constructor, copyWith, fromJson / toJson and fromJsonList.
// Pure string templating — runs entirely in the browser, no backend.

const PRIMS = ['String', 'int', 'double', 'bool'];
const BODY_METHODS = ['POST', 'PUT', 'PATCH'];
const isPrimitive = (b) => PRIMS.includes(b);
const isModel = (b) => state.models.some(m => m.name === b);
const isEnum = (b) => state.enums.some(e => e.name === b);

// "authProvider" → "AuthProvider" (camelCase → PascalCase for class names).
const pascal = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// "My App" → "my_app"; ensures a valid Dart package identifier for import paths.
function pkgName() {
  let n = (state.projectName || 'app').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!n) n = 'app';
  if (/^[0-9]/.test(n)) n = 'app_' + n;
  return n;
}

// "ImageModel" → "image_model" (Dart file-name convention).
function snake(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

// Split an arbitrary name ("Sign In", "signUp", "Frame_1") into its words.
function words(s) {
  return (s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}
// "Sign In" → "SignIn" (screen class base). Falls back to "Screen".
function pascalWords(s) {
  const w = words(s);
  return w.length ? w.map(x => x[0].toUpperCase() + x.slice(1)).join('') : 'Screen';
}
// "Sign In" → "signIn" (route constant identifier). Falls back to "screen".
function camelWords(s) {
  const p = pascalWords(s);
  return p[0].toLowerCase() + p.slice(1);
}

// Collect the model/enum names a type tree references (for imports).
function collectRefs(type, set) {
  if (!type) return;
  if (isModel(type.base) || isEnum(type.base)) set.add(type.base);
  (type.args || []).forEach(a => collectRefs(a, set));
}

// Build the expression that decodes `access` (e.g. json['x'] or a list item `i`)
// into a value of `type`. Recurses through collections.
function fromJsonExpr(type, access) {
  const b = type.base;
  if (b === 'String' || b === 'int' || b === 'bool') return access;
  if (b === 'double') return `(${access} as num).toDouble()`;
  if (isEnum(b)) return `${b}.values.byName(${access})`;
  if (isModel(b)) return `${b}.fromJson(${access})`;
  if (b === 'List' || b === 'Set') {
    const inner = type.args[0];
    const close = b === 'Set' ? 'toSet' : 'toList';
    if (isPrimitive(inner.base)) return `${typeToString(type)}.from(${access})`;
    return `(${access} as List).map((i) => ${fromJsonExpr(inner, 'i')}).${close}()`;
  }
  if (b === 'Map') {
    const valT = type.args[1];
    if (isPrimitive(valT.base)) return `${typeToString(type)}.from(${access})`;
    return `(${access} as Map<String, dynamic>).map((k, v) => MapEntry(k, ${fromJsonExpr(valT, 'v')}))`;
  }
  return access;
}

// Build the expression that encodes `value` (a field value) back to JSON. `op`
// is the member operator applied to `value` — '?.' for a nullable field, so the
// whole expression short-circuits to null (Dart doesn't promote nullable
// non-final instance fields, so a `== null ? … :` guard wouldn't type-check).
// Nested recursions act on non-null loop vars, so they always use '.'.
function toJsonExpr(type, value, op = '.') {
  const b = type.base;
  if (isPrimitive(b)) return value;
  if (isEnum(b)) return `${value}${op}name`;
  if (isModel(b)) return `${value}${op}toJson()`;
  if (b === 'List' || b === 'Set') {
    const inner = type.args[0];
    if (isPrimitive(inner.base)) return b === 'Set' ? `${value}${op}toList()` : value;
    return `${value}${op}map((i) => ${toJsonExpr(inner, 'i')}).toList()`;
  }
  if (b === 'Map') {
    const valT = type.args[1];
    if (isPrimitive(valT.base)) return value;
    return `${value}${op}map((k, v) => MapEntry(k, ${toJsonExpr(valT, 'v')}))`;
  }
  return value;
}

function fromJsonField(f) {
  const access = `json['${f.name}']`;
  const plainPrim = ['String', 'int', 'bool'].includes(f.type.base);
  // Nullable fields need a guard before any cast/transform (plain primitives pass null through).
  if (f.required === false && !plainPrim) {
    return `${access} == null ? null : ${fromJsonExpr(f.type, access)}`;
  }
  return fromJsonExpr(f.type, access);
}

function toJsonField(f) {
  if (isPrimitive(f.type.base)) return f.name;
  return toJsonExpr(f.type, f.name, f.required === false ? '?.' : '.');
}

function dartType(f) {
  return typeToString(f.type) + (f.required === false ? '?' : '');
}

// The built-in ImageModel (models.js), as in the hasp app: an image the server
// stores by uuid — its webp and original URLs come from ApiEndpoint.baseUrl —
// plus the design's own images (assets) and plain URLs from the data.
const imageModelDart = (pkg) => `import 'dart:typed_data';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:${pkg}/constants/api_endpoint.dart';

class ImageModel {
  final String uuid;
  final String webp_url;
  final String original_url;
  final String blur_hash;
  final double width;
  final double height;
  final ImageProvider provider;
  final bool local;
  final Uint8List? local_bytes;

  const ImageModel({
    required this.uuid,
    required this.webp_url,
    required this.original_url,
    required this.blur_hash,
    required this.width,
    required this.height,
    required this.provider,
    this.local = false,
    this.local_bytes,
  });

  factory ImageModel.fromJson(Map<String, dynamic> json) {
    return ImageModel(
      uuid: json['uuid'],
      blur_hash: json['blur_hash'],
      webp_url: '\${ApiEndpoint.baseUrl}/image/webp/\${json['uuid']}',
      original_url: '\${ApiEndpoint.baseUrl}/image/original/\${json['uuid']}',
      width: json['width'].toDouble(),
      height: json['height'].toDouble(),
      provider: CachedNetworkImageProvider(
        '\${ApiEndpoint.baseUrl}/image/webp/\${json['uuid']}',
      ),
    );
  }

  /// Builds a network-backed model from just an image id — used for optimistic
  /// display right after an upload returns only the uuid.
  factory ImageModel.fromUuid(String uuid) {
    final webp = '\${ApiEndpoint.baseUrl}/image/webp/$uuid';
    return ImageModel(
      uuid: uuid,
      blur_hash: '',
      webp_url: webp,
      original_url: '\${ApiEndpoint.baseUrl}/image/original/$uuid',
      width: 0,
      height: 0,
      provider: CachedNetworkImageProvider(webp),
    );
  }

  /// An image shipped with the app (assets/images/…), drawn from the asset.
  factory ImageModel.asset(String path) {
    return ImageModel(
      uuid: '',
      blur_hash: '',
      webp_url: '',
      original_url: '',
      width: 0,
      height: 0,
      provider: AssetImage(path),
      local: true,
    );
  }

  /// An image at a plain URL (not stored on the server by uuid).
  factory ImageModel.network(String url) {
    return ImageModel(
      uuid: '',
      blur_hash: '',
      webp_url: url,
      original_url: url,
      width: 0,
      height: 0,
      provider: CachedNetworkImageProvider(url),
    );
  }

  static List<ImageModel> fromJsonList(List<dynamic> json) {
    return json.map((item) => ImageModel.fromJson(item)).toList();
  }

  Map<String, dynamic> toJson() {
    return {
      'uuid': uuid,
      'blur_hash': blur_hash,
      'width': width,
      'height': height,
    };
  }
}
`;

function generateModelFile(model) {
  if (model.builtin === 'image') return imageModelDart(pkgName());
  const cls = model.name;
  const fields = model.properties;
  const pkg = pkgName();

  const refs = new Set();
  fields.forEach(f => collectRefs(f.type, refs));
  refs.delete(cls);
  const imports = [...refs].sort().map(r => `import 'package:${pkg}/model/${snake(r)}.dart';`);

  const L = [];
  if (imports.length) L.push(imports.join('\n'), '');
  L.push(`class ${cls} {`);

  if (fields.length) {
    L.push(fields.map(f => `  ${dartType(f)} ${f.name};`).join('\n'), '');
    L.push(`  ${cls}({`);
    L.push(fields.map(f => f.required === false ? `    this.${f.name},` : `    required this.${f.name},`).join('\n'));
    L.push(`  });`, '');
  } else {
    L.push(`  ${cls}();`, '');
  }

  // copyWith
  L.push(`  ${cls} copyWith({`);
  if (fields.length) L.push(fields.map(f => `    ${typeToString(f.type)}? ${f.name},`).join('\n'));
  L.push(`  }) {`);
  L.push(`    return ${cls}(`);
  if (fields.length) L.push(fields.map(f => `      ${f.name}: ${f.name} ?? this.${f.name},`).join('\n'));
  L.push(`    );`, `  }`, '');

  // fromJson
  L.push(`  factory ${cls}.fromJson(Map<String, dynamic> json) {`);
  L.push(`    return ${cls}(`);
  if (fields.length) L.push(fields.map(f => `      ${f.name}: ${fromJsonField(f)},`).join('\n'));
  L.push(`    );`, `  }`, '');

  // toJson
  L.push(`  Map<String, dynamic> toJson() {`);
  L.push(`    return {`);
  if (fields.length) L.push(fields.map(f => `      '${f.name}': ${toJsonField(f)},`).join('\n'));
  L.push(`    };`, `  }`, '');

  // fromJsonList
  L.push(`  static List<${cls}> fromJsonList(List<dynamic> json) {`);
  L.push(`    return json.map((item) => ${cls}.fromJson(item)).toList();`);
  L.push(`  }`);

  L.push(`}`, '');
  return L.join('\n');
}

function generateEnumFile(en) {
  const vals = en.values.map(v => `  ${v.name},`).join('\n');
  return `enum ${en.name} {\n${vals}\n}\n`;
}

// ───────── Provider (Riverpod notifier) generation ─────────

// 'json' and 'none' both become a raw `dynamic` response; a model name becomes a
// typed deserialization. `list` wraps in a List.
const apiIsJson = (api) => !api.output.model || api.output.model === 'json';

function apiReturnType(api) {
  const list = api.output.type === 'list';
  if (apiIsJson(api)) return list ? 'List<dynamic>?' : 'dynamic';
  return list ? `List<${api.output.model}>?` : `${api.output.model}?`;
}
function apiReturnStmt(api) {
  const list = api.output.type === 'list';
  if (apiIsJson(api)) return list ? 'return response.data as List;' : 'return response.data;';
  return list
    ? `return ${api.output.model}.fromJsonList(response.data as List);`
    : `return ${api.output.model}.fromJson(response.data);`;
}
function provBuildType(p) {
  if (!p.output.model) return 'dynamic';
  return p.output.type === 'list' ? `List<${p.output.model}>?` : `${p.output.model}?`;
}

// Endpoint path (version + route), base URL is assumed configured in CustomHttp.
// The request path: just the route ("/workouts"). CustomHttp puts the API prefix
// and version ("/api/v1") in front itself.
function endpointPath(api) {
  return '/' + (api.route || '').trim().replace(/^\/+|\/+$/g, '');
}
// The endpoint's API version as CustomHttp's `version` number ("v2" → 2), or null
// for v1 (its default) / none.
function endpointVersion(api) {
  const m = /^v?(\d+)$/i.exec((api.version || '').trim());
  return m && Number(m[1]) !== 1 ? Number(m[1]) : null;
}

// One async method per endpoint, calling the app's CustomHttp (lib/utils.dart).
// Header / query values are strings unless written as a Dart literal; the body is
// the endpoint's JSON as a map literal.
function generateApiMethod(api) {
  const L = [];
  L.push(`  Future<${apiReturnType(api)}> ${api.name}() async {`);
  L.push(`    final response = await utils.CustomHttp.${api.method.toLowerCase()}(`);
  L.push(`      endpoint: '${endpointPath(api)}',`);
  const version = endpointVersion(api);
  if (version != null) L.push(`      version: ${version},`);

  const headers = api.headers.filter(h => h.key.trim());
  if (headers.length) {
    L.push(`      headers: {`);
    headers.forEach(h => L.push(`        '${dartStr(h.key.trim())}': ${dartValueLit(h.value)},`));
    L.push(`      },`);
  }
  const params = (api.params || []).filter(p => p.key.trim());
  if (params.length) {
    L.push(`      queries: {`);
    params.forEach(p => L.push(`        '${dartStr(p.key.trim())}': ${dartValueLit(p.value)},`));
    L.push(`      },`);
  }
  if (BODY_METHODS.includes(api.method) && api.body.trim()) {
    L.push(`      body: ${api.body.trim()},`);
  }

  L.push(`    );`);
  L.push('');
  L.push(`    if (!response.ok) {`);
  L.push("      printLine('Api endpoint error : ${response.status_code} : ${response.error}');");
  L.push(`      return null;`);
  L.push(`    }`);
  L.push('');
  L.push(`    ${apiReturnStmt(api)}`);
  L.push(`  }`);
  return L.join('\n');
}

// A header / query value as Dart: kept as written when it's already a Dart
// literal (a quoted string, number, true/false/null), otherwise a string.
const dartStr = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$');
function dartValueLit(v) {
  const s = String(v || '').trim();
  if (/^'(?:[^'\\]|\\.)*'$/.test(s) || /^"(?:[^"\\]|\\.)*"$/.test(s)) return s;
  if (/^-?\d+(\.\d+)?$/.test(s) || s === 'true' || s === 'false' || s === 'null') return s;
  return `'${dartStr(s)}'`;
}

export function generateProviderFile(p) {
  const pkg = pkgName();
  const cls = pascal(p.name) + 'Notifier';

  // Import every model used as an output (by the provider or any of its endpoints).
  const models = new Set();
  if (p.output.model && p.output.model !== 'json') models.add(p.output.model);
  p.apis.forEach(a => { if (a.output.model && a.output.model !== 'json') models.add(a.output.model); });
  const modelImports = [...models].sort().map(m => `import 'package:${pkg}/model/${snake(m)}.dart';`);

  const L = [];
  L.push(`import 'package:${pkg}/utils/print_helper.dart';`);
  L.push(`import 'package:${pkg}/utils.dart' as utils;`);
  L.push(`import 'package:riverpod_annotation/riverpod_annotation.dart';`);
  modelImports.forEach(i => L.push(i));
  L.push('');
  L.push(`part '${snake(p.name)}.g.dart';`);
  L.push('');
  L.push(`@Riverpod(keepAlive: true)`);
  L.push(`class ${cls} extends _$${cls} {`);
  L.push(`  @override`);
  L.push(`  FutureOr<${provBuildType(p)}> build() async {`);
  // The state starts as what the provider's load endpoint returns.
  const load = p.load && p.apis.find(a => a.id === p.load
    && a.output.model === p.output.model && a.output.type === p.output.type);
  L.push(load ? `    return ${load.name}();` : `    return null;`);
  L.push(`  }`);
  p.apis.forEach(a => { L.push(''); L.push(generateApiMethod(a)); });
  L.push(`}`);
  L.push('');
  return L.join('\n');
}

// ───────── Route (GoRouter) generation ─────────

// A screen's route path: the frame's explicit routePath, else a slug of its name.
// Mirrors props.js `routeOf` so the export matches what the Screen panel shows.
// Also shown in Play's address bar for a web screen.
export function routeOf(frame) {
  const p = (frame.routePath || '').trim();
  if (p) return p;
  const s = (frame.name || 'screen').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return '/' + (s || 'screen');
}

// Same dashed-case rule as the Screen panel, but permits ":param" segments so
// parametrised routes (e.g. /profile/:userId) are considered valid to export.
function routeExportable(r) {
  const v = (r || '').trim();
  if (!v || v === '/') return true;
  return /^\/?[a-z0-9:]+(?:-[a-z0-9]+)*(?:\/[a-z0-9:]+(?:-[a-z0-9]+)*)*$/.test(v)
    && !/\s/.test(v) && !/[A-Z]/.test(v);
}

// Map each root frame to the identifiers its generated code uses: a route
// constant, a screen class, the view file name, and any ":param" path segments.
// Names are de-duplicated so route and view generation always agree on them.
function screenItems(screens) {
  const usedConst = new Set();
  const usedClass = new Set();
  return screens.map(fr => {
    let cname = camelWords(fr.name);
    while (usedConst.has(cname)) cname += '_';
    usedConst.add(cname);
    let cls = pascalWords(fr.name) + 'Screen';
    while (usedClass.has(cls)) cls += 'X';
    usedClass.add(cls);
    const path = routeOf(fr);
    const params = (path.match(/:([a-zA-Z0-9_]+)/g) || []).map(s => s.slice(1));
    // A frame inside a Section lands in a folder named after the section, so the
    // view path (and its import in route.dart) becomes lib/view/<section>/<frame>.dart.
    const parent = fr.parentId ? getNode(fr.parentId) : null;
    const folder = parent && parent.type === 'section' ? snake(parent.name) + '/' : '';
    return { fr, cname, cls, path, params, file: folder + snake(fr.name) };
  });
}

// A StatefulWidget per screen at lib/view/<file>.dart. Path params become required
// String fields so the route builder (e.g. ProfileScreen(userId: userId)) compiles;
// the build() body is the frame's design translated to a Flutter widget tree.
function generateViewFile(it) {
  const cls = it.cls;
  const pkg = pkgName();
  const { code, ctx } = generateScreenBody(it.fr, { routeName: (id) => (routeNames.get(id) || null) });

  const L = [];
  L.push(`import 'package:flutter/material.dart';`);
  if (ctx.ui) L.push(`import 'dart:ui' show ImageFilter;`);
  if (ctx.svg) L.push(`import 'package:flutter_svg/flutter_svg.dart';`);
  if (ctx.screenutil) L.push(`import 'package:flutter_screenutil/flutter_screenutil.dart';`);
  if (ctx.colors) L.push(`import 'package:${pkg}/constants/colors.dart';`);
  if (ctx.typo) L.push(`import 'package:${pkg}/constants/typography.dart';`);
  [...ctx.mocks].sort().forEach(m => L.push(`import 'package:${pkg}/mock/${snake(m)}.dart';`));
  [...ctx.enums].sort().forEach(e => L.push(`import 'package:${pkg}/model/${snake(e)}.dart';`));
  if (ctx.routes) L.push(`import 'package:${pkg}/route.dart';`);
  if (ctx.innerShadow) L.push(`import 'package:${pkg}/widget/inner_shadow.dart';`);
  if (ctx.appImage) L.push(`import 'package:${pkg}/widget/app_image.dart';`);
  if (ctx.carousel) L.push(`import 'package:${pkg}/widget/app_carousel.dart';`);
  if (ctx.accordion) L.push(`import 'package:${pkg}/widget/app_accordion.dart';`);
  if (ctx.lottie) L.push(`import 'package:${pkg}/widget/app_lottie.dart';`);
  overlayImports(ctx, pkg).forEach(i => L.push(i));
  if (ctx.imageModel && !L.includes(`import 'package:${pkg}/model/image_model.dart';`)) L.push(`import 'package:${pkg}/model/image_model.dart';`);
  componentImports(ctx).forEach(i => L.push(i));
  // Providers the screen reads: a Riverpod consumer that watches each one.
  const watched = [...ctx.providers].map(name => state.providers.find(p => p.name === name)).filter(Boolean);
  if (watched.length) {
    L.push(`import 'package:flutter_riverpod/flutter_riverpod.dart';`);
    watched.forEach(p => L.push(`import 'package:${pkg}/provider/${snake(p.name)}.dart';`));
  }
  it.mocks = ctx.mocks;
  L.push('');
  const consumer = watched.length > 0;
  L.push(`class ${cls} extends ${consumer ? 'ConsumerStatefulWidget' : 'StatefulWidget'} {`);
  if (it.params.length) {
    it.params.forEach(p => L.push(`  final String ${p};`));
    L.push('');
    L.push(`  const ${cls}({super.key, ${it.params.map(p => `required this.${p}`).join(', ')}});`);
  } else {
    L.push(`  const ${cls}({super.key});`);
  }
  L.push('');
  L.push(`  @override`);
  L.push(`  ${consumer ? 'ConsumerState' : 'State'}<${cls}> createState() => _${cls}State();`);
  L.push(`}`);
  L.push('');
  L.push(`class _${cls}State extends ${consumer ? 'ConsumerState' : 'State'}<${cls}> {`);
  L.push(`  @override`);
  L.push(`  void initState() {`);
  L.push(`    super.initState();`);
  L.push(`  }`);
  L.push('');
  L.push(`  @override`);
  L.push(`  void dispose() {`);
  L.push(`    super.dispose();`);
  L.push(`  }`);
  L.push('');
  L.push(`  @override`);
  L.push(`  Widget build(BuildContext context) {`);
  // Each provider's current data (null while loading or on error; the design's
  // reads are null-safe, so the screen renders its empty state meanwhile).
  watched.forEach(p => {
    const cls = pascal(p.name) + 'Notifier';
    L.push(`    final ${p.name} = ref.watch(${cls[0].toLowerCase() + cls.slice(1)}Provider).valueOrNull;`);
  });
  L.push(`    return ${code};`);
  L.push(`  }`);
  L.push(`}`);
  L.push('');
  if (ctx.hexColor) {
    // Colors bound to data arrive as hex text (e.g. '#1ECC7A').
    L.push(`Color _hexColor(String? hex) {`);
    L.push(`  final h = (hex ?? '').replaceFirst('#', '');`);
    L.push(`  final v = int.tryParse(h.length == 6 ? 'FF$h' : h, radix: 16);`);
    L.push(`  return v == null ? Colors.transparent : Color(v);`);
    L.push(`}`);
    L.push('');
  }
  // Return the .dart content plus any asset files the screen references, so the
  // exporter can bundle icon SVGs (assets/icons/) and image bytes (assets/images/).
  return { content: L.join('\n'), icons: ctx.icons, images: ctx.images, mocks: ctx.mocks, components: ctx.components, innerShadow: ctx.innerShadow, appImage: ctx.appImage, carousel: ctx.carousel, accordion: ctx.accordion, lottie: ctx.lottie, overlays: ctx.overlays };
}

// ───────── Inner shadow (lib/widget/inner_shadow.dart) ─────────
// Flutter's BoxShadow only draws outside a box, so inset shadows are painted by
// this small widget, over the box and clipped to its shape. Exported only when used.
const INNER_SHADOW_DART = `import 'package:flutter/material.dart';

/// Shadows drawn inside a box's edges (a BoxShadow only draws outside them).
class InnerShadow extends StatelessWidget {
  const InnerShadow({
    super.key,
    required this.shadows,
    this.borderRadius = BorderRadius.zero,
    this.circle = false,
    required this.child,
  });

  final List<BoxShadow> shadows;
  final BorderRadiusGeometry borderRadius;
  final bool circle;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      foregroundPainter: _InnerShadowPainter(shadows, borderRadius.resolve(Directionality.maybeOf(context)), circle),
      child: child,
    );
  }
}

class _InnerShadowPainter extends CustomPainter {
  _InnerShadowPainter(this.shadows, this.borderRadius, this.circle);

  final List<BoxShadow> shadows;
  final BorderRadius borderRadius;
  final bool circle;

  Path _shape(Rect rect, double inset) => circle
      ? (Path()..addOval(rect.deflate(inset)))
      : (Path()..addRRect(borderRadius.toRRect(rect).deflate(inset)));

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    canvas.save();
    canvas.clipPath(_shape(rect, 0));
    for (final s in shadows) {
      // Everything outside the (offset, spread-shrunk) shape, blurred, shows
      // through at the edges.
      final ring = Path()
        ..fillType = PathFillType.evenOdd
        ..addRect(rect.inflate(s.blurRadius * 2 + s.spreadRadius.abs() + s.offset.distance))
        ..addPath(_shape(rect, s.spreadRadius), s.offset);
      final paint = Paint()..color = s.color;
      if (s.blurRadius > 0) paint.maskFilter = MaskFilter.blur(BlurStyle.normal, s.blurSigma);
      canvas.drawPath(ring, paint);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_InnerShadowPainter old) =>
      old.circle != circle ||
      old.borderRadius != borderRadius ||
      old.shadows.length != shadows.length ||
      Iterable.generate(shadows.length).any((i) => old.shadows[i] != shadows[i]);
}
`;

// ───────── Carousel (lib/widget/app_carousel.dart) ─────────
// The slides of a Carousel container (widgets.js) in a PageView, with arrows,
// dots and autoplay. Autoplay stops while a finger is on it and when the
// system asks for reduced motion.
const APP_CAROUSEL_DART = `import 'dart:async';

import 'package:flutter/material.dart';

/// Slides the user swipes through, one at a time, with optional arrows, dots
/// and autoplay. Generated by Scaffold.
class AppCarousel extends StatefulWidget {
  const AppCarousel({
    super.key,
    required this.children,
    required this.height,
    this.initialPage = 0,
    this.showArrows = true,
    this.showDots = true,
    this.loop = true,
    this.autoplay,
    this.dotColor,
    this.activeDotColor,
    this.spacing = 12,
  });

  final List<Widget> children;
  final double height;
  final int initialPage;
  final bool showArrows;
  final bool showDots;
  final bool loop;
  final Duration? autoplay;
  final Color? dotColor;
  final Color? activeDotColor;
  final double spacing;

  @override
  State<AppCarousel> createState() => _AppCarouselState();
}

class _AppCarouselState extends State<AppCarousel> {
  late final PageController _controller = PageController(initialPage: widget.initialPage);
  late int _page = widget.initialPage;
  Timer? _timer;
  bool _held = false;

  int get _count => widget.children.length;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _restart();
  }

  void _restart() {
    _timer?.cancel();
    final every = widget.autoplay;
    if (every == null || _count < 2 || MediaQuery.of(context).disableAnimations) return;
    _timer = Timer.periodic(every, (_) {
      if (!_held) _go(_page + 1);
    });
  }

  void _go(int page) {
    if (_count == 0) return;
    var target = page;
    if (target >= _count) target = widget.loop ? 0 : _count - 1;
    if (target < 0) target = widget.loop ? _count - 1 : 0;
    if (target == _page) return;
    _controller.animateToPage(target, duration: const Duration(milliseconds: 350), curve: Curves.easeInOut);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final active = widget.activeDotColor ?? scheme.onSurface;
    final idle = widget.dotColor ?? scheme.onSurface.withValues(alpha: 0.3);
    final canGoBack = widget.loop || _page > 0;
    final canGoOn = widget.loop || _page < _count - 1;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          height: widget.height,
          child: Listener(
            onPointerDown: (_) => _held = true,
            onPointerUp: (_) => _held = false,
            onPointerCancel: (_) => _held = false,
            child: Stack(
              children: [
                PageView(
                  controller: _controller,
                  onPageChanged: (page) {
                    setState(() => _page = page);
                    _restart();
                  },
                  children: widget.children,
                ),
                if (widget.showArrows && _count > 1) ...[
                  Align(
                    alignment: Alignment.centerLeft,
                    child: _Arrow(icon: Icons.chevron_left, label: 'Previous slide', onTap: canGoBack ? () => _go(_page - 1) : null),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: _Arrow(icon: Icons.chevron_right, label: 'Next slide', onTap: canGoOn ? () => _go(_page + 1) : null),
                  ),
                ],
              ],
            ),
          ),
        ),
        if (widget.showDots && _count > 1) ...[
          SizedBox(height: widget.spacing),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < _count; i++)
                Semantics(
                  button: true,
                  selected: i == _page,
                  label: 'Slide \${i + 1} of \$_count',
                  child: GestureDetector(
                    onTap: () => _go(i),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 200),
                      margin: const EdgeInsets.symmetric(horizontal: 3),
                      width: i == _page ? 20 : 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: i == _page ? active : idle,
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ],
    );
  }
}

class _Arrow extends StatelessWidget {
  const _Arrow({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(8),
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 150),
        opacity: onTap == null ? 0 : 1,
        child: Material(
          color: Colors.white.withValues(alpha: 0.92),
          shape: const CircleBorder(),
          elevation: 1,
          child: IconButton(
            tooltip: label,
            icon: Icon(icon, color: Colors.black87),
            iconSize: 20,
            constraints: const BoxConstraints.tightFor(width: 36, height: 36),
            padding: EdgeInsets.zero,
            onPressed: onTap,
          ),
        ),
      ),
    );
  }
}
`;

// ───────── Accordion (lib/widget/app_accordion.dart) ─────────
// The sections of an Accordion container (widgets.js): a heading row each,
// with its section below while open. Flutter's ExpansionTile can't keep one
// open at a time on its own and brings ListTile padding, so it's its own widget.
const APP_ACCORDION_DART = `import 'package:flutter/material.dart';

/// One section of an [AppAccordion]: its heading and what it opens to.
class AppAccordionItem {
  const AppAccordionItem({required this.title, required this.child});

  final String title;
  final Widget child;
}

/// Headings that open and close the section below them. With [single], opening
/// one closes the others. Generated by Scaffold.
class AppAccordion extends StatefulWidget {
  const AppAccordion({
    super.key,
    required this.items,
    this.initiallyOpen = const {0},
    this.single = true,
    this.titleStyle,
    this.iconColor,
    this.dividerColor,
  });

  final List<AppAccordionItem> items;
  final Set<int> initiallyOpen;
  final bool single;
  final TextStyle? titleStyle;
  final Color? iconColor;
  final Color? dividerColor;

  @override
  State<AppAccordion> createState() => _AppAccordionState();
}

class _AppAccordionState extends State<AppAccordion> {
  late final Set<int> _open = {...widget.initiallyOpen};

  void _toggle(int index) {
    setState(() {
      if (_open.contains(index)) {
        _open.remove(index);
      } else {
        if (widget.single) _open.clear();
        _open.add(index);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final divider = widget.dividerColor ?? theme.dividerColor;
    final style = widget.titleStyle ?? theme.textTheme.titleMedium;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < widget.items.length; i++) ...[
          Semantics(
            button: true,
            expanded: _open.contains(i),
            child: InkWell(
              onTap: () => _toggle(i),
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 14),
                decoration: BoxDecoration(border: Border(bottom: BorderSide(color: divider))),
                child: Row(
                  children: [
                    Expanded(child: Text(widget.items[i].title, style: style)),
                    AnimatedRotation(
                      turns: _open.contains(i) ? 0.5 : 0,
                      duration: const Duration(milliseconds: 200),
                      child: Icon(Icons.expand_more, color: widget.iconColor ?? style?.color),
                    ),
                  ],
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeInOut,
            alignment: Alignment.topCenter,
            child: _open.contains(i) ? widget.items[i].child : const SizedBox(width: double.infinity),
          ),
        ],
      ],
    );
  }
}
`;

// ───────── Overlays (lib/widget/app_overlay.dart + lib/widget/overlay/*) ─────────
// Dialogs, bottom sheets and dropdown menus (overlay frames — nodes.js). Each
// overlay's design is a widget of its own; these open it. A "close" action
// inside it pops it.
const APP_OVERLAY_DART = `import 'package:flutter/material.dart';

/// Opens [child] centred over the screen, which dims behind it.
/// Generated by Scaffold.
Future<T?> showAppDialog<T>(BuildContext context, Widget child, {bool dismissible = true}) {
  return showDialog<T>(
    context: context,
    barrierDismissible: dismissible,
    builder: (_) => Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.all(24),
      child: child,
    ),
  );
}

/// Slides [child] up from the bottom of the screen.
Future<T?> showAppSheet<T>(BuildContext context, Widget child, {bool dismissible = true}) {
  return showModalBottomSheet<T>(
    context: context,
    isDismissible: dismissible,
    enableDrag: dismissible,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => SafeArea(top: false, child: child),
  );
}

/// Opens [child] as a menu under the widget [context] belongs to (above it
/// when there's no room below).
Future<T?> showAppMenu<T>(BuildContext context, Widget child, {bool dismissible = true}) {
  final navigator = Navigator.of(context);
  final box = context.findRenderObject() as RenderBox;
  final overlay = navigator.overlay!.context.findRenderObject() as RenderBox;
  final anchor = box.localToGlobal(Offset.zero, ancestor: overlay) & box.size;
  return navigator.push<T>(_MenuRoute<T>(anchor: anchor, dismissible: dismissible, child: child));
}

class _MenuRoute<T> extends PopupRoute<T> {
  _MenuRoute({required this.anchor, required this.dismissible, required this.child});

  final Rect anchor;
  final bool dismissible;
  final Widget child;

  @override
  Color? get barrierColor => null;

  @override
  bool get barrierDismissible => dismissible;

  @override
  String? get barrierLabel => 'Close menu';

  @override
  Duration get transitionDuration => const Duration(milliseconds: 150);

  @override
  Widget buildPage(BuildContext context, Animation<double> animation, Animation<double> secondaryAnimation) {
    return FadeTransition(
      opacity: animation,
      child: CustomSingleChildLayout(delegate: _MenuLayout(anchor), child: child),
    );
  }
}

class _MenuLayout extends SingleChildLayoutDelegate {
  _MenuLayout(this.anchor);

  final Rect anchor;
  static const double _gap = 4;
  static const double _margin = 8;

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) => constraints.loosen();

  @override
  Offset getPositionForChild(Size size, Size childSize) {
    final maxX = size.width - childSize.width - _margin;
    final x = maxX < _margin ? _margin : anchor.left.clamp(_margin, maxX);
    var y = anchor.bottom + _gap;
    if (y + childSize.height > size.height - _margin) y = anchor.top - childSize.height - _gap;
    return Offset(x, y < _margin ? _margin : y);
  }

  @override
  bool shouldRelayout(_MenuLayout old) => old.anchor != anchor;
}
`;

// ───────── Animations (lib/widget/app_lottie.dart) ─────────
// A Lottie animation (lottie.js) from assets/lottie/, with the design's speed,
// loop, autoplay and still frame. Needs the `lottie` package, and assets/lottie/
// listed under flutter: assets: in pubspec.yaml.
const APP_LOTTIE_DART = `import 'package:flutter/material.dart';
import 'package:lottie/lottie.dart';

/// Plays a Lottie animation from the app's assets. Shows its [still] frame
/// (0–1) when it doesn't play on its own, and when the system asks for reduced
/// motion. Generated by Scaffold.
class AppLottie extends StatefulWidget {
  const AppLottie(
    this.asset, {
    super.key,
    this.width,
    this.height,
    this.fit = BoxFit.contain,
    this.repeat = true,
    this.autoplay = true,
    this.speed = 1,
    this.still = 0,
    this.semanticLabel,
  });

  final String asset;
  final double? width;
  final double? height;
  final BoxFit fit;
  final bool repeat;
  final bool autoplay;
  final double speed;
  final double still;
  final String? semanticLabel;

  @override
  State<AppLottie> createState() => _AppLottieState();
}

class _AppLottieState extends State<AppLottie> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(vsync: this);

  void _start(LottieComposition composition) {
    final speed = widget.speed > 0 ? widget.speed : 1;
    _controller.duration = composition.duration * (1 / speed);
    if (!widget.autoplay || MediaQuery.of(context).disableAnimations) {
      _controller.value = widget.still.clamp(0, 1).toDouble();
    } else if (widget.repeat) {
      _controller.repeat();
    } else {
      _controller.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final animation = Lottie.asset(
      widget.asset,
      controller: _controller,
      width: widget.width,
      height: widget.height,
      fit: widget.fit,
      onLoaded: _start,
    );
    final label = widget.semanticLabel;
    return label == null ? ExcludeSemantics(child: animation) : Semantics(image: true, label: label, child: animation);
  }
}
`;

// ───────── Images (lib/widget/app_image.dart + its placeholder and error) ─────────
// Every image in the app is an AppImage of an ImageModel (as HaspImage in the
// hasp app): a local image (the design's assets) from its provider, a network
// one cached, fading in from its blurhash, with a "Couldn't load image" state
// if it fails. Exported only when a screen or component shows an image.
const appImageDart = (pkg) => `import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:${pkg}/model/image_model.dart';
import 'package:${pkg}/widget/image_error_widget.dart';
import 'package:${pkg}/widget/image_placeholder.dart';

/// App-wide way to render an [ImageModel]. Shows the image's blurhash while the
/// network image loads (via [ImagePlaceholder]) and on failure (via
/// [ImageErrorWidget]), so photos fade in from their blur instead of popping in
/// from a blank box. Prefer this over a raw \`Image(image: model.provider)\`.
class AppImage extends StatelessWidget {
  final ImageModel image;
  final BoxFit fit;
  final double? width;
  final double? height;
  final BorderRadius? borderRadius;

  /// Optional override for the failure state. Defaults to [ImageErrorWidget]
  /// (a blurhash with a "Couldn't load image" label). Pass a compact widget for
  /// small avatars where the label would not fit.
  final Widget? errorWidget;

  /// What the image shows, read out by screen readers (TalkBack / VoiceOver).
  final String? semanticLabel;

  /// A decorative image: screen readers skip it.
  final bool excludeFromSemantics;

  const AppImage({
    super.key,
    required this.image,
    this.fit = BoxFit.cover,
    this.width,
    this.height,
    this.borderRadius,
    this.errorWidget,
    this.semanticLabel,
    this.excludeFromSemantics = false,
  });

  Widget _placeholder() => ImagePlaceholder(blurHash: image.blur_hash, width: width, height: height);

  Widget _error() => SizedBox(
        width: width,
        height: height,
        child: errorWidget ?? ImageErrorWidget(blurHash: image.blur_hash),
      );

  @override
  Widget build(BuildContext context) {
    final Widget picture;
    if (image.local) {
      // Images shipped with the app, and locally-picked ones (not yet
      // uploaded), have no network URL — render straight from the provider.
      picture = Image(
        image: image.provider,
        fit: fit,
        width: width,
        height: height,
        errorBuilder: (context, error, stack) => _error(),
      );
    } else if (image.webp_url.isEmpty) {
      picture = _placeholder();
    } else {
      picture = CachedNetworkImage(
        imageUrl: image.webp_url,
        fit: fit,
        width: width,
        height: height,
        placeholder: (context, url) => _placeholder(),
        errorWidget: (context, url, error) => _error(),
      );
    }
    final Widget shaped = borderRadius == null ? picture : ClipRRect(borderRadius: borderRadius!, child: picture);
    // One label for the whole image (its placeholder and error states included).
    if (excludeFromSemantics) return ExcludeSemantics(child: shaped);
    final label = semanticLabel;
    if (label == null || label.isEmpty) return shaped;
    return Semantics(label: label, image: true, child: ExcludeSemantics(child: shaped));
  }
}
`;

const IMAGE_PLACEHOLDER_DART = `import 'package:flutter/material.dart';
import 'package:flutter_blurhash/flutter_blurhash.dart';

/// What an image shows while it loads: its blurhash when it has one, else a flat
/// colour from the theme.
class ImagePlaceholder extends StatelessWidget {
  final String? blurHash;
  final double? width;
  final double? height;

  const ImagePlaceholder({
    super.key,
    this.blurHash,
    this.width,
    this.height,
  });

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;
    final hash = blurHash;
    return SizedBox(
      width: width ?? double.infinity,
      height: height ?? double.infinity,
      // BlurHash can't decode an empty hash — a flat colour stands in.
      child: hash == null || hash.isEmpty
          ? ColoredBox(color: color)
          : BlurHash(
              hash: hash,
              color: color,
              optimizationMode: BlurHashOptimizationMode.approximation,
            ),
    );
  }
}
`;

const imageErrorWidgetDart = (pkg) => `import 'package:flutter/material.dart';
import 'package:flutter_screenutil/flutter_screenutil.dart';
import 'package:${pkg}/widget/image_placeholder.dart';

/// What an image shows when it can't load: its placeholder with a
/// "Couldn't load image" label over it.
class ImageErrorWidget extends StatelessWidget {
  final String? blurHash;

  const ImageErrorWidget({super.key, this.blurHash});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: double.infinity,
      child: Stack(
        children: [
          ImagePlaceholder(blurHash: blurHash),
          Center(
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 18),
              decoration: BoxDecoration(
                color: const Color.fromRGBO(24, 24, 24, 0.6),
                border: Border.all(color: Colors.white.withValues(alpha: .1)),
                borderRadius: BorderRadius.circular(24),
                boxShadow: const [
                  BoxShadow(
                    color: Color.fromRGBO(24, 24, 24, .2),
                    blurRadius: 8,
                    offset: Offset(0, 2),
                  ),
                ],
              ),
              child: Text(
                'Couldn\\'t load image',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 12.sp,
                  fontWeight: FontWeight.w400,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
`;

// ───────── Components (lib/widget/<name>.dart) ─────────
const componentFile = (c) => snake(componentClass(c));
function componentImports(ctx) {
  const pkg = pkgName();
  return [...ctx.components].map(id => state.components.find(c => c.id === id)).filter(Boolean)
    .map(c => `import 'package:${pkg}/widget/${componentFile(c)}.dart';`).sort();
}

// A component as a StatelessWidget: its master's design, built once and used by
// every screen (and component) that places it.
// The imports for the overlays a file opens: the openers, and each overlay's widget.
function overlayImports(ctx, pkg) {
  if (!ctx.overlays || !ctx.overlays.size) return [];
  const out = [`import 'package:${pkg}/widget/app_overlay.dart';`];
  ctx.overlays.forEach(id => { const fr = getNode(id); if (fr) out.push(`import 'package:${pkg}/widget/overlay/${overlayFile(fr)}.dart';`); });
  return out;
}

// lib/widget/overlay/<name>.dart — an overlay frame's design as a widget.
function generateOverlayFile(fr) {
  const pkg = pkgName();
  const cls = overlayClass(fr);
  const { code, ctx } = generateOverlayBody(fr, { routeName: (id) => (routeNames.get(id) || null) });
  ctx.overlays.delete(fr.id);
  const L = [`import 'package:flutter/material.dart';`];
  if (ctx.ui) L.push(`import 'dart:ui' show ImageFilter;`);
  if (ctx.svg) L.push(`import 'package:flutter_svg/flutter_svg.dart';`);
  if (ctx.screenutil) L.push(`import 'package:flutter_screenutil/flutter_screenutil.dart';`);
  if (ctx.colors) L.push(`import 'package:${pkg}/constants/colors.dart';`);
  if (ctx.typo) L.push(`import 'package:${pkg}/constants/typography.dart';`);
  if (ctx.routes) L.push(`import 'package:${pkg}/route.dart';`);
  if (ctx.innerShadow) L.push(`import 'package:${pkg}/widget/inner_shadow.dart';`);
  if (ctx.appImage) L.push(`import 'package:${pkg}/widget/app_image.dart';`);
  if (ctx.carousel) L.push(`import 'package:${pkg}/widget/app_carousel.dart';`);
  if (ctx.accordion) L.push(`import 'package:${pkg}/widget/app_accordion.dart';`);
  if (ctx.lottie) L.push(`import 'package:${pkg}/widget/app_lottie.dart';`);
  overlayImports(ctx, pkg).forEach(i => L.push(i));
  if (ctx.imageModel) L.push(`import 'package:${pkg}/model/image_model.dart';`);
  componentImports(ctx).forEach(i => L.push(i));
  L.push('', `/// The "${fr.name}" ${fr.overlay.kind === 'menu' ? 'menu' : fr.overlay.kind === 'sheet' ? 'bottom sheet' : 'dialog'}, opened with ${{ dialog: 'showAppDialog', sheet: 'showAppSheet', menu: 'showAppMenu' }[fr.overlay.kind]}.`,
    `class ${cls} extends StatelessWidget {`, `  const ${cls}({super.key});`, '');
  L.push(`  @override`, `  Widget build(BuildContext context) {`, `    return ${code};`, `  }`, `}`, '');
  return { content: L.join('\n'), icons: ctx.icons, images: ctx.images, components: ctx.components, innerShadow: ctx.innerShadow,
    appImage: ctx.appImage, carousel: ctx.carousel, accordion: ctx.accordion, lottie: ctx.lottie, overlays: ctx.overlays };
}

function generateComponentFile(c) {
  const pkg = pkgName();
  const cls = componentClass(c);
  const { code, ctx } = generateComponentBody(c.id, { routeName: (id) => (routeNames.get(id) || null) });
  const L = [`import 'package:flutter/material.dart';`];
  if (ctx.ui) L.push(`import 'dart:ui' show ImageFilter;`);
  if (ctx.svg) L.push(`import 'package:flutter_svg/flutter_svg.dart';`);
  if (ctx.screenutil) L.push(`import 'package:flutter_screenutil/flutter_screenutil.dart';`);
  if (ctx.colors) L.push(`import 'package:${pkg}/constants/colors.dart';`);
  if (ctx.typo) L.push(`import 'package:${pkg}/constants/typography.dart';`);
  if (ctx.routes) L.push(`import 'package:${pkg}/route.dart';`);
  if (ctx.innerShadow) L.push(`import 'package:${pkg}/widget/inner_shadow.dart';`);
  if (ctx.appImage) L.push(`import 'package:${pkg}/widget/app_image.dart';`);
  if (ctx.carousel) L.push(`import 'package:${pkg}/widget/app_carousel.dart';`);
  if (ctx.accordion) L.push(`import 'package:${pkg}/widget/app_accordion.dart';`);
  if (ctx.lottie) L.push(`import 'package:${pkg}/widget/app_lottie.dart';`);
  overlayImports(ctx, pkg).forEach(i => L.push(i));
  if (ctx.imageModel && !L.includes(`import 'package:${pkg}/model/image_model.dart';`)) L.push(`import 'package:${pkg}/model/image_model.dart';`);
  ctx.components.delete(c.id);
  componentImports(ctx).forEach(i => L.push(i));
  L.push('', `class ${cls} extends StatelessWidget {`, `  const ${cls}({super.key});`, '');
  L.push(`  @override`, `  Widget build(BuildContext context) {`, `    return ${code};`, `  }`, `}`, '');
  return { content: L.join('\n'), icons: ctx.icons, images: ctx.images, components: ctx.components, innerShadow: ctx.innerShadow, appImage: ctx.appImage, carousel: ctx.carousel, accordion: ctx.accordion, lottie: ctx.lottie, overlays: ctx.overlays };
}

// Build lib/route.dart: one GoRoute per screen, unique constant + class names,
// path params wired into the builder. `items` come from screenItems().
function generateRouteFile(items) {
  const pkg = pkgName();
  const initial = items.find(it => it.fr.isInitial) || items[0];

  const L = [];
  items.forEach(it => L.push(`import 'package:${pkg}/view/${it.file}.dart';`));
  L.push(`import 'package:go_router/go_router.dart';`);
  L.push('');
  L.push('class AppRoutes {');
  L.push('  AppRoutes._();');
  L.push('');
  items.forEach(it => L.push(`  static final String ${it.cname} = '${it.path}';`));
  L.push('');
  L.push('  static void push(String route) => allRoutes.push(route);');
  L.push('');
  L.push('  static void go(String route) => allRoutes.go(route);');
  L.push('');
  L.push('  static void pop() {');
  L.push('    if (allRoutes.canPop()) {');
  L.push('      allRoutes.pop();');
  L.push('    } else {');
  L.push(`      allRoutes.go(${initial ? initial.cname : "'/'"});`);
  L.push('    }');
  L.push('  }');
  L.push('');
  L.push('  static final allRoutes = GoRouter(');
  if (initial) L.push(`    initialLocation: ${initial.cname},`);
  L.push('    routes: [');
  items.forEach(it => {
    L.push('      GoRoute(');
    L.push(`        path: ${it.cname},`);
    if (it.params.length) {
      L.push('        builder: (context, state) {');
      it.params.forEach(p => L.push(`          final ${p} = state.pathParameters['${p}']!;`));
      const args = it.params.map(p => `${p}: ${p}`).join(', ');
      L.push(`          return ${it.cls}(${args});`);
      L.push('        },');
    } else {
      L.push(`        builder: (context, state) => const ${it.cls}(),`);
    }
    L.push('      ),');
  });
  L.push('    ],');
  L.push('  );');
  L.push('}');
  L.push('');
  return L.join('\n');
}

// ───────── Theme (colors.dart + themes.dart) generation ─────────

// The Material ColorScheme roles the user can map colors onto. Order = display
// order in the role-mapping UI. Each is a valid ColorScheme.dark/.light param.
export const SCHEME_ROLES = [
  { id: 'primary', label: 'Primary' },
  { id: 'onPrimary', label: 'On Primary' },
  { id: 'secondary', label: 'Secondary' },
  { id: 'onSecondary', label: 'On Secondary' },
  { id: 'surface', label: 'Surface' },
  { id: 'onSurface', label: 'On Surface' },
  { id: 'surfaceContainer', label: 'Surface Container' },
  { id: 'surfaceContainerHigh', label: 'Surface Container High' },
  { id: 'error', label: 'Error' },
  { id: 'onError', label: 'On Error' },
  { id: 'outline', label: 'Outline' },
  { id: 'outlineVariant', label: 'Outline Variant' },
];

// "#rrggbb" + alpha(0..1) → "AARRGGBB" for a Dart Color(0x…) literal.
function hexToArgb(hex, alpha) {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(x => x + x).join('');
  h = h.slice(0, 6).padEnd(6, '0');
  const a = Math.round((alpha == null ? 1 : alpha) * 255);
  return (a.toString(16).padStart(2, '0') + h).toUpperCase();
}
// A per-theme color value → a Dart Color(0x…). Gradients collapse to their first
// stop (ThemeExtension / ColorScheme fields are single colors, not gradients).
function dartColorValue(v) {
  if (!v) return 'Color(0x00000000)';
  if (v.fillType === 'linear' || v.fillType === 'radial') {
    const s = (v.gradient && v.gradient.stops && v.gradient.stops[0]) || { color: '#000000', alpha: 1 };
    return `Color(0x${hexToArgb(s.color, s.alpha)})`;
  }
  return `Color(0x${hexToArgb(v.fill, v.alpha)})`;
}
const colorVal = (c, themeId) => (c.values && c.values[themeId]) || null;

// lib/constants/colors.dart — a VColors static-const set (from the first theme,
// for direct references) plus a VColorsTheme ThemeExtension carrying one Color
// field per color, with a static const per theme, copyWith and lerp.
function generateColorsFile(colors, themes) {
  const first = themes[0];
  const L = [];
  L.push(`import 'package:flutter/material.dart';`);
  L.push('');
  L.push(`// Static constants from the "${first.name}" theme, for direct references.`);
  L.push(`abstract class VColors {`);
  colors.forEach(c => L.push(`  static const Color ${c.name} = ${dartColorValue(colorVal(c, first.id))};`));
  if (colors.length) L.push('');
  L.push(`  // Context-aware access — use in widgets for proper light/dark support.`);
  L.push(`  static VColorsTheme of(BuildContext context) => VColorsTheme.of(context);`);
  L.push(`}`);
  L.push('');
  L.push(`// ThemeExtension — register in ThemeData to enable runtime theming.`);
  L.push(`class VColorsTheme extends ThemeExtension<VColorsTheme> {`);
  colors.forEach(c => L.push(`  final Color ${c.name};`));
  L.push('');
  L.push(`  const VColorsTheme({`);
  colors.forEach(c => L.push(`    required this.${c.name},`));
  L.push(`  });`);
  L.push('');
  themes.forEach(t => {
    L.push(`  static const ${t.name} = VColorsTheme(`);
    colors.forEach(c => L.push(`    ${c.name}: ${dartColorValue(colorVal(c, t.id))},`));
    L.push(`  );`);
    L.push('');
  });
  L.push(`  static VColorsTheme of(BuildContext context) =>`);
  L.push(`      Theme.of(context).extension<VColorsTheme>() ?? ${first.name};`);
  L.push('');
  L.push(`  @override`);
  L.push(`  VColorsTheme copyWith({`);
  colors.forEach(c => L.push(`    Color? ${c.name},`));
  L.push(`  }) => VColorsTheme(`);
  colors.forEach(c => L.push(`    ${c.name}: ${c.name} ?? this.${c.name},`));
  L.push(`  );`);
  L.push('');
  L.push(`  @override`);
  L.push(`  VColorsTheme lerp(VColorsTheme? other, double t) {`);
  L.push(`    if (other == null) return this;`);
  L.push(`    return VColorsTheme(`);
  colors.forEach(c => L.push(`      ${c.name}: Color.lerp(${c.name}, other.${c.name}, t)!,`));
  L.push(`    );`);
  L.push(`  }`);
  L.push(`}`);
  L.push('');
  return L.join('\n');
}

// lib/themes.dart — one ThemeData per theme: brightness, Material 3, the
// VColorsTheme extension, scaffold background (from the surface role) and a
// ColorScheme built from the role→color mapping.
function generateThemesFile(colors, themes, roles) {
  const pkg = pkgName();
  const byId = (id) => colors.find(c => c.id === id);
  const L = [];
  L.push(`import 'package:flutter/material.dart';`);
  L.push(`import 'package:${pkg}/constants/colors.dart';`);
  L.push('');
  themes.forEach((t, idx) => {
    const bright = t.brightness === 'light' ? 'light' : 'dark';
    const surface = roles.surface ? byId(roles.surface) : null;
    L.push(`final ${t.name} = ThemeData(`);
    L.push(`  brightness: Brightness.${bright},`);
    L.push(`  useMaterial3: true,`);
    L.push(`  extensions: const [VColorsTheme.${t.name}],`);
    if (surface) L.push(`  scaffoldBackgroundColor: ${dartColorValue(colorVal(surface, t.id))},`);
    const assigned = SCHEME_ROLES.filter(r => roles[r.id] && byId(roles[r.id]));
    if (assigned.length) {
      L.push(`  colorScheme: const ColorScheme.${bright}(`);
      assigned.forEach(r => L.push(`    ${r.id}: ${dartColorValue(colorVal(byId(roles[r.id]), t.id))},`));
      L.push(`  ),`);
    }
    L.push(`);`);
    if (idx < themes.length - 1) L.push('');
  });
  L.push('');
  return L.join('\n');
}

// ───────── Typography (typography.dart) generation ─────────

// lib/constants/typography.dart — a VTextStyle set of static TextStyle getters,
// one per Typography style. Sizes use flutter_screenutil's `.sp`; the text colour
// references the matching VColors constant (from colors.dart). Style names are
// already validated as camelCase identifiers, so they map straight to getters.
function generateTypographyFile(styles) {
  const pkg = pkgName();
  const num = (n) => String(Number(n));          // 16 → "16", 1.4 → "1.4", -0.4 → "-0.4"
  const colorOf = (s) => (s.colorId ? state.colors.find(c => c.id === s.colorId) : null);
  const usesColor = styles.some(s => colorOf(s));

  const L = [];
  L.push(`import 'package:flutter/material.dart';`);
  L.push(`import 'package:flutter_screenutil/flutter_screenutil.dart';`);
  if (usesColor) L.push(`import 'package:${pkg}/constants/colors.dart';`);
  L.push('');
  L.push(`abstract class VTextStyle {`);
  styles.forEach((s, idx) => {
    L.push(`  static TextStyle get ${s.name} => TextStyle(`);
    L.push(`    fontFamily: '${s.fontFamily}',`);
    L.push(`    fontSize: ${num(s.fontSize)}.sp,`);
    L.push(`    fontWeight: FontWeight.w${s.fontWeight},`);
    const col = colorOf(s);
    if (col) L.push(`    color: VColors.${col.name},`);
    if (Number(s.letterSpacing) !== 0) L.push(`    letterSpacing: ${num(s.letterSpacing)},`);
    L.push(`    height: ${num(s.lineHeight)},`);
    L.push(`  );`);
    if (idx < styles.length - 1) L.push('');
  });
  L.push(`}`);
  L.push('');
  return L.join('\n');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Everything that can be exported right now: valid models, the enums those models
// reference, and providers. Returned as arrays of the actual state objects.
// Each page exports on its own (pages.js): the open page's screens, as a Flutter
// app for a phone page or as web pages for a web page — two pages never mix.
// A web page's export is its pages/<screen>.html files for now (the web code
// itself comes later), so models, data and theme go only with a phone page.
// `pageId`: the page to export; the one open in the editor by default.
export function collectExportables(pageId = null) {
  const page = (pageId && state.pages.find(p => p.id === pageId)) || activePage();
  const web = !!page && page.kind === 'web';
  const onPage = (n) => !page || pageOf(n) === page.id;
  if (web) {
    const screens = state.nodes.filter(n => isRouteScreen(n) && onPage(n)); // overlays go in the pages that open them
    return { page, web, models: [], enums: [], providers: [], screens, hasTheme: false, hasTypography: false };
  }
  const models = state.models.filter(m => modelError(m) === null);
  const refs = new Set();
  models.forEach(m => m.properties.forEach(p => collectRefs(p.type, refs)));
  const enums = state.enums.filter(e => enumError(e) === null && refs.has(e.name));
  const providers = state.providers;
  // Screens are page frames (root, or directly inside a Section — nested frames
  // are components, not routable pages) with a valid, exportable route path.
  const screens = state.nodes.filter(n =>
    isRouteScreen(n) && onPage(n) && routeExportable(routeOf(n))); // an overlay isn't a route
  // The theme system (colors.dart + themes.dart) is exportable once there's at
  // least one color and one theme to generate from.
  const hasTheme = state.colors.length > 0 && state.themes.length > 0;
  // Typography (typography.dart) rides with the theme unit, so it's reported for
  // the picker label only when the theme unit is itself exportable.
  const hasTypography = hasTheme && state.typography.length > 0;
  return { page, web, models, enums, providers, screens, hasTheme, hasTypography };
}

// The images and icons a web page's screens show (inside component instances
// too): assets/image/<name> and assets/icon/<name>.svg, once each. An image
// bound to data comes from the data at run time, so it has no file.
function webAssetFiles(screens) {
  const out = new Map();
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    if (n.type === 'image' && !(n.bind && n.bind.src)) {
      const f = imageFile(n);
      if (f) out.set(`assets/image/${f.name}`, f.bytes);
    } else if (n.type === 'icon' && n.svg) {
      const f = iconFile(n);
      out.set(`assets/icon/${f.name}`, f.svg);
    } else if (n.type === 'instance') {
      walk(getMasterNode(n.componentId));
    }
    (n.children || []).forEach(id => walk(getNode(id)));
  };
  screens.forEach(walk);
  return [...out].map(([name, content]) => ({ name, content }));
}

// A web screen's file: pages/<screen>.html, inside a folder named after its
// section when it's in one (as a phone screen's view lands in lib/view/<section>/).
function webPagePath(fr) { return `pages/${webFolder(fr)}${snake(fr.name)}.html`; }
// …and its stylesheet: assets/css/pages/<section>/<screen>.css.
function webPageCssPath(fr) { return `assets/css/pages/${webFolder(fr)}${snake(fr.name)}.css`; }
function webFolder(fr) {
  const parent = fr.parentId ? getNode(fr.parentId) : null;
  return parent && parent.type === 'section' ? snake(parent.name) + '/' : '';
}

// The Dart files an exported item lands at (shown in the export picker). Each
// screen has its own view file (plus a shared lib/route.dart wiring them up);
// the theme unit is several files that import each other, so they export together.
export function dartPaths(kind, name) {
  if (kind === 'screens') {
    // The screen of that name on the open page (another page may have one too).
    const { screens, web } = collectExportables();
    const fr = screens.find(n => n.name === name);
    if (web) return fr ? [webPagePath(fr), webPageCssPath(fr)] : [];
    const parent = fr && fr.parentId ? getNode(fr.parentId) : null;
    const folder = parent && parent.type === 'section' ? snake(parent.name) + '/' : '';
    return [`lib/view/${folder}${snake(name)}.dart`];
  }
  if (kind === 'theme') {
    if (collectExportables().web) return ['assets/css/scaffold.css', 'assets/css/variable.css', 'assets/css/typography.css'];
    return state.typography.length
      ? ['lib/constants/colors.dart', 'lib/constants/typography.dart', 'lib/themes.dart']
      : ['lib/constants/colors.dart', 'lib/themes.dart'];
  }
  return [`lib/${kind === 'providers' ? 'provider' : 'model'}/${snake(name)}.dart`];
}

// Generate a .dart file per model (+ any enum a model uses) under lib/model/, and
// a Riverpod notifier per provider under lib/provider/, then bundle them into a
// zip and trigger a download. `selection` (optional) narrows the export to chosen
// items: { models:Set<name>, enums:Set<name>, providers:Set<name> }. Assumes the
// project is otherwise error-free (the export button is gated on that).
// Every file the export would write for `selection` (null = everything), without
// downloading: { ok, files, counts }. Image and icon files (assets/…) are the
// ones the chosen screens and components actually use.
function buildExportFiles(selection = null, pageId = null) {
  const all = collectExportables(pageId);
  if (all.web) {
    // A web page: one empty .html file per screen for now.
    const screens = selection ? all.screens.filter(s => selection.screens?.has(s.name)) : all.screens;
    if (!screens.length) return { ok: false };
    // Each screen: its page (pages/…html) and stylesheet (assets/css/pages/…css),
    // then the shared colour tokens and text styles, then images and icons.
    const isWeb = (fr) => (state.pages.find(p => p.id === pageOf(fr)) || {}).kind === 'web';
    const files = [];
    const shared = {
      projectName: state.projectName,
      href: (target) => isWeb(target) ? routeOf(target) : null, // a phone screen has no web address
      imagePath: (n) => { const f = imageFile(n); return f ? `/assets/image/${f.name}` : null; },
    };
    const components = new Set(), widgets = new Set();
    screens.forEach(fr => {
      const cssPath = webPageCssPath(fr);
      const { html, css } = generateWebPage(fr, { ...shared, route: routeOf(fr), cssHref: '/' + cssPath });
      files.push({ name: webPagePath(fr), content: html }, { name: cssPath, content: css });
      usedComponents(fr).forEach(id => components.add(id));
      usedWidgets(fr).forEach(tag => widgets.add(tag));
    });
    // The Web Components they use, one script each.
    widgets.forEach(tag => files.push({ name: widgetScriptPath(tag), content: widgetScript(tag) }));
    // The components those pages use (nested ones included), one macro each.
    components.forEach(id => {
      const { html, css } = generateWebComponent(id, shared);
      files.push({ name: componentTemplatePath(id), content: html }, { name: componentCssPath(id), content: css });
    });
    files.push({ name: 'assets/css/scaffold.css', content: generateBaseCss() });
    files.push({ name: 'assets/css/variable.css', content: generateVariablesCss() });
    files.push({ name: 'assets/css/typography.css', content: generateTypographyCss() });
    // Images and icons — the overlays' too (they're written into the pages that open them).
    const overlayFrames = [...new Set(screens.flatMap(fr => usedOverlays(fr)))];
    files.push(...webAssetFiles([...screens, ...overlayFrames]));
    // Animations: their files, and the player that plays them (served by the site itself).
    const animations = lottiesUsed([...screens, ...overlayFrames], getNode, getMasterNode);
    animations.forEach((json, id) => files.push({ name: `assets/lottie/${lottieFile(id)}`, content: json }));
    if (animations.size && lottiePlayerSource()) files.push({ name: 'assets/js/vendor/lottie_light.min.js', content: lottiePlayerSource() });
    return { ok: true, page: all.page, files, models: 0, enums: 0, providers: 0, screens: screens.length, theme: 0, skipped: 0 };
  }
  let { models, enums, providers, screens } = all;
  const wantTheme = all.hasTheme && (!selection || (selection.theme && selection.theme.size > 0));
  if (selection) {
    models = models.filter(m => selection.models?.has(m.name));
    enums = enums.filter(e => selection.enums?.has(e.name));
    providers = providers.filter(p => selection.providers?.has(p.name));
    screens = screens.filter(s => selection.screens?.has(s.name));
  }
  if (!models.length && !enums.length && !providers.length && !screens.length && !wantTheme) return { ok: false };

  const files = [];
  models.forEach(m => files.push({ name: `lib/model/${snake(m.name)}.dart`, content: generateModelFile(m) }));
  enums.forEach(e => files.push({ name: `lib/model/${snake(e.name)}.dart`, content: generateEnumFile(e) }));
  providers.forEach(p => files.push({ name: `lib/provider/${snake(p.name)}.dart`, content: generateProviderFile(p) }));
  if (screens.length) {
    const items = screenItems(screens);
    routeNames = new Map(items.map(it => [it.fr.id, it.cname]));
    const usedMocks = new Set();
    const usedComponents = new Set();
    let innerShadow = false; // any screen or component draws an inner shadow
    let appImage = false;    // ...or shows an image
    let carousel = false;    // ...or a carousel
    let accordion = false;   // ...or an accordion
    let lottie = false;      // ...or an animation
    const overlayQueue = [];  // overlay frames they open (lib/widget/overlay/)
    const iconAssets = new Map();  // assets/icons/<name>.svg  → svg markup   (deduped across screens)
    const imageAssets = new Map(); // assets/images/<name>.<ext> → image bytes (deduped across screens)
    items.forEach(it => {
      const { content, icons, images, mocks, components, innerShadow: inner, appImage: usesImage, carousel: usesCarousel, accordion: usesAccordion, lottie: usesLottie, overlays: opens } = generateViewFile(it);
      if (usesImage) appImage = true;
      if (usesCarousel) carousel = true;
      if (usesAccordion) accordion = true;
      if (usesLottie) lottie = true;
      opens.forEach(id => overlayQueue.push(id));
      if (inner) innerShadow = true;
      mocks.forEach(m => usedMocks.add(m));
      components.forEach(c => usedComponents.add(c));
      files.push({ name: `lib/view/${it.file}.dart`, content });
      icons.forEach((svg, path) => iconAssets.set(path, svg));
      images.forEach((bytes, path) => imageAssets.set(path, bytes));
    });
    files.push({ name: 'lib/route.dart', content: generateRouteFile(items) });
    // Each component the screens use (and the components those use), once.
    const done = new Set();
    const queue = [...usedComponents];
    while (queue.length) {
      const id = queue.shift();
      if (done.has(id)) continue;
      done.add(id);
      const c = state.components.find(x => x.id === id);
      if (!c) continue;
      const { content, icons, images, components, innerShadow: inner, appImage: usesImage, carousel: usesCarousel, accordion: usesAccordion, lottie: usesLottie, overlays: opens } = generateComponentFile(c);
      if (usesImage) appImage = true;
      if (usesCarousel) carousel = true;
      if (usesAccordion) accordion = true;
      if (usesLottie) lottie = true;
      opens.forEach(id => overlayQueue.push(id));
      if (inner) innerShadow = true;
      files.push({ name: `lib/widget/${componentFile(c)}.dart`, content });
      icons.forEach((svg, path) => iconAssets.set(path, svg));
      images.forEach((bytes, path) => imageAssets.set(path, bytes));
      components.forEach(x => queue.push(x));
    }
    // Each overlay the screens and components open (and the overlays those open), once.
    const overlaysDone = new Set();
    while (overlayQueue.length) {
      const id = overlayQueue.shift();
      if (overlaysDone.has(id)) continue;
      overlaysDone.add(id);
      const fr = getNode(id);
      if (!fr || !isOverlayFrame(fr)) continue;
      const out = generateOverlayFile(fr);
      files.push({ name: `lib/widget/overlay/${overlayFile(fr)}.dart`, content: out.content });
      out.icons.forEach((svg, path) => iconAssets.set(path, svg));
      out.images.forEach((bytes, path) => imageAssets.set(path, bytes));
      if (out.appImage) appImage = true;
      if (out.innerShadow) innerShadow = true;
      if (out.carousel) carousel = true;
      if (out.accordion) accordion = true;
      if (out.lottie) lottie = true;
      out.overlays.forEach(x => overlayQueue.push(x));
      out.components.forEach(c => { if (!done.has(c)) queue.push(c); });
    }
    while (queue.length) { // components first reached through an overlay
      const id = queue.shift();
      if (done.has(id)) continue;
      done.add(id);
      const c = state.components.find(x => x.id === id);
      if (!c) continue;
      const out = generateComponentFile(c);
      files.push({ name: `lib/widget/${componentFile(c)}.dart`, content: out.content });
      out.icons.forEach((svg, path) => iconAssets.set(path, svg));
      out.images.forEach((bytes, path) => imageAssets.set(path, bytes));
      if (out.appImage) appImage = true;
      if (out.innerShadow) innerShadow = true;
      if (out.carousel) carousel = true;
      if (out.accordion) accordion = true;
      if (out.lottie) lottie = true;
      out.components.forEach(x => queue.push(x));
    }
    if (overlaysDone.size) files.push({ name: 'lib/widget/app_overlay.dart', content: APP_OVERLAY_DART });
    if (lottie) {
      files.push({ name: 'lib/widget/app_lottie.dart', content: APP_LOTTIE_DART });
      // The animation files the screens play (assets/lottie/; declare the folder in pubspec.yaml).
      lottiesUsed(items.map(it => it.fr), getNode, getMasterNode).forEach((json, id) => files.push({ name: `assets/lottie/${lottieFile(id)}`, content: json }));
    }
    if (innerShadow) files.push({ name: 'lib/widget/inner_shadow.dart', content: INNER_SHADOW_DART });
    if (carousel) files.push({ name: 'lib/widget/app_carousel.dart', content: APP_CAROUSEL_DART });
    if (accordion) files.push({ name: 'lib/widget/app_accordion.dart', content: APP_ACCORDION_DART });
    if (appImage) {
      files.push({ name: 'lib/widget/app_image.dart', content: appImageDart(pkgName()) });
      files.push({ name: 'lib/widget/image_placeholder.dart', content: IMAGE_PLACEHOLDER_DART });
      files.push({ name: 'lib/widget/image_error_widget.dart', content: imageErrorWidgetDart(pkgName()) });
      // AppImage shows an ImageModel, so its file goes along even if the model wasn't picked.
      if (!files.some(f => f.name === 'lib/model/image_model.dart')) files.push({ name: 'lib/model/image_model.dart', content: imageModelDart(pkgName()) });
    }
    // The mock data the screens read (lib/mock/<set>.dart), plus the model and enum
    // files it needs even if they weren't picked for export.
    usedMocks.forEach(name => {
      const set = state.mockSets.find(s => s.name === name);
      const model = set && state.models.find(m => m.id === set.modelId);
      if (!model) return;
      const refs = new Set([model.name]);
      const walk = (mName) => {
        const m = state.models.find(x => x.name === mName);
        (m ? m.properties : []).forEach(p => {
          const before = refs.size;
          collectRefs(p.type, refs);
          if (refs.size > before) [...refs].forEach(r => { if (isModel(r) && r !== mName) walk(r); });
        });
      };
      walk(model.name);
      const pkg = pkgName();
      const imports = [...refs].sort().map(r => `import 'package:${pkg}/model/${snake(r)}.dart';`);
      // A mock ImageModel is built with its provider (CachedNetworkImageProvider).
      if ([...refs].some(r => state.models.some(m => m.name === r && m.builtin === 'image'))) {
        imports.unshift(`import 'package:cached_network_image/cached_network_image.dart';`);
      }
      files.push({ name: `lib/mock/${snake(name)}.dart`, content: `${imports.join('\n')}\n\n// Mock data from the Mock Data tab.\n${mockDart(set)}\n` });
      refs.forEach(r => {
        const path = `lib/model/${snake(r)}.dart`;
        if (files.some(f => f.name === path)) return;
        const m = state.models.find(x => x.name === r);
        const e = state.enums.find(x => x.name === r);
        if (m) files.push({ name: path, content: generateModelFile(m) });
        else if (e) files.push({ name: path, content: generateEnumFile(e) });
      });
    });
    iconAssets.forEach((svg, path) => files.push({ name: path, content: svg }));
    imageAssets.forEach((bytes, path) => files.push({ name: path, content: bytes }));
  }
  if (wantTheme) {
    files.push({ name: 'lib/constants/colors.dart', content: generateColorsFile(state.colors, state.themes) });
    // Typography rides with the theme unit (it references VColors from colors.dart).
    if (state.typography.length) {
      files.push({ name: 'lib/constants/typography.dart', content: generateTypographyFile(state.typography) });
    }
    files.push({ name: 'lib/themes.dart', content: generateThemesFile(state.colors, state.themes, state.colorRoles || {}) });
  }

  return { ok: true, page: all.page, files, models: models.length, enums: enums.length, providers: providers.length, screens: screens.length, theme: wantTheme ? 1 : 0, skipped: state.models.length - all.models.length };
}

// Images and icons only — the web export's CSS / JS under assets/ are code, always written.
const isAsset = (name) => /^assets\/(images?|icons?)\//.test(name);

// The image and icon files a full export would include, for the export picker:
// [{ path, kind: 'image' | 'icon', preview }] — preview is a data URL to show.
// Needs images resolved first (resolveRefsForExport), like the export itself.
export function exportAssets() {
  const r = buildExportFiles(null);
  if (!r.ok) return [];
  return r.files.filter(f => isAsset(f.name)).map(f => {
    const icon = /^assets\/icons?\//.test(f.name); // assets/icons/ (Flutter) or assets/icon/ (web)
    const ext = f.name.split('.').pop().toLowerCase();
    const mime = icon || ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    let preview;
    if (typeof f.content === 'string') preview = `data:${mime};charset=utf-8,${encodeURIComponent(f.content)}`;
    else {
      let bin = '';
      for (let i = 0; i < f.content.length; i++) bin += String.fromCharCode(f.content[i]);
      preview = `data:${mime};base64,${btoa(bin)}`;
    }
    return { path: f.name, kind: icon ? 'icon' : 'image', preview };
  });
}

// Generate the export for `selection` and download it as a zip. `selection.assets`
// (a Set of paths) narrows the image / icon files; without it, all of them go.
export function exportModelsCode(selection = null, pageId = null) {
  const r = buildExportFiles(selection, pageId);
  if (!r.ok) return r;
  const files = selection && selection.assets
    ? r.files.filter(f => !isAsset(f.name) || selection.assets.has(f.name))
    : r.files;
  // Named after the page, so two pages' exports never get mixed up.
  const page = r.page;
  downloadBlob(makeZip(files), `${pkgName()}${page ? '_' + snake(page.name) : ''}_code.zip`);
  const { files: _all, page: _page, ...counts } = r;
  return { ...counts, page: page ? { id: page.id, name: page.name, kind: page.kind } : null, assets: files.filter(f => isAsset(f.name)).length };
}
