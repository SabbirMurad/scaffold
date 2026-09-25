import { state, getNode } from './state.js';
import { isScreenFrame } from './nodes.js';
import { typeToString, modelError, enumError } from './models.js';
import { generateScreenBody, generateComponentBody, componentClass } from './widgetgen.js';
import { makeZip } from './zip.js';
import { toDart as mockDart } from './mock.js';

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

function generateModelFile(model) {
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
function endpointPath(api) {
  return [api.version, api.route]
    .map(s => (s || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

// One async method per endpoint. Header/query values are emitted as written (so
// they can be Dart expressions or quoted literals); the body is emitted raw.
function generateApiMethod(api) {
  const L = [];
  L.push(`  Future<${apiReturnType(api)}> ${api.name}() async {`);
  L.push(`    final response = await utils.CustomHttp.${api.method.toLowerCase()}(`);
  L.push(`      endpoint: '${endpointPath(api)}',`);

  const headers = api.headers.filter(h => h.key.trim());
  if (headers.length) {
    L.push(`      header: {`);
    headers.forEach(h => L.push(`        '${h.key.trim()}': ${h.value.trim()},`));
    L.push(`      },`);
  }
  const params = (api.params || []).filter(p => p.key.trim());
  if (params.length) {
    L.push(`      queries: {`);
    params.forEach(p => L.push(`        '${p.key.trim()}': ${p.value.trim()},`));
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

function generateProviderFile(p) {
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
function routeOf(frame) {
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
  if (ctx.svg) L.push(`import 'package:flutter_svg/flutter_svg.dart';`);
  if (ctx.screenutil) L.push(`import 'package:flutter_screenutil/flutter_screenutil.dart';`);
  if (ctx.colors) L.push(`import 'package:${pkg}/constants/colors.dart';`);
  if (ctx.typo) L.push(`import 'package:${pkg}/constants/typography.dart';`);
  [...ctx.mocks].sort().forEach(m => L.push(`import 'package:${pkg}/mock/${snake(m)}.dart';`));
  [...ctx.enums].sort().forEach(e => L.push(`import 'package:${pkg}/model/${snake(e)}.dart';`));
  if (ctx.routes) L.push(`import 'package:${pkg}/route.dart';`);
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
  return { content: L.join('\n'), icons: ctx.icons, images: ctx.images, mocks: ctx.mocks, components: ctx.components };
}

// ───────── Components (lib/widget/<name>.dart) ─────────
const componentFile = (c) => snake(componentClass(c));
function componentImports(ctx) {
  const pkg = pkgName();
  return [...ctx.components].map(id => state.components.find(c => c.id === id)).filter(Boolean)
    .map(c => `import 'package:${pkg}/widget/${componentFile(c)}.dart';`).sort();
}

// A component as a StatelessWidget: its master's design, built once and used by
// every screen (and component) that places it.
function generateComponentFile(c) {
  const pkg = pkgName();
  const cls = componentClass(c);
  const { code, ctx } = generateComponentBody(c.id, { routeName: (id) => (routeNames.get(id) || null) });
  const L = [`import 'package:flutter/material.dart';`];
  if (ctx.svg) L.push(`import 'package:flutter_svg/flutter_svg.dart';`);
  if (ctx.screenutil) L.push(`import 'package:flutter_screenutil/flutter_screenutil.dart';`);
  if (ctx.colors) L.push(`import 'package:${pkg}/constants/colors.dart';`);
  if (ctx.typo) L.push(`import 'package:${pkg}/constants/typography.dart';`);
  if (ctx.routes) L.push(`import 'package:${pkg}/route.dart';`);
  ctx.components.delete(c.id);
  componentImports(ctx).forEach(i => L.push(i));
  L.push('', `class ${cls} extends StatelessWidget {`, `  const ${cls}({super.key});`, '');
  L.push(`  @override`, `  Widget build(BuildContext context) {`, `    return ${code};`, `  }`, `}`, '');
  return { content: L.join('\n'), icons: ctx.icons, images: ctx.images, components: ctx.components };
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
export function collectExportables() {
  const models = state.models.filter(m => modelError(m) === null);
  const refs = new Set();
  models.forEach(m => m.properties.forEach(p => collectRefs(p.type, refs)));
  const enums = state.enums.filter(e => enumError(e) === null && refs.has(e.name));
  const providers = state.providers;
  // Screens are page frames (root, or directly inside a Section — nested frames
  // are components, not routable pages) with a valid, exportable route path.
  const screens = state.nodes.filter(n =>
    isScreenFrame(n) && routeExportable(routeOf(n)));
  // The theme system (colors.dart + themes.dart) is exportable once there's at
  // least one color and one theme to generate from.
  const hasTheme = state.colors.length > 0 && state.themes.length > 0;
  // Typography (typography.dart) rides with the theme unit, so it's reported for
  // the picker label only when the theme unit is itself exportable.
  const hasTypography = hasTheme && state.typography.length > 0;
  return { models, enums, providers, screens, hasTheme, hasTypography };
}

// The Dart file an exported item lands at (shown in the export picker). Each
// screen has its own view file (plus a shared lib/route.dart wiring them up);
// the theme unit produces two shared files.
export function dartPath(kind, name) {
  if (kind === 'screens') {
    const fr = state.nodes.find(n => n.type === 'frame' && n.name === name);
    const parent = fr && fr.parentId ? getNode(fr.parentId) : null;
    const folder = parent && parent.type === 'section' ? snake(parent.name) + '/' : '';
    return `lib/view/${folder}${snake(name)}.dart`;
  }
  if (kind === 'theme') {
    return state.typography.length
      ? 'lib/constants/colors.dart + typography.dart + lib/themes.dart'
      : 'lib/constants/colors.dart + lib/themes.dart';
  }
  return `lib/${kind === 'providers' ? 'provider' : 'model'}/${snake(name)}.dart`;
}

// Generate a .dart file per model (+ any enum a model uses) under lib/model/, and
// a Riverpod notifier per provider under lib/provider/, then bundle them into a
// zip and trigger a download. `selection` (optional) narrows the export to chosen
// items: { models:Set<name>, enums:Set<name>, providers:Set<name> }. Assumes the
// project is otherwise error-free (the export button is gated on that).
export function exportModelsCode(selection = null) {
  const all = collectExportables();
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
    const iconAssets = new Map();  // assets/icons/<name>.svg  → svg markup   (deduped across screens)
    const imageAssets = new Map(); // assets/images/<name>.<ext> → image bytes (deduped across screens)
    items.forEach(it => {
      const { content, icons, images, mocks, components } = generateViewFile(it);
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
      const { content, icons, images, components } = generateComponentFile(c);
      files.push({ name: `lib/widget/${componentFile(c)}.dart`, content });
      icons.forEach((svg, path) => iconAssets.set(path, svg));
      images.forEach((bytes, path) => imageAssets.set(path, bytes));
      components.forEach(x => queue.push(x));
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

  downloadBlob(makeZip(files), `${pkgName()}_code.zip`);
  return { ok: true, models: models.length, enums: enums.length, providers: providers.length, screens: screens.length, theme: wantTheme ? 1 : 0, skipped: state.models.length - all.models.length };
}
