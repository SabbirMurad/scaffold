import { state } from './state.js';
import { typeToString, modelError, enumError } from './models.js';
import { makeZip } from './zip.js';

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
  L.push(`    return null;`);
  L.push(`  }`);
  p.apis.forEach(a => { L.push(''); L.push(generateApiMethod(a)); });
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
  return { models, enums, providers };
}

// The Dart file an exported item lands at (shown in the export picker).
export function dartPath(kind, name) {
  return `lib/${kind === 'providers' ? 'provider' : 'model'}/${snake(name)}.dart`;
}

// Generate a .dart file per model (+ any enum a model uses) under lib/model/, and
// a Riverpod notifier per provider under lib/provider/, then bundle them into a
// zip and trigger a download. `selection` (optional) narrows the export to chosen
// items: { models:Set<name>, enums:Set<name>, providers:Set<name> }. Assumes the
// project is otherwise error-free (the export button is gated on that).
export function exportModelsCode(selection = null) {
  const all = collectExportables();
  let { models, enums, providers } = all;
  if (selection) {
    models = models.filter(m => selection.models?.has(m.name));
    enums = enums.filter(e => selection.enums?.has(e.name));
    providers = providers.filter(p => selection.providers?.has(p.name));
  }
  if (!models.length && !enums.length && !providers.length) return { ok: false };

  const files = [];
  models.forEach(m => files.push({ name: `lib/model/${snake(m.name)}.dart`, content: generateModelFile(m) }));
  enums.forEach(e => files.push({ name: `lib/model/${snake(e.name)}.dart`, content: generateEnumFile(e) }));
  providers.forEach(p => files.push({ name: `lib/provider/${snake(p.name)}.dart`, content: generateProviderFile(p) }));

  downloadBlob(makeZip(files), `${pkgName()}_code.zip`);
  return { ok: true, models: models.length, enums: enums.length, providers: providers.length, skipped: state.models.length - all.models.length };
}
