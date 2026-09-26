// Scaffold's tools for Claude Code. The desktop app runs the person's own Claude
// Code with an MCP server (`scaffold mcp`) whose tool list and calls are relayed
// here through the app (desktop/src-tauri/src/bridge.rs), so each edit happens in
// this page: on the undo history and the collaboration socket, like a manual one.
//
// The aim is parity with the editor: anything a person can do by hand — screens,
// sections, every element type, styling, components, navigation, colors and
// themes, text styles, models, enums, mock data, API providers, comments, undo,
// export — Claude can do through these tools, under the same rules the UI
// enforces (names, nesting, field ownership).
//
// Every tool answers { ok, summary, ...data }. `summary` is what the chat panel
// shows; on failure it tells Claude what to fix.

import { state, makeNode, getNode, getColorById, getTypoById, getComponent, isMaster, isInstance, nextNodeId,
  makeColorValue, routeFromName } from './state.js';
import { canvasWrap } from './utils.js';
import { canvasToWorld, canAcceptChild, canBeComponent, getWorldPos, isDescendant, isStack,
  isScreenFrame, reparentNode, flexKind, CONTAINER_TYPES } from './nodes.js';
import { render, applyTransform } from './render.js';
import { saveHistory, undo, redo, rerenderActive, fieldApplies, captureState, restoreState } from './history.js';
import { cloneNodeInPlace, componentName, instancesOf, detachInstance, detachInstancesOf, renameComponent } from './operations.js';
import { applyTheme, colorError, anyColorError } from './colors.js';
import { typoError, anyTypoError } from './typography.js';
import { modelError, enumError, propError, enumValError, typeToString, anyModelError, anyEnumError, renameTypeRefs } from './models.js';
import { generate as generateMock, defaultName as mockName } from './mock.js';
import { provNameError, apiNameError, anyProviderError } from './api.js';
import { frameNameError, routeError, anyFrameError } from './props.js';
import { finalizeImages, resolveRefsForExport } from './images.js';
import { exportModelsCode } from './codegen.js';
import { scopeFor, pathError, condError, canRepeat, OP_VALUES, providerPreview, previewCandidates } from './data.js';
import { loadComments } from './comments.js';
import { listComments, createComment, replyComment, resolveComment, updateProject } from './projects.js';

const ICON_API = 'https://api.iconify.design';
const IMAGE_API = 'https://api.openverse.org/v1/images/';
const DEVICE = { w: 393, h: 852 };
const TEXT_WEIGHTS = ['300', '400', '500', '600', '700', '800'];

// ═════════════════════════════ Tool definitions ═════════════════════════════

const COLOR_HELP = 'Colors are a hex ("#1e293b"), "transparent", or a color variable as "var:<name>" (see get_data).';

const ELEMENT_HELP = [
  'An element is an object with a "type" and properties:',
  '  container: { "type":"container", "layout":"column|row|wrap|stack|none", "gap":12, "padding":16, "fill":"#f3f4f6", "radius":12, "align":"left|center|right", "valign":"top|center|bottom", "children":[ ... ] }',
  '             layout "none" holds exactly one child; column/row/wrap lay children out; stack positions children freely by x/y.',
  '  text:      { "type":"text", "text":"...", "textStyle":"<style name>", "align":"left|center|right" }  — a text style gives font, size and color; fontSize / fontWeight / color ("var:<name>") on top of it override just those. Without a style: fontSize, fontWeight and a hex or "var:" color.',
  '  image:     { "type":"image", "search":"mountain lake", "fit":"cover|contain", "height":180, "radius":12 }  — "search" takes the first free stock photo (Openverse); or "url":"https://…"; neither gives a grey placeholder.',
  '  icon:      { "type":"icon", "icon":"mdi:home", "size":24, "color":"var:<color name>" }  — any Iconify id (use search_icons). Icons are tinted only by a color variable.',
  '  button:    { "type":"button", "text":"Sign in", "fill":"#2563eb", "color":"#ffffff", "radius":10 }  — a container with a centred label.',
  '  instance:  { "type":"instance", "component_id":"cmp1" }  — a live copy of a component.',
  'Any element also takes: name, width / height (px number, "fill" to fill the parent, or "hug" to fit content), x / y (only inside a stack or on the bare canvas), '
    + 'opacity (0–1), rotation, stroke / strokeWidth / strokeStyle ("solid|dashed|dotted"), shadows ([{x,y,blur,spread,color:"var:…",alpha}]), '
    + 'margin, visible, locked, scroll (containers), and "props" — raw node fields for anything else (see get_element for field names).',
  'Mock data (see get_data): "bind":{"text":"item.name","src":"user.avatar_url","fill":"item.color_hex","color":"…"} fills an element from a field; '
    + '"showIf":{"path":"user.role","op":"==","value":"admin"} shows it only while the condition holds (op: truthy, falsy, ==, !=, >, <, >=, <=, empty, notEmpty — compare enums by value name); '
    + 'on a row/column/wrap container, "repeat":{"source":"exercises","as":"item"} draws its children once per item of a list — design them once, bound to item.<field>. '
    + 'Paths start at a mock set\'s name, an API provider\'s name (the design shows its preview mock data; exported screens read the provider), or an enclosing repeat\'s alias. Set any of these to null to remove it.',
  'Down a column, children fill its width by default. Along a row, children fit their content; give width "fill" to the ones that should share the row\'s free space (e.g. two buttons side by side). ' + COLOR_HELP,
].join('\n');

const obj = (properties, required = [], extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const num = (description) => (description ? { type: 'number', description } : { type: 'number' });
const bool = (description) => (description ? { type: 'boolean', description } : { type: 'boolean' });
const ELEMENT = { type: 'object', description: 'An element — see the format in the tool description.' };
const READ = { readOnlyHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const TOOLS = [
  // ── Reading ──
  {
    name: 'get_design', title: 'Get design', annotations: READ,
    description: 'The canvas: every section, screen and element as a tree with ids, types, names, text, layout, colors, and navigation; plus the components. Call it before changing existing elements, to get their ids.',
    inputSchema: obj({}),
  },
  {
    name: 'get_element', title: 'Get element', annotations: READ,
    description: 'Every field of one element, exactly as stored — use it to see a property get_design leaves out, or the raw field names for update_element\'s "props".',
    inputSchema: obj({ id: str() }, ['id']),
  },
  {
    name: 'get_data', title: 'Get data', annotations: READ,
    description: 'Everything off the canvas: themes, color variables (value per theme), Material color roles, text styles, data models, enums, mock data sets, API providers with their endpoints, and the API base URL.',
    inputSchema: obj({}),
  },

  // ── Screens, sections, elements ──
  {
    name: 'create_screen', title: 'Create screen', annotations: EDIT,
    description: 'Add a new screen (a routable page frame) beside the existing ones, or inside a section, built from a nested description in one call. '
      + 'The screen is a column by default. Screen names become Dart file/class names, so they are snake_case (e.g. "login_page"); other names are converted.\n\n'
      + 'Shape: { "name":"login_page", "section_id":"<optional>", "width":393, "height":852, "background":"#ffffff", "padding":20, "gap":16, "layout":"column", "align":"left", "route":"/login", "initial":true, "children":[ <element>, ... ] }\n\n' + ELEMENT_HELP,
    inputSchema: obj({
      name: str('snake_case, e.g. "login_page".'),
      section_id: str('Put the screen inside this section.'),
      width: num('Default 393.'),
      height: num('The frame\'s height. Default: the screen height. Taller makes the screen scroll: the device screen stays screen_height tall and the rest is below the fold.'),
      screen_height: num('The device screen\'s height (what\'s visible without scrolling). Default 852; change it only for another device size.'),
      background: str(COLOR_HELP),
      padding: { description: 'A number, or {t,r,b,l}.' }, gap: num(),
      layout: { type: 'string', enum: ['column', 'row', 'stack', 'none'] },
      align: { type: 'string', enum: ['left', 'center', 'right'] },
      valign: { type: 'string', enum: ['top', 'center', 'bottom'] },
      route: str('Route path, dashed-case, e.g. "/user-profile". Default: derived from the name.'),
      initial: bool('Make this the app\'s start screen.'),
      children: { type: 'array', items: ELEMENT },
    }),
  },
  {
    name: 'create_section', title: 'Create section', annotations: EDIT,
    description: 'Add a section — a named region grouping screens; in generated code it becomes a folder. Give frame_ids to move existing screens into it (it is sized around them), or an empty section is placed beside the existing content. Names are snake_case.',
    inputSchema: obj({
      name: str('snake_case, e.g. "onboarding".'),
      frame_ids: { type: 'array', items: { type: 'string' }, description: 'Screens (root frames) to move into the section.' },
      width: num(), height: num(),
    }),
  },
  {
    name: 'add_elements', title: 'Add elements', annotations: EDIT,
    description: 'Add elements (with any children) inside a screen or container — after its current children, or at `index`. Leave parent_id out to place them loose on the canvas at x/y.\n\n' + ELEMENT_HELP,
    inputSchema: obj({
      parent_id: str('A screen or container id, from get_design.'),
      elements: { type: 'array', items: ELEMENT, minItems: 1 },
      index: { type: 'integer', minimum: 0, description: 'Insert position among the parent\'s children.' },
    }, ['elements']),
  },
  {
    name: 'update_element', title: 'Update element', annotations: EDIT,
    description: 'Change properties of one screen, section or element. Only what is given changes. Takes the same properties as an element in add_elements (text, fontSize, fontWeight, color, textStyle, fill, radius — a number or {tl,tr,br,bl} —, padding, margin, gap, layout, align, valign, width, height, x, y, opacity, rotation, flipH, flipV, stroke, strokeWidth, strokeStyle, shadows, visible, locked, scroll, fit, icon, url, search, gradient), '
      + 'screen properties (route, initial), and "props" for raw node fields. Fill can also be a gradient: {"type":"linear|radial","angle":90,"stops":[{"color":"#…","pos":0},{"color":"#…","pos":100}]}. ' + COLOR_HELP,
    inputSchema: obj({ id: str(), properties: { type: 'object', description: 'The properties to set.' } }, ['id', 'properties']),
  },
  {
    name: 'move_element', title: 'Move element', annotations: EDIT,
    description: 'Move an element into another screen/container (or onto the bare canvas with parent_id null), and/or reorder it among its siblings with index. Screens can move into or out of sections. Nesting follows the editor\'s rules: a layout "none" container holds one child; sections hold only screens.',
    inputSchema: obj({
      id: str(),
      parent_id: { type: ['string', 'null'], description: 'New parent; null for the canvas. Omit to stay in the current parent.' },
      index: { type: 'integer', minimum: 0 },
      x: num('Position, for the canvas or a stack/section parent.'), y: num(),
    }, ['id']),
  },
  {
    name: 'duplicate_elements', title: 'Duplicate elements', annotations: EDIT,
    description: 'Copy elements with everything inside them, placed next to the originals. A component (or an instance of one) duplicates as a new instance.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['ids']),
  },
  {
    name: 'delete_elements', title: 'Delete elements', annotations: DESTROY,
    description: 'Delete screens, sections or elements, with everything inside them. The person can undo it.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['ids']),
  },
  {
    name: 'edit_component', title: 'Edit component', annotations: EDIT,
    description: 'Rename a component (its master is renamed with it), or detach an instance — replace it with a plain, editable copy of the component\'s design in the same place. '
      + 'To change what every instance looks like, edit the master (see get_design: components → master_id); deleting the master turns its instances into plain copies.',
    inputSchema: obj({
      action: { type: 'string', enum: ['rename', 'detach'] },
      component_id: str('For rename.'), name: str('For rename.'),
      id: str('For detach: the instance.'),
    }, ['action']),
  },
  {
    name: 'make_component', title: 'Make component', annotations: EDIT,
    description: 'Turn an element (not a screen or section, and with none inside it) into a reusable component. Place copies with add_elements {"type":"instance","component_id":…}; instances mirror the component live.',
    inputSchema: obj({ id: str(), name: str() }, ['id']),
  },
  {
    name: 'set_interaction', title: 'Set interaction', annotations: EDIT,
    description: 'What tapping an element does in the app: navigate to a screen, go back, or nothing. This is what the Connect tool wires. '
      + 'routes adds conditional navigation, tried in order before target_screen_id: [{"when":{"path":"user.role","op":"==","value":"admin"},"target_screen_id":"n12"}] — e.g. route admins and members to different screens. '
      + 'Paths are mock-data paths in scope for the element (a mock set, or an enclosing repeat\'s item).',
    inputSchema: obj({
      id: str(),
      action: { type: 'string', enum: ['navigate', 'back', 'none'] },
      target_screen_id: str('For navigate: the screen (frame) id.'),
      mode: { type: 'string', enum: ['push', 'replace', 'clear'], description: 'Default push.' },
      transition: { type: 'string', enum: ['platform', 'fade', 'slideRight', 'none'], description: 'Default platform.' },
      routes: { type: 'array', items: { type: 'object' }, description: 'Conditional routes: [{ when: {path, op, value}, target_screen_id }].' },
    }, ['id', 'action']),
  },
  {
    name: 'search_icons', title: 'Search icons', annotations: { readOnlyHint: true, openWorldHint: true },
    description: 'Search the free Iconify catalogue; returns icon ids like "mdi:home" for icon elements.',
    inputSchema: obj({ query: str(), limit: { type: 'integer', minimum: 1, maximum: 60 } }, ['query']),
  },
  {
    name: 'check_design', title: 'Check design', annotations: READ,
    description: 'Measure the rendered screens and report problems a person would see: text too low in contrast to read, elements overflowing their parent or the screen, content cut off at the bottom of a screen, and tap targets under 44px. '
      + 'Editing tools also report these for the screen they changed. Fix every issue before you finish.',
    inputSchema: obj({ id: str('A screen id; leave out to check every screen.') }),
  },
  {
    name: 'focus', title: 'Focus', annotations: READ,
    description: 'Select elements and pan the canvas to them, to show the person something.',
    inputSchema: obj({ ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['ids']),
  },

  // ── Design tokens ──
  {
    name: 'edit_color', title: 'Edit color variable', annotations: EDIT,
    description: 'Create, update or delete a color variable. Names are camelCase and unique (e.g. "primary", "surfaceMuted"). '
      + 'value sets the color in every theme; values sets it per theme by theme name ({"dark":"#111827","light":"#ffffff"}). alpha is 0–1. '
      + 'A gradient variable: gradient {"type":"linear|radial","angle":90,"stops":[{"color":"#…","pos":0},…]}.',
    inputSchema: obj({
      action: { type: 'string', enum: ['create', 'update', 'delete'] },
      id: str('For update/delete (or give name).'), name: str(), rename: str('New name, for update.'),
      value: str('Hex, for every theme.'), values: { type: 'object', description: 'Theme name → hex.' },
      alpha: num(), gradient: { type: 'object' },
    }, ['action']),
  },
  {
    name: 'edit_theme', title: 'Edit theme', annotations: EDIT,
    description: 'Create, rename or delete a theme (every color variable has a value per theme; a new theme starts as a copy of the active one), or switch which theme the canvas previews. At least one theme always remains.',
    inputSchema: obj({
      action: { type: 'string', enum: ['create', 'rename', 'delete', 'preview'] },
      name: str('The theme (for rename/delete/preview) or the new theme\'s name.'),
      rename: str(), brightness: { type: 'string', enum: ['dark', 'light'] },
    }, ['action', 'name']),
  },
  {
    name: 'set_color_role', title: 'Set color role', annotations: EDIT,
    description: 'Map a Material ColorScheme role to a color variable (or clear it with color null), for the generated ThemeData. Roles: primary, onPrimary, secondary, onSecondary, surface, onSurface, surfaceContainer, surfaceContainerHigh, error, onError, outline, outlineVariant.',
    inputSchema: obj({ role: str(), color: { type: ['string', 'null'], description: 'Color variable name.' } }, ['role', 'color']),
  },
  {
    name: 'edit_text_style', title: 'Edit text style', annotations: EDIT,
    description: 'Create, update or delete a text style (a typography variable text elements can use). Names are camelCase and unique (e.g. "headline", "bodySmall"). fontFamily is any Google Font. color is a color variable name.',
    inputSchema: obj({
      action: { type: 'string', enum: ['create', 'update', 'delete'] },
      id: str(), name: str(), rename: str(),
      fontFamily: str(), fontSize: num(), fontWeight: { type: 'string', enum: ['300', '400', '500', '600', '700'] },
      lineHeight: num('Multiplier, e.g. 1.4.'), letterSpacing: num('px'), color: { type: ['string', 'null'] },
    }, ['action']),
  },

  // ── Data ──
  {
    name: 'edit_model', title: 'Edit model', annotations: EDIT,
    description: 'Create, update or delete a data model (a Dart class). Names are PascalCase and unique across models and enums. '
      + 'fields replaces the whole field list: [{"name":"first_name","type":"String","required":true}]. Field names are snake_case. '
      + 'Types are Dart-style: String, int, double, bool, List<T>, Set<T>, Map<K, V>, or another model or enum name — e.g. "List<Address>", "Map<String, List<int>>".',
    inputSchema: obj({
      action: { type: 'string', enum: ['create', 'update', 'delete'] },
      id: str(), name: str(), rename: str(),
      fields: { type: 'array', items: obj({ name: str(), type: str(), required: bool() }, ['name', 'type']) },
    }, ['action']),
  },
  {
    name: 'edit_enum', title: 'Edit enum', annotations: EDIT,
    description: 'Create, update or delete an enum. Names are PascalCase; values are camelCase and unique. values replaces the whole list.',
    inputSchema: obj({
      action: { type: 'string', enum: ['create', 'update', 'delete'] },
      id: str(), name: str(), rename: str(),
      values: { type: 'array', items: { type: 'string' } },
    }, ['action']),
  },
  {
    name: 'edit_mock_data', title: 'Edit mock data', annotations: EDIT,
    description: 'Create, update, regenerate or delete a mock data set: instances of a model — one object, or a list of up to 50. '
      + 'Give "data" to write the values yourself: an object for kind single, a list of objects for kind list, keyed by the model\'s field names, with enum fields as the enum value\'s name and nested models as objects. '
      + 'Write data yourself whenever realistic values depend on meaning the field names don\'t carry (exercise names, product titles, prices that fit the item); '
      + 'without it, values are generated from field types and names, which suits only generic fields (emails, dates, ids). regenerate replaces the values with generated ones.',
    inputSchema: obj({
      action: { type: 'string', enum: ['create', 'update', 'regenerate', 'delete'] },
      id: str(), model: str('Model name.'), kind: { type: 'string', enum: ['single', 'list'] },
      count: { type: 'integer', minimum: 1, maximum: 50 }, name: str('Variable name, camelCase.'),
      data: { type: ['object', 'array'], description: 'The values: an object (single) or a list of objects (list).' },
    }, ['action']),
  },
  {
    name: 'edit_provider', title: 'Edit API provider', annotations: EDIT,
    description: 'Create, update or delete an API provider (a Riverpod provider grouping REST endpoints that share the base URL). Names are camelCase. '
      + 'endpoints replaces the whole list: [{"name":"getUser","method":"GET","version":"v1","route":"users/:id","params":{"page":"1"},"headers":{"Accept":"application/json"},"body":"","output":"User","output_type":"single"}]. '
      + 'output is a model name (or "json" for endpoints); output_type is single or list. base_url sets the shared API base URL. '
      + 'load names the endpoint the provider\'s build() returns (its state; the endpoint\'s output must match the provider\'s). preview names the mock set shown for the provider in the design tab (same model and single/list; default: the only matching set). '
      + 'A provider with a model output is a data source in the design like a mock set: bind, repeat and route on "<providerName>.<field>".',
    inputSchema: obj({
      action: { type: 'string', enum: ['create', 'update', 'delete'] },
      id: str(), name: str(), rename: str(),
      output: str('Model name for the provider\'s state.'), output_type: { type: 'string', enum: ['single', 'list'] },
      endpoints: { type: 'array', items: { type: 'object' } },
      base_url: str(),
      load: { type: ['string', 'null'], description: 'Endpoint name build() loads the state with.' },
      preview: { type: ['string', 'null'], description: 'Mock set name shown for this provider in the design.' },
    }, ['action']),
  },

  // ── Project ──
  {
    name: 'comments', title: 'Comments', annotations: EDIT,
    description: 'The project\'s comment threads: list them, start a thread pinned on an element (or at x/y), reply, or resolve/reopen. Comments are posted as the signed-in person.',
    inputSchema: obj({
      action: { type: 'string', enum: ['list', 'add', 'reply', 'resolve', 'reopen'] },
      thread_id: str(), element_id: str('Pin the new thread on this element.'), x: num(), y: num(), text: str(),
    }, ['action']),
  },
  {
    name: 'rename_project', title: 'Rename project', annotations: EDIT,
    description: 'Rename the project.',
    inputSchema: obj({ name: str() }, ['name']),
  },
  {
    name: 'undo', title: 'Undo / redo', annotations: EDIT,
    description: 'Undo (or redo) the last changes — the person\'s and yours share one history.',
    inputSchema: obj({ redo: bool(), steps: { type: 'integer', minimum: 1, maximum: 50 } }),
  },
  {
    name: 'export_code', title: 'Export code', annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'Generate the Flutter/Dart code (screens, routes, models, enums, providers, theme, typography) and download it as a zip, as the Export button does. Refuses while anything has a validation error, and says what.',
    inputSchema: obj({}),
  },
];

// ═════════════════════════════ Shared helpers ═══════════════════════════════

class ToolError extends Error {}
const fail = (summary) => { throw new ToolError(summary); };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isHex = (v) => /^#[0-9a-f]{3,8}$/i.test(v);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clone = (o) => JSON.parse(JSON.stringify(o));

function need(node, id) {
  if (!node) fail(`No element with id "${id}" — call get_design for current ids`);
  return node;
}

// "Login Page" → "login_page": screen and section names are Dart identifiers.
function snakeName(name) {
  const s = String(name || '').trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(s) ? 'screen_' + s : s;
}

// A color value → { hex } or { colorId }.
function colorRef(value, what) {
  if (typeof value !== 'string') fail(`${what} must be a hex color, "transparent" or "var:<color name>"`);
  const v = value.trim();
  if (v === 'transparent' || isHex(v)) return { hex: v };
  const name = v.startsWith('var:') ? v.slice(4) : v;
  const c = state.colors.find(c => c.name === name);
  if (!c) fail(`${what}: no color variable "${name}" (there are: ${state.colors.map(c => c.name).join(', ') || 'none'}) — or use a hex color`);
  return { colorId: c.id };
}

function box(v, what) {
  if (isNum(v)) return { t: v, r: v, b: v, l: v };
  if (Array.isArray(v) && v.length === 2 && v.every(isNum)) return { t: v[0], r: v[1], b: v[0], l: v[1] };
  if (v && typeof v === 'object' && ['t', 'r', 'b', 'l'].every(k => isNum(v[k]) || v[k] === undefined)) {
    return { t: v.t || 0, r: v.r || 0, b: v.b || 0, l: v.l || 0 };
  }
  fail(`${what} must be a number, [vertical, horizontal] or {t,r,b,l}`);
}

function gradientOf(g) {
  if (!g || !['linear', 'radial'].includes(g.type) || !Array.isArray(g.stops) || g.stops.length < 2) {
    fail('A gradient is {"type":"linear|radial","angle":90,"stops":[{"color":"#…","pos":0},{"color":"#…","pos":100}]} with at least two stops');
  }
  return {
    fillType: g.type,
    gradient: {
      angle: isNum(g.angle) ? g.angle : 90,
      stops: g.stops.map(s => {
        if (!isHex(s.color)) fail('Gradient stop colors must be hex');
        return { color: s.color, pos: isNum(s.pos) ? s.pos : 0, alpha: isNum(s.alpha) ? s.alpha : 1 };
      }),
    },
  };
}

// Where a new root item goes: right of everything on the canvas (or the viewport
// centre when it's empty).
function freeSpot(w, h) {
  const roots = state.nodes.filter(n => !n.parentId);
  if (!roots.length) {
    const c = canvasToWorld(canvasWrap.clientWidth / 2, canvasWrap.clientHeight / 2);
    return { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2) };
  }
  return {
    x: Math.round(Math.max(...roots.map(n => n.x + (n.w || 0))) + 80),
    y: Math.round(Math.min(...roots.map(n => n.y))),
  };
}

function panTo(node) {
  const wp = getWorldPos(node);
  state.panX = canvasWrap.clientWidth / 2 - (wp.x + node.w / 2) * state.zoom;
  state.panY = canvasWrap.clientHeight / 2 - (wp.y + node.h / 2) * state.zoom;
  applyTransform();
}

// Commit a change: one undo step, every view repainted, sent to collaborators.
function commit(selectIds) {
  if (selectIds) state.selected = new Set(selectIds);
  saveHistory();
  rerenderActive();
}

// ═════════════════════════════ Remote lookups ═══════════════════════════════

async function fetchIcon(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+:[a-z0-9-]+$/.test(id)) fail(`"${id}" isn't an Iconify id like "mdi:home" — use search_icons`);
  let svg;
  try {
    const res = await fetch(`${ICON_API}/${id.replace(':', '/')}.svg`);
    svg = await res.text();
    if (!res.ok || !svg.includes('<svg')) throw new Error();
  } catch { fail(`Couldn't load icon "${id}" — check the id with search_icons`); }
  return svg;
}

function svgAspect(svg) {
  const m = svg.match(/viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"/);
  if (m) { const w = parseFloat(m[1]), h = parseFloat(m[2]); if (w > 0 && h > 0) return w / h; }
  return 1;
}

// An image URL as a data URI (so it's uploaded with the project like any image),
// with its natural size. Falls back to the remote URL when it can't be read.
async function loadImage(url) {
  let src = url;
  try {
    const blob = await (await fetch(url)).blob();
    src = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch { /* keep the remote URL */ }
  const size = await new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
  return { src, size };
}

async function searchPhoto(query) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${IMAGE_API}?q=${encodeURIComponent(query)}&page_size=5&mature=false&filter_dead=false&category=photograph`);
      if (res.ok) {
        const data = await res.json();
        const hit = (data.results || [])[0];
        if (!hit) fail(`No stock photo found for "${query}" — try other words`);
        return hit.thumbnail || hit.url;
      }
      if (res.status !== 424 && res.status < 500) break;
    } catch (e) { if (e instanceof ToolError) throw e; }
    await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
  }
  fail('The stock photo service is busy — try again, or give an image "url"');
}

// ═════════════════════════════ Element properties ═══════════════════════════

// Keys handled by name (everything else must go through "props").
const SPEC_KEYS = new Set([
  'type', 'name', 'children', 'component_id', 'props', 'bind', 'showIf', 'repeat',
  'text', 'fontSize', 'fontWeight', 'color', 'textStyle',
  'fill', 'gradient', 'radius', 'padding', 'margin', 'gap', 'layout', 'align', 'valign',
  'width', 'height', 'size', 'x', 'y', 'opacity', 'rotation', 'flipH', 'flipV',
  'stroke', 'strokeWidth', 'strokeStyle', 'shadows', 'visible', 'locked', 'scroll',
  'fit', 'icon', 'url', 'search', 'route', 'initial', 'background',
]);
// Raw fields Claude must not set directly: identity, structure, and what other
// tools own (so the editor's invariants hold).
const MANAGED = new Set(['id', 'type', 'parentId', 'children', 'componentId', 'action', 'svg', 'src']);
const LAYOUTS = ['none', 'row', 'column', 'wrap', 'stack'];

// Apply element properties to a node. Async because icons and images are fetched.
async function applyProps(node, p) {
  const t = node.type;
  const unknown = Object.keys(p).filter(k => !SPEC_KEYS.has(k));
  if (unknown.length) fail(`Unknown propert${unknown.length === 1 ? 'y' : 'ies'} ${unknown.map(k => `"${k}"`).join(', ')} — use "props" for raw node fields`);
  const only = (key, types) => { if (p[key] !== undefined && !types.includes(t)) fail(`"${key}" doesn't apply to a ${t}`); };

  if (p.name !== undefined) {
    if (t === 'frame' || t === 'section') {
      const name = snakeName(p.name);
      const err = frameNameError(name);
      if (err) fail(`Name "${p.name}": ${err}`);
      // A screen's route is set once, when it's made; renaming leaves it (as in the panel).
      node.name = name;
    } else node.name = String(p.name);
  }

  // Text
  only('text', ['text']); only('textStyle', ['text']); only('fontSize', ['text']); only('fontWeight', ['text']);
  if (p.text !== undefined) node.text = String(p.text);
  if (p.textStyle !== undefined) {
    if (p.textStyle === null) node.typoId = null;
    else {
      const ty = state.typography.find(s => s.name === p.textStyle);
      if (!ty) fail(`No text style "${p.textStyle}" (there are: ${state.typography.map(s => s.name).join(', ') || 'none'})`);
      node.typoId = ty.id;
    }
  }
  // On a styled text, size and weight override the style (keeping its font and
  // color); on unstyled text they are its own. Same as the panel's controls.
  if (p.fontSize !== undefined) {
    if (!isNum(p.fontSize) || p.fontSize <= 0) fail('fontSize must be a positive number');
    if (node.typoId) node.fontSizeOverride = p.fontSize; else node.fontSize = p.fontSize;
  }
  if (p.fontWeight !== undefined) {
    const w = String(p.fontWeight);
    if (!TEXT_WEIGHTS.includes(w)) fail(`fontWeight is one of ${TEXT_WEIGHTS.join(', ')}`);
    if (node.typoId) node.fontWeightOverride = w; else node.fontWeight = w;
  }
  if (p.color !== undefined) {
    if (t === 'text') {
      const c = colorRef(p.color, 'color');
      if (c.colorId) node.colorId = c.colorId;
      else if (node.typoId) fail('Styled text is recolored with a color variable ("var:<name>"); a hex color only applies to text without a text style');
      else { node.color = c.hex; node.colorId = null; }
    } else if (t === 'icon') {
      const c = colorRef(p.color, 'color');
      if (!c.colorId) fail('Icons are tinted by a color variable only — give "var:<color name>" (create one with edit_color if needed)');
      node.colorId = c.colorId;
    } else fail(`"color" is for text and icons; use "fill" for a ${t}`);
  }

  // Fill
  const fillValue = p.fill !== undefined ? p.fill : p.background;
  if (fillValue !== undefined) {
    if (t === 'section' || t === 'text' || t === 'icon') fail(`A ${t} has no fill`);
    if (fillValue && typeof fillValue === 'object') Object.assign(node, gradientOf(fillValue), { colorId: null });
    else {
      const c = colorRef(fillValue, 'fill');
      if (c.colorId) node.colorId = c.colorId;
      else { node.fill = c.hex; node.colorId = null; node.fillType = 'solid'; }
    }
  }
  if (p.gradient !== undefined) Object.assign(node, gradientOf(p.gradient), { colorId: null });

  // Stroke
  if (p.stroke !== undefined) {
    const c = colorRef(p.stroke, 'stroke');
    if (c.colorId) node.strokeColorId = c.colorId;
    else { node.stroke = c.hex; node.strokeColorId = null; }
    if (!node.strokeW && p.strokeWidth === undefined) node.strokeW = 1;
  }
  if (p.strokeWidth !== undefined) node.strokeW = Math.max(0, +p.strokeWidth || 0);
  if (p.strokeStyle !== undefined) {
    if (!['solid', 'dashed', 'dotted'].includes(p.strokeStyle)) fail('strokeStyle is solid, dashed or dotted');
    node.strokeStyle = p.strokeStyle;
  }

  // Shape
  if (p.radius !== undefined) {
    if (isNum(p.radius)) { node.radius = Math.max(0, p.radius); node.radiusMode = 'uniform'; }
    else if (p.radius && typeof p.radius === 'object') {
      node.radii = { tl: +p.radius.tl || 0, tr: +p.radius.tr || 0, br: +p.radius.br || 0, bl: +p.radius.bl || 0 };
      node.radiusMode = 'corners';
    } else fail('radius is a number or {tl,tr,br,bl}');
  }
  if (p.shadows !== undefined) {
    if (!Array.isArray(p.shadows)) fail('shadows is a list of {x,y,blur,spread,color,alpha}');
    node.shadows = p.shadows.map(s => {
      let colorId = null;
      if (s.color) {
        const c = colorRef(s.color, 'shadow color');
        if (!c.colorId) fail('Shadow colors are color variables ("var:<name>"); leave color out for black');
        colorId = c.colorId;
      }
      return { x: +s.x || 0, y: +s.y || 0, blur: +s.blur || 0, spread: +s.spread || 0, colorId, alpha: isNum(s.alpha) ? s.alpha : 0.25 };
    });
  }

  // Layout
  if (p.layout !== undefined) {
    if (!LAYOUTS.includes(p.layout)) fail(`layout is one of ${LAYOUTS.join(', ')}`);
    if (!['frame', 'container'].includes(t)) fail(`Only screens and containers take a layout, not a ${t}`);
    if (p.layout === 'none' && (node.children || []).length > 1) fail('Layout "none" holds one child; this has more — use column, row, wrap or stack');
    node.layout = p.layout;
  }
  if (p.gap !== undefined) { if (!isNum(p.gap)) fail('gap must be a number'); node.gap = node.gapH = node.gapV = p.gap; }
  if (p.padding !== undefined) { if (t === 'image') fail('An image has no padding'); node.padding = box(p.padding, 'padding'); }
  if (p.margin !== undefined) node.margin = box(p.margin, 'margin');
  if (p.align !== undefined || p.valign !== undefined) {
    const h = p.align === undefined ? (node.alignment || {}).h || 'left' : p.align;
    const v = p.valign === undefined ? (node.alignment || {}).v || 'top' : p.valign;
    if (!['left', 'center', 'right'].includes(h)) fail('align is left, center or right (children of a column already fill its width)');
    if (!['top', 'center', 'bottom'].includes(v)) fail('valign is top, center or bottom');
    node.alignment = { h, v };
  }
  if (p.scroll !== undefined) node.scroll = !!p.scroll;

  // Mock data: checked against what's in scope for this node (the mock sets, and
  // the item of every enclosing repeat).
  if (p.repeat !== undefined) {
    if (p.repeat === null) delete node.repeat;
    else {
      if (!canRepeat(node)) fail('Only a container (or screen) with a row, column or wrap layout can repeat — set its layout first');
      const src = p.repeat && p.repeat.source;
      const err = pathError(scopeFor(node), src, 'list');
      if (err) fail(`repeat.source: ${err}`);
      const as = p.repeat.as || 'item';
      if (!/^[a-z][A-Za-z0-9_]*$/.test(as)) fail('repeat.as is a lowerCamel name, e.g. "item" or "exercise"');
      if (state.mockSets.some(m => m.name === as)) fail(`repeat.as "${as}" would hide the mock set of that name — pick another`);
      node.repeat = { source: src, as };
    }
  }
  if (p.bind !== undefined) {
    if (p.bind === null) delete node.bind;
    else {
      if (typeof p.bind !== 'object' || Array.isArray(p.bind)) fail('bind is an object: { text, src, fill, color }');
      const scope = scopeFor(node);
      const allowed = { text: ['text'], color: ['text'], src: ['image'], fill: ['container', 'image', 'frame'] };
      const next = { ...(node.bind || {}) };
      for (const [slot, path] of Object.entries(p.bind)) {
        if (!allowed[slot]) fail(`bind has text, src, fill and color — not "${slot}"`);
        if (!allowed[slot].includes(t)) fail(`bind.${slot} doesn't apply to a ${t}`);
        if (path === null || path === '') { delete next[slot]; continue; }
        const err = pathError(scope, path, slot);
        if (err) fail(`bind.${slot}: ${err}`);
        next[slot] = path;
      }
      if (Object.keys(next).length) node.bind = next; else delete node.bind;
    }
  }
  if (p.showIf !== undefined) {
    if (p.showIf === null) delete node.showIf;
    else {
      if (t === 'frame' && !node.parentId) fail('A screen is always there; put the condition on what\'s inside it');
      const err = condError(scopeFor(node), p.showIf);
      if (err) fail(`showIf: ${err}`);
      const { path, op, value } = p.showIf;
      node.showIf = { path, op, value: value === undefined ? '' : value };
    }
  }

  // Size and position
  const size = (axis, v) => {
    const mode = axis === 'w' ? 'wMode' : 'hMode';
    if (v === 'fill' || v === 'hug') {
      node[mode] = v;
      if (t === 'text' && axis === 'w') node.autoSize = v === 'hug';
    } else if (isNum(v) && v > 0) {
      node[axis] = v; node[mode] = 'fixed';
      if (t === 'text' && axis === 'w') node.autoSize = false;
      // A frame's height only changes how far it scrolls; the device screen stays,
      // unless the frame gets shorter than it.
      if (t === 'frame' && axis === 'h' && (!node.screenH || node.screenH > v)) node.screenH = v;
    } else fail(`${axis === 'w' ? 'width' : 'height'} is a px number, "fill" or "hug"`);
  };
  if (p.height !== undefined && t === 'text') fail('A text\'s height follows its content — set fontSize, or wrap it in a container with a height');
  if (p.width !== undefined) size('w', p.width);
  if (p.height !== undefined) size('h', p.height);
  if (p.size !== undefined) { if (!isNum(p.size)) fail('size must be a number'); size('h', p.size); size('w', p.size); }
  // Only free-positioned elements have a position; the rest are laid out.
  if ((p.x !== undefined || p.y !== undefined) && node.parentId && !isStack(getNode(node.parentId))) {
    fail(`x/y only position elements in a stack, a section, or on the canvas — "${getNode(node.parentId).name}" lays out its children (use index, gap, padding or align)`);
  }
  if (p.x !== undefined) { if (!isNum(p.x)) fail('x must be a number'); node.x = p.x; }
  if (p.y !== undefined) { if (!isNum(p.y)) fail('y must be a number'); node.y = p.y; }

  // Appearance
  if (p.opacity !== undefined) { if (!isNum(p.opacity)) fail('opacity is 0–1'); node.opacity = Math.min(1, Math.max(0, p.opacity)); }
  if (p.rotation !== undefined) { if (!isNum(p.rotation)) fail('rotation is degrees'); node.rotation = ((p.rotation % 360) + 360) % 360; }
  if (p.flipH !== undefined) node.flipH = !!p.flipH;
  if (p.flipV !== undefined) node.flipV = !!p.flipV;
  if (p.visible !== undefined) node.visible = !!p.visible;
  if (p.locked !== undefined) node.locked = !!p.locked;

  // Screens
  only('route', ['frame']); only('initial', ['frame']);
  if (p.route !== undefined) {
    const err = routeError(p.route);
    if (err) fail(`Route "${p.route}": ${err}`);
    node.routePath = String(p.route).trim();
  }
  if (p.initial !== undefined) {
    if (p.initial) state.nodes.forEach(n => { if (n.type === 'frame') n.isInitial = n.id === node.id; });
    else node.isInitial = false;
  }

  // Icons and images
  only('icon', ['icon']); only('url', ['image']); only('search', ['image']); only('fit', ['image']);
  if (p.icon !== undefined) {
    const svg = await fetchIcon(p.icon);
    node.svg = svg; node.iconId = p.icon;
    if (p.size === undefined && p.width === undefined) node.w = Math.max(8, Math.round(node.h * svgAspect(svg)));
  }
  if (p.fit !== undefined) {
    if (!['cover', 'contain', 'fill'].includes(p.fit)) fail('fit is cover, contain or fill');
    node.fit = p.fit;
  }
  if (p.url !== undefined || p.search !== undefined) {
    const url = p.url !== undefined ? String(p.url) : await searchPhoto(String(p.search));
    const { src, size } = await loadImage(url);
    node.src = src;
    node.fill = 'transparent';
    // Keep the photo's proportions for whichever side wasn't given.
    if (size && size.w && size.h) {
      if (p.height === undefined && node.wMode === 'fixed' && p.width !== undefined) node.h = Math.round(node.w * size.h / size.w);
      if (p.width === undefined && node.wMode === 'fixed' && node.hMode === 'fixed') node.w = Math.round(node.h * size.w / size.h);
    }
  }

  // Raw fields — anything else the editor stores on a node.
  if (p.props !== undefined) {
    if (!p.props || typeof p.props !== 'object' || Array.isArray(p.props)) fail('"props" is an object of raw node fields');
    for (const [key, value] of Object.entries(p.props)) {
      if (MANAGED.has(key)) fail(`"${key}" can't be set directly — ${key === 'action' ? 'use set_interaction' : key === 'svg' ? 'use "icon"' : key === 'src' ? 'use "url" or "search"' : 'the editor manages it'}`);
      if (!(key in node) || !fieldApplies(t, key)) fail(`A ${t} has no field "${key}" — see get_element`);
      const current = node[key];
      if (current !== null && value !== null && typeof current !== typeof value) fail(`"${key}" is a ${typeof current}, not a ${typeof value}`);
      node[key] = clone(value);
    }
  }
}

// ═════════════════════════════ Building elements ════════════════════════════

const CONTAINER_LIKE = ['container', 'row', 'column', 'wrap', 'stack'];

// Build one element (and its children) under `parent` (null = the canvas).
// Returns the created root node; `made` counts every node created.
async function build(spec, parent, index, made) {
  if (!spec || typeof spec !== 'object') fail('Each element must be an object with a "type"');
  let type = spec.type;
  // Children of anything but a stack or section are laid out by their parent.
  // Down a column they fill its width; along a row (or wrap) they fit their
  // content, and share the row only when given width "fill".
  const inFlow = !!parent && !isStack(parent);
  const across = inFlow && ['row', 'wrap'].includes(flexKind(parent));
  const fillW = inFlow && !across;
  if (type === 'section') fail('Sections are made with create_section');
  if (type === 'frame' && !parent) fail('Top-level screens are made with create_screen');
  if (parent && !canAcceptChild(parent, null, type === 'button' ? 'container' : type)) {
    fail(parent.type === 'section' ? 'A section holds only screens'
      : `"${parent.name}" (layout "none") already holds its one child — give it a column/row/wrap/stack layout to hold more`);
  }

  let node;
  const at = (w, h) => {
    if (parent) return { x: 0, y: 0 };
    const s = freeSpot(w, h);
    return { x: isNum(spec.x) ? spec.x : s.x, y: isNum(spec.y) ? spec.y : s.y };
  };
  const place = (n) => {
    state.nodes.push(n);
    if (parent) {
      if (Number.isInteger(index)) parent.children.splice(Math.min(index, parent.children.length), 0, n.id);
      else parent.children.push(n.id);
    }
    made.count++;
  };

  if (type === 'instance') {
    const comp = getComponent(spec.component_id);
    if (!comp) fail(`No component "${spec.component_id}" — see get_design for component ids`);
    const master = getNode(comp.rootId);
    const { x, y } = at(master ? master.w : 100, master ? master.h : 100);
    node = {
      id: nextNodeId(), type: 'instance', componentId: comp.id, x, y,
      w: master ? master.w : 100, h: master ? master.h : 100, parentId: parent ? parent.id : null,
      visible: true, locked: false, name: comp.name, opacity: 1, rotation: 0, flipH: false, flipV: false,
      wMode: 'fixed', hMode: 'fixed', action: { type: 'none', targetFrameId: null, mode: 'push', transition: 'platform' },
    };
    place(node);
    const { name, x: _x, y: _y, opacity, visible, locked } = spec;
    await applyProps(node, Object.fromEntries(Object.entries({ name, x: _x, y: _y, opacity, visible, locked }).filter(([, v]) => v !== undefined)));
    return node;
  }

  if (type === 'button') {
    const { text, color, fontSize, fontWeight, textStyle, type: _t, ...rest } = spec;
    const c = makeNode('container', 0, 0, 200, 48, parent ? parent.id : null);
    Object.assign(c, at(200, 48));
    c.layout = 'none';
    c.alignment = { h: 'center', v: 'center' };
    c.colorId = null; c.fill = '#2563eb'; c.radius = 10;
    c.padding = { t: 12, r: 16, b: 12, l: 16 };
    if (inFlow) { c.wMode = fillW ? 'fill' : 'hug'; c.hMode = 'hug'; }
    place(c);
    await applyProps(c, { name: 'Button', ...rest });
    const label = makeNode('text', 0, 0, 100, 20, c.id);
    label.text = 'Button'; label.color = '#ffffff'; label.fontWeight = '600'; label.fontSize = 15;
    label.typoId = null; label.autoSize = true;
    state.nodes.push(label); c.children.push(label.id); made.count++;
    await applyProps(label, Object.fromEntries(Object.entries({ text, color, fontSize, fontWeight, textStyle }).filter(([, v]) => v !== undefined)));
    return c;
  }

  // Legacy row/column/wrap/stack types → a container with that layout, as the UI makes them.
  let props = { ...spec };
  delete props.type; delete props.children;
  if (['row', 'column', 'wrap', 'stack'].includes(type)) { props.layout = props.layout || type; type = 'container'; }
  if (!['frame', 'container', 'text', 'image', 'icon'].includes(type)) {
    fail(`Unknown element type "${spec.type}" — container, text, image, icon, button, instance (or frame, nested)`);
  }

  const dims = { frame: [DEVICE.w, 200], container: [200, 120], text: [200, 24], image: [200, 180], icon: [24, 24] }[type];
  node = makeNode(type, 0, 0, dims[0], dims[1], parent ? parent.id : null);
  Object.assign(node, at(dims[0], dims[1]));

  // Defaults that match what the canvas makes, fitted to the parent's layout.
  if (type === 'container' || type === 'frame') {
    node.layout = 'column'; node.gap = node.gapH = node.gapV = 12;
    node.colorId = null; node.fill = 'transparent';
    if (inFlow) { node.wMode = fillW ? 'fill' : 'hug'; node.hMode = 'hug'; }
    if (!('height' in spec) && !inFlow) node.hMode = 'hug';
  }
  if (type === 'text') {
    node.text = 'Text'; node.color = '#111827'; node.fontSize = 16; node.typoId = null;
    if (fillW) { node.autoSize = false; node.wMode = 'fill'; node.hMode = 'hug'; }
  }
  if (type === 'image') {
    node.colorId = null; node.fill = '#e5e7eb'; node.radius = 8;
    if (fillW) { node.wMode = 'fill'; node.hMode = 'fixed'; }
  }
  if (type === 'icon' && !props.icon) fail('An icon element needs "icon", an Iconify id like "mdi:home" (see search_icons)');

  place(node);
  await applyProps(node, props);
  for (const child of spec.children || []) await build(child, node, undefined, made);
  return node;
}

// ═════════════════════════════ Reading ══════════════════════════════════════

function fillOf(node) {
  if (node.colorId) { const c = getColorById(node.colorId); if (c) return `var:${c.name}`; }
  if (node.fillType === 'linear' || node.fillType === 'radial') return { type: node.fillType, ...node.gradient };
  return node.fill;
}

function describe(node) {
  const out = { id: node.id, type: node.type, name: node.name };
  const t = node.type;
  if (t === 'frame') {
    Object.assign(out, { screen: isScreenFrame(node), route: node.routePath || routeFromName(node.name), size: [node.w, node.h] });
    if (node.isInitial) out.initial = true;
  }
  if (t === 'text') {
    out.text = node.text;
    const typo = node.typoId && getTypoById(node.typoId);
    if (typo) {
      out.textStyle = typo.name;
      if (node.fontSizeOverride != null) out.fontSize = node.fontSizeOverride;
      if (node.fontWeightOverride) out.fontWeight = node.fontWeightOverride;
    } else Object.assign(out, { fontSize: node.fontSize, fontWeight: node.fontWeight, color: node.color });
    const c = node.colorId && getColorById(node.colorId);
    if (c) out.color = `var:${c.name}`;
  } else if (t === 'icon') {
    out.icon = node.iconId;
    const c = node.colorId && getColorById(node.colorId);
    if (c) out.color = `var:${c.name}`;
  } else if (t === 'instance') {
    out.component_id = node.componentId;
  } else if (t !== 'section') {
    const fill = fillOf(node);
    if (fill && fill !== 'transparent') out.fill = fill;
    if (node.radius) out.radius = node.radius;
    if (t === 'image') out.image = node.src ? 'photo' : 'placeholder';
  }
  if ((t === 'frame' || t === 'container') && node.layout) out.layout = node.layout;
  if (isMaster(node)) out.component_id = node.componentId;
  if (node.action && node.action.type !== 'none') {
    out.onTap = node.action.type === 'back' ? 'back'
      : { navigate: node.action.targetFrameId, mode: node.action.mode, transition: node.action.transition };
    if (node.action.routes && node.action.routes.length) out.onTap.routes = node.action.routes;
  }
  if (node.bind) out.bind = node.bind;
  if (node.showIf) out.showIf = node.showIf;
  if (node.repeat) out.repeat = node.repeat;
  if (node.visible === false) out.hidden = true;
  const kids = (node.children || []).map(getNode).filter(Boolean);
  if (kids.length) out.children = kids.map(describe);
  return out;
}

function getDesign() {
  const roots = state.nodes.filter(n => !n.parentId)
    .sort((a, b) => (a.type === 'section' ? 0 : 1) - (b.type === 'section' ? 0 : 1));
  const screens = state.nodes.filter(isScreenFrame).length;
  return {
    ok: true,
    summary: `${state.projectName}: ${plural(screens, 'screen')}`,
    project: state.projectName,
    canvas: roots.map(describe),
    components: state.components.map(c => ({ id: c.id, name: componentName(c), master_id: c.rootId, instances: instancesOf(c.id).length })),
  };
}

function getElement({ id }) {
  const node = need(getNode(id), id);
  const raw = clone(node);
  if (raw.svg) raw.svg = `<svg … ${raw.svg.length} chars>`;
  if (typeof raw.src === 'string' && raw.src.startsWith('data:')) raw.src = `<image data, ${raw.src.length} chars>`;
  return { ok: true, summary: `${node.name} (${node.type})`, element: raw };
}

function getData() {
  const themeName = (id) => (state.themes.find(t => t.id === id) || {}).name;
  const colorName = (id) => (getColorById(id) || {}).name || null;
  return {
    ok: true,
    summary: `${plural(state.colors.length, 'color')}, ${plural(state.typography.length, 'text style')}, ${plural(state.models.length, 'model')}, ${plural(state.providers.length, 'provider')}`,
    themes: state.themes.map(t => ({ name: t.name, brightness: t.brightness, previewing: t.id === state.activeThemeId })),
    colors: state.colors.map(c => ({
      id: c.id, name: c.name,
      values: Object.fromEntries(Object.entries(c.values || {}).map(([tid, v]) => [themeName(tid),
        v.fillType === 'solid' ? (v.alpha != null && v.alpha < 1 ? { hex: v.fill, alpha: v.alpha } : v.fill) : { type: v.fillType, ...v.gradient }])),
    })),
    colorRoles: Object.fromEntries(Object.entries(state.colorRoles || {}).filter(([, v]) => v).map(([k, v]) => [k, colorName(v)])),
    textStyles: state.typography.map(t => ({
      id: t.id, name: t.name, fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight,
      lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, color: colorName(t.colorId),
    })),
    models: state.models.map(m => ({
      id: m.id, name: m.name,
      fields: m.properties.map(p => ({ name: p.name, type: typeToString(p.type), required: p.required !== false })),
    })),
    enums: state.enums.map(e => ({ id: e.id, name: e.name, values: e.values.map(v => v.name) })),
    mockData: state.mockSets.map(s => ({
      id: s.id, name: s.name, model: (state.models.find(m => m.id === s.modelId) || {}).name, kind: s.kind, count: s.count,
    })),
    apiBaseUrl: state.apiBaseUrl,
    providers: state.providers.map(p => ({
      id: p.id, name: p.name, output: p.output.model, output_type: p.output.type,
      load: (p.apis.find(a => a.id === p.load) || {}).name || null,
      preview: (providerPreview(p) || {}).name || null,
      endpoints: p.apis.map(a => ({
        id: a.id, name: a.name, method: a.method, version: a.version, route: a.route,
        params: Object.fromEntries((a.params || []).map(x => [x.key, x.value])),
        headers: Object.fromEntries(a.headers.map(x => [x.key, x.value])),
        body: a.body, output: a.output.model, output_type: a.output.type,
      })),
    })),
  };
}

// ═════════════════════════════ Canvas tools ═════════════════════════════════

async function createScreen(args) {
  const section = args.section_id ? need(getNode(args.section_id), args.section_id) : null;
  if (section && section.type !== 'section') fail(`"${section.name}" is a ${section.type}, not a section`);
  const w = isNum(args.width) ? args.width : DEVICE.w;
  // The device screen, and the frame — which may run taller than it (scrolling).
  const screenH = isNum(args.screen_height) ? args.screen_height : DEVICE.h;
  const h = isNum(args.height) ? Math.max(args.height, 1) : screenH;

  let x, y;
  if (section) {
    // Right of the section's screens, growing the section to fit.
    const kids = section.children.map(getNode).filter(Boolean);
    x = kids.length ? Math.max(...kids.map(k => k.x + k.w)) + 60 : 60;
    y = kids.length ? Math.min(...kids.map(k => k.y)) : 60;
    section.w = Math.max(section.w, x + w + 60);
    section.h = Math.max(section.h, y + h + 60);
  } else ({ x, y } = freeSpot(w, h));

  const frame = makeNode('frame', x, y, w, h, section ? section.id : null);
  frame.screenH = Math.min(screenH, h); // a frame shorter than the screen is a shorter device
  frame.layout = 'column'; frame.gap = frame.gapH = frame.gapV = 12;
  frame.padding = { t: 20, r: 20, b: 20, l: 20 };
  frame.colorId = null; frame.fill = '#ffffff';
  state.nodes.push(frame);
  if (section) section.children.push(frame.id);

  const made = { count: 0 };
  try {
    const { children, section_id, width, height, screen_height, ...props } = args;
    await applyProps(frame, props);
    if (args.route === undefined) frame.routePath = routeFromName(frame.name);
    for (const child of children || []) await build(child, frame, undefined, made);
  } catch (e) {
    removeTree(frame.id);
    throw e;
  }
  commit([frame.id]);
  panTo(frame);
  finalizeImages();
  return withChecks({ ok: true, summary: `Added screen "${frame.name}" with ${plural(made.count, 'element')}`, id: frame.id }, [frame]);
}

function createSection(args) {
  const frames = (args.frame_ids || []).map(id => need(getNode(id), id));
  frames.forEach(f => { if (!isScreenFrame(f) || f.parentId) fail(`"${f.name}" isn't a screen on the canvas — only root screens move into a new section`); });

  let x, y, w, h;
  if (frames.length) {
    const pad = 60;
    x = Math.min(...frames.map(f => f.x)) - pad;
    y = Math.min(...frames.map(f => f.y)) - pad;
    w = Math.max(...frames.map(f => f.x + f.w)) + pad - x;
    h = Math.max(...frames.map(f => f.y + f.h)) + pad - y;
  } else {
    w = isNum(args.width) ? args.width : 1000;
    h = isNum(args.height) ? args.height : 1000;
    ({ x, y } = freeSpot(w, h));
  }
  const section = makeNode('section', x, y, w, h, null);
  if (args.name !== undefined) {
    const name = snakeName(args.name);
    const err = frameNameError(name);
    if (err) fail(`Name "${args.name}": ${err}`);
    section.name = name;
  }
  // Sections paint behind frames; put it first so it's behind in the layers too.
  state.nodes.unshift(section);
  frames.forEach(f => reparentNode(f, section.id));
  commit([section.id]);
  panTo(section);
  return { ok: true, summary: `Added section "${section.name}"${frames.length ? ` with ${plural(frames.length, 'screen')}` : ''}`, id: section.id };
}

async function addElements(args) {
  const parent = args.parent_id ? need(getNode(args.parent_id), args.parent_id) : null;
  if (parent && !CONTAINER_TYPES.includes(parent.type)) fail(`"${parent.name}" is a ${parent.type} and can't hold elements`);
  if (!Array.isArray(args.elements) || !args.elements.length) fail('add_elements needs a non-empty "elements" list');
  const made = { count: 0 };
  const roots = [];
  let index = Number.isInteger(args.index) ? args.index : undefined;
  try {
    for (const spec of args.elements) {
      roots.push(await build(spec, parent, index, made));
      if (index !== undefined) index++;
    }
  } catch (e) {
    roots.forEach(n => removeTree(n.id));
    throw e;
  }
  commit(roots.map(n => n.id));
  finalizeImages();
  return withChecks({
    ok: true,
    summary: `Added ${plural(made.count, 'element')}${parent ? ` to "${parent.name}"` : ' to the canvas'}`,
    ids: roots.map(n => n.id),
  }, roots);
}

async function updateElement({ id, properties }) {
  const node = need(getNode(id), id);
  if (!properties || typeof properties !== 'object' || !Object.keys(properties).length) fail('Give at least one property to change');
  const before = clone(node);
  try {
    await applyProps(node, properties);
  } catch (e) {
    Object.assign(node, before);
    throw e;
  }
  commit();
  finalizeImages();
  return withChecks({ ok: true, summary: `Updated "${node.name}" (${Object.keys(properties).join(', ')})` }, [node]);
}

function moveElement(args) {
  const node = need(getNode(args.id), args.id);
  const moving = args.parent_id !== undefined && (args.parent_id || null) !== (node.parentId || null);
  if (moving) {
    const parent = args.parent_id ? need(getNode(args.parent_id), args.parent_id) : null;
    if (parent) {
      if (parent.id === node.id || isDescendant(parent.id, node.id)) fail('Can\'t move an element into itself');
      if (!canAcceptChild(parent, node.id)) {
        fail(node.type === 'section' ? 'Sections stay on the canvas'
          : parent.type === 'section' ? 'A section holds only screens'
          : CONTAINER_TYPES.includes(parent.type) ? `"${parent.name}" (layout "none") already holds its one child`
          : `"${parent.name}" is a ${parent.type} and can't hold elements`);
      }
    }
    // Keeps the element's on-screen spot, as dragging it does.
    reparentNode(node, parent ? parent.id : null);
  }
  if (Number.isInteger(args.index) && node.parentId) {
    const p = getNode(node.parentId);
    p.children = p.children.filter(c => c !== node.id);
    p.children.splice(Math.min(args.index, p.children.length), 0, node.id);
  }
  if ((isNum(args.x) || isNum(args.y)) && node.parentId && !isStack(getNode(node.parentId))) {
    fail(`x/y only position elements in a stack, a section, or on the canvas — "${getNode(node.parentId).name}" lays out its children (use index)`);
  }
  if (isNum(args.x)) node.x = args.x;
  if (isNum(args.y)) node.y = args.y;
  if (!moving && !Number.isInteger(args.index) && !isNum(args.x) && !isNum(args.y)) fail('Give parent_id, index, or x/y');
  commit([node.id]);
  const where = node.parentId ? `into "${getNode(node.parentId).name}"` : 'on the canvas';
  return withChecks({ ok: true, summary: `Moved "${node.name}" ${where}` }, [node]);
}

function duplicateElements({ ids }) {
  const nodes = ids.map(id => need(getNode(id), id));
  const copies = nodes.map(n => {
    const copy = cloneNodeInPlace(n);
    if (!copy) fail(`"${n.name}" can't be duplicated`);
    // Laid-out parents place the copy themselves (after the original's siblings);
    // on the canvas it goes beside the original, in a stack or section just offset.
    const parent = copy.parentId && getNode(copy.parentId);
    if (!parent) copy.x += n.w + 80;
    else if (isStack(parent)) { copy.x += 20; copy.y += 20; }
    if (!isInstance(copy)) copy.name = n.name + (n.type === 'frame' || n.type === 'section' ? '_copy' : ' copy');
    if (copy.type === 'frame') { copy.routePath = routeFromName(copy.name); copy.isInitial = false; }
    return copy;
  });
  commit(copies.map(c => c.id));
  return { ok: true, summary: `Duplicated ${plural(copies.length, 'element')}`, ids: copies.map(c => c.id) };
}

// Remove a node and its subtree (also used to roll back a failed build).
function removeTree(id) {
  const doomed = new Set();
  const collect = (nid) => {
    doomed.add(nid);
    const n = getNode(nid);
    if (n && n.children) n.children.forEach(collect);
  };
  collect(id);
  // A master going away: its instances elsewhere become plain copies first.
  detachInstancesOf(state.components.filter(c => doomed.has(c.rootId)).map(c => c.id), doomed);
  const n = getNode(id);
  const parent = n && n.parentId && getNode(n.parentId);
  if (parent) parent.children = parent.children.filter(c => c !== id);
  state.nodes = state.nodes.filter(x => !doomed.has(x.id));
  state.components = state.components.filter(c => !doomed.has(c.rootId));
  // Navigation that pointed at a removed screen goes nowhere now.
  state.nodes.forEach(x => { if (x.action && doomed.has(x.action.targetFrameId)) x.action = { ...x.action, type: 'none', targetFrameId: null }; });
  return doomed.size;
}

function deleteElements({ ids }) {
  ids.forEach(id => need(getNode(id), id));
  let count = 0;
  ids.forEach(id => { if (getNode(id)) count += removeTree(id); });
  state.selected.clear();
  commit();
  return { ok: true, summary: `Deleted ${plural(count, 'element')}` };
}

function makeComponent({ id, name }) {
  const node = need(getNode(id), id);
  if (isInstance(node)) fail('That\'s already an instance of a component');
  if (isMaster(node)) fail('That\'s already a component');
  if (!canBeComponent(node)) fail('Screens, sections, and elements containing them can\'t be components');
  const cid = 'cmp' + (state.nextComponentId++);
  if (name) node.name = String(name);
  node.componentId = cid;
  state.components.push({ id: cid, name: node.name || 'Component', rootId: node.id });
  commit([node.id]);
  return { ok: true, summary: `Made "${node.name}" a component — place copies with add_elements {"type":"instance","component_id":"${cid}"}`, component_id: cid };
}

function editComponent(args) {
  if (args.action === 'rename') {
    const c = getComponent(args.component_id);
    if (!c) fail(`No component "${args.component_id}" — see get_design for component ids`);
    if (!args.name || !String(args.name).trim()) fail('A component needs a name');
    renameComponent(c.id, args.name);
    commit();
    return { ok: true, summary: `Renamed the component to "${componentName(c)}"` };
  }
  const inst = need(getNode(args.id), args.id);
  if (inst.type !== 'instance') fail(`"${inst.name}" isn't an instance`);
  const copy = detachInstance(inst);
  if (!copy) fail('Its component was deleted — there\'s no design to detach');
  commit([copy.id]);
  return withChecks({ ok: true, summary: `Detached "${copy.name}" — it's a regular copy now`, id: copy.id }, [copy]);
}

function setInteraction(args) {
  const node = need(getNode(args.id), args.id);
  if (node.type === 'section') fail('A section can\'t be tapped');
  const mode = args.mode || 'push';
  const transition = args.transition || 'platform';
  if (args.action === 'navigate') {
    const screen = (id) => {
      const s = need(getNode(id), id);
      if (!isScreenFrame(s)) fail(`"${s.name}" isn't a screen`);
      return s.id;
    };
    const routes = (args.routes || []).map((r, i) => {
      if (!r || typeof r !== 'object') fail(`routes[${i}] is { when, target_screen_id }`);
      const err = condError(scopeFor(node), r.when);
      if (err) fail(`routes[${i}].when: ${err}`);
      return { when: { path: r.when.path, op: r.when.op, value: r.when.value === undefined ? '' : r.when.value }, target: screen(r.target_screen_id) };
    });
    if (!args.target_screen_id && !routes.length) fail('navigate needs target_screen_id, routes, or both');
    node.action = { type: 'navigate', targetFrameId: args.target_screen_id ? screen(args.target_screen_id) : null, mode, transition };
    if (routes.length) node.action.routes = routes;
  } else if (args.action === 'back') node.action = { type: 'back', targetFrameId: null, mode, transition };
  else node.action = { type: 'none', targetFrameId: null, mode: 'push', transition: 'platform' };
  commit([node.id]);
  const routed = node.action.routes ? ` (${plural(node.action.routes.length, 'conditional route')} first)` : '';
  const what = args.action === 'navigate'
    ? (node.action.targetFrameId ? `goes to "${getNode(node.action.targetFrameId).name}"${routed}` : `follows ${plural(node.action.routes.length, 'conditional route')}`)
    : args.action === 'back' ? 'goes back' : 'does nothing';
  return { ok: true, summary: `Tapping "${node.name}" ${what}` };
}

async function searchIcons({ query, limit }) {
  let data;
  try {
    const res = await fetch(`${ICON_API}/search?query=${encodeURIComponent(query)}&limit=${Math.min(limit || 24, 60)}`);
    data = await res.json();
  } catch { fail('Couldn\'t reach the icon service'); }
  // Iconify returns at least 32; keep what was asked for.
  const icons = (data.icons || []).slice(0, limit || 24);
  return { ok: true, summary: `${plural(icons.length, 'icon')} for "${query}"`, icons };
}

function focus({ ids }) {
  const nodes = ids.map(id => need(getNode(id), id));
  state.selected = new Set(nodes.map(n => n.id));
  render();
  panTo(nodes[0]);
  return { ok: true, summary: `Showing ${nodes.map(n => `"${n.name}"`).join(', ')}` };
}

// ═════════════════════════════ Tokens ═══════════════════════════════════════

const themeByName = (name) => state.themes.find(t => t.name === name);

function findBy(list, args, what) {
  const item = args.id ? list.find(x => x.id === args.id) : list.find(x => x.name === args.name);
  if (!item) fail(`No ${what} ${args.id ? `with id "${args.id}"` : `named "${args.name}"`} — see get_data`);
  return item;
}

function validated(err, what) { if (err) fail(`${what}: ${err}`); }

// Mirror the active theme's value onto a color's top-level fields (what the
// renderer reads), as the Color tab does.
function mirrorActive(c) {
  const v = c.values[state.activeThemeId];
  if (v) Object.assign(c, { fillType: v.fillType, fill: v.fill, alpha: v.alpha, gradient: clone(v.gradient) });
}

function setColorValues(c, args) {
  const apply = (themeId, value) => {
    const v = c.values[themeId] || makeColorValue('#5b8af5');
    if (value !== undefined) {
      if (!isHex(value)) fail(`"${value}" isn't a hex color`);
      Object.assign(v, { fillType: 'solid', fill: value });
    }
    if (args.alpha !== undefined) v.alpha = Math.min(1, Math.max(0, +args.alpha));
    if (args.gradient !== undefined) Object.assign(v, gradientOf(args.gradient));
    c.values[themeId] = v;
  };
  if (args.values) {
    for (const [name, value] of Object.entries(args.values)) {
      const th = themeByName(name);
      if (!th) fail(`No theme "${name}" (there are: ${state.themes.map(t => t.name).join(', ')})`);
      apply(th.id, value);
    }
  }
  if (args.value !== undefined || (!args.values && (args.alpha !== undefined || args.gradient !== undefined))) {
    state.themes.forEach(t => apply(t.id, args.value));
  }
  mirrorActive(c);
}

function editColor(args) {
  if (args.action === 'create') {
    const n = state.nextColorId++;
    const values = {};
    state.themes.forEach(t => { values[t.id] = makeColorValue('#5b8af5'); });
    const c = { id: 'c' + n, name: args.name || 'color' + n, values };
    mirrorActive(c);
    state.colors.push(c);
    try {
      validated(colorError(c), `Color "${c.name}"`);
      setColorValues(c, args);
    } catch (e) { state.colors.pop(); throw e; }
    commit();
    return { ok: true, summary: `Added color "${c.name}"`, id: c.id };
  }
  const c = findBy(state.colors, args, 'color');
  if (args.action === 'delete') {
    state.colors = state.colors.filter(x => x !== c);
    Object.keys(state.colorRoles).forEach(k => { if (state.colorRoles[k] === c.id) state.colorRoles[k] = null; });
    if (state.selectedColorId === c.id) state.selectedColorId = state.colors.length ? state.colors[0].id : null;
    commit();
    return { ok: true, summary: `Deleted color "${c.name}"` };
  }
  const before = clone(c);
  try {
    if (args.rename !== undefined) { c.name = args.rename; validated(colorError(c), `Color "${args.rename}"`); }
    setColorValues(c, args);
  } catch (e) { Object.assign(c, before); throw e; }
  commit();
  return { ok: true, summary: `Updated color "${c.name}"` };
}

function editTheme(args) {
  if (args.action === 'create') {
    if (themeByName(args.name)) fail(`There's already a theme "${args.name}"`);
    const t = { id: 'th' + (state.nextThemeId++), name: args.name, brightness: args.brightness || 'dark' };
    state.themes.push(t);
    state.colors.forEach(c => {
      const src = c.values[state.activeThemeId] || Object.values(c.values)[0] || makeColorValue('#5b8af5');
      c.values[t.id] = clone(src);
    });
    commit();
    return { ok: true, summary: `Added theme "${t.name}" (a copy of the current colors)` };
  }
  const t = themeByName(args.name);
  if (!t) fail(`No theme "${args.name}" (there are: ${state.themes.map(x => x.name).join(', ')})`);
  if (args.action === 'preview') {
    applyTheme(t.id);
    return { ok: true, summary: `Previewing the "${t.name}" theme` };
  }
  if (args.action === 'delete') {
    if (state.themes.length <= 1) fail('A project keeps at least one theme');
    state.themes = state.themes.filter(x => x !== t);
    state.colors.forEach(c => { if (c.values) delete c.values[t.id]; });
    if (state.activeThemeId === t.id) {
      state.activeThemeId = state.themes[0].id;
      state.colors.forEach(mirrorActive);
    }
    commit();
    return { ok: true, summary: `Deleted theme "${t.name}"` };
  }
  if (args.rename !== undefined) {
    if (themeByName(args.rename)) fail(`There's already a theme "${args.rename}"`);
    t.name = args.rename;
  }
  if (args.brightness) t.brightness = args.brightness;
  commit();
  return { ok: true, summary: `Updated theme "${t.name}"` };
}

const ROLES = ['primary', 'onPrimary', 'secondary', 'onSecondary', 'surface', 'onSurface', 'surfaceContainer',
  'surfaceContainerHigh', 'error', 'onError', 'outline', 'outlineVariant'];

function setColorRole({ role, color }) {
  if (!ROLES.includes(role)) fail(`Unknown role "${role}" — one of ${ROLES.join(', ')}`);
  let id = null;
  if (color) {
    const c = state.colors.find(x => x.name === String(color).replace(/^var:/, ''));
    if (!c) fail(`No color variable "${color}"`);
    id = c.id;
  }
  state.colorRoles[role] = id;
  commit();
  return { ok: true, summary: id ? `${role} → ${color}` : `Cleared ${role}` };
}

function editTextStyle(args) {
  const apply = (t) => {
    if (args.rename !== undefined) t.name = args.rename;
    if (args.fontFamily !== undefined) t.fontFamily = String(args.fontFamily);
    if (args.fontSize !== undefined) { if (!isNum(args.fontSize)) fail('fontSize must be a number'); t.fontSize = args.fontSize; }
    if (args.fontWeight !== undefined) t.fontWeight = String(args.fontWeight);
    if (args.lineHeight !== undefined) t.lineHeight = +args.lineHeight;
    if (args.letterSpacing !== undefined) t.letterSpacing = +args.letterSpacing;
    if (args.color !== undefined) {
      if (args.color === null) t.colorId = null;
      else {
        const c = state.colors.find(x => x.name === String(args.color).replace(/^var:/, ''));
        if (!c) fail(`No color variable "${args.color}" — text styles use color variables`);
        t.colorId = c.id;
      }
    }
    validated(typoError(t), `Text style "${t.name}"`);
  };
  if (args.action === 'create') {
    const n = state.nextTypoId++;
    const t = { id: 't' + n, name: args.name || 'style' + n, fontFamily: 'IBM Plex Sans', fontSize: 16, fontWeight: '400', lineHeight: 1.4, letterSpacing: 0, colorId: null };
    state.typography.push(t);
    try { apply(t); } catch (e) { state.typography.pop(); throw e; }
    commit();
    return { ok: true, summary: `Added text style "${t.name}"`, id: t.id };
  }
  const t = findBy(state.typography, args, 'text style');
  if (args.action === 'delete') {
    state.typography = state.typography.filter(x => x !== t);
    state.nodes.forEach(n => { if (n.typoId === t.id) n.typoId = null; });
    if (state.selectedTypoId === t.id) state.selectedTypoId = state.typography.length ? state.typography[0].id : null;
    commit();
    return { ok: true, summary: `Deleted text style "${t.name}"` };
  }
  const before = clone(t);
  try { apply(t); } catch (e) { Object.assign(t, before); throw e; }
  commit();
  return { ok: true, summary: `Updated text style "${t.name}"` };
}

// ═════════════════════════════ Data ═════════════════════════════════════════

// "Map<String, List<int>>" → the Model tab's type tree.
function parseType(text) {
  let i = 0;
  const s = String(text).replace(/\s+/g, '');
  const read = () => {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!m) fail(`Can't read type "${text}"`);
    i += m[0].length;
    const base = m[0];
    const args = [];
    if (s[i] === '<') {
      i++;
      args.push(read());
      while (s[i] === ',') { i++; args.push(read()); }
      if (s[i] !== '>') fail(`Can't read type "${text}" — missing ">"`);
      i++;
    }
    const arity = { List: 1, Set: 1, Map: 2 }[base] || 0;
    if (args.length !== arity) fail(`${base} takes ${arity || 'no'} type argument${arity === 1 ? '' : 's'} in "${text}"`);
    const known = ['String', 'int', 'double', 'bool', 'List', 'Set', 'Map', ...state.models.map(m => m.name), ...state.enums.map(e => e.name)];
    if (!known.includes(base)) fail(`Unknown type "${base}" in "${text}" — a primitive, List/Set/Map, or a model/enum name`);
    return { base, args };
  };
  const type = read();
  if (i !== s.length) fail(`Can't read type "${text}"`);
  return type;
}

function editModel(args) {
  const setFields = (m) => {
    if (args.fields === undefined) return;
    if (!Array.isArray(args.fields)) fail('fields is a list of {name, type, required}');
    m.properties = args.fields.map(f => ({ id: 'p' + state.nextPropId++, name: String(f.name), type: parseType(f.type), required: f.required !== false }));
    m.properties.forEach(p => validated(propError(m, p), `Field "${p.name}"`));
  };
  if (args.action === 'create') {
    const m = { id: 'm' + state.nextModelId++, name: args.name || 'Model' + state.nextModelId, properties: [] };
    state.models.push(m);
    try { validated(modelError(m), `Model "${m.name}"`); setFields(m); } catch (e) { state.models.pop(); throw e; }
    commit();
    return { ok: true, summary: `Added model "${m.name}" with ${plural(m.properties.length, 'field')}`, id: m.id };
  }
  const m = findBy(state.models, args, 'model');
  if (args.action === 'delete') {
    state.models = state.models.filter(x => x !== m);
    commit();
    return { ok: true, summary: `Deleted model "${m.name}"` };
  }
  const before = clone(m);
  try {
    if (args.rename !== undefined) {
      const old = m.name;
      m.name = args.rename;
      validated(modelError(m), `Model "${m.name}"`);
      renameTypeRefs(old, m.name);
    }
    setFields(m);
  } catch (e) { Object.assign(m, before); throw e; }
  commit();
  return { ok: true, summary: `Updated model "${m.name}"` };
}


function editEnum(args) {
  const setValues = (en) => {
    if (args.values === undefined) return;
    if (!Array.isArray(args.values) || !args.values.length) fail('values is a non-empty list of names');
    en.values = args.values.map(v => ({ id: 'ev' + state.nextEnumValId++, name: String(v) }));
    en.values.forEach(v => validated(enumValError(en, v), `Value "${v.name}"`));
  };
  if (args.action === 'create') {
    const en = { id: 'e' + state.nextEnumId++, name: args.name || 'Enum' + state.nextEnumId, values: [{ id: 'ev' + state.nextEnumValId++, name: 'valueOne' }] };
    state.enums.push(en);
    try { validated(enumError(en), `Enum "${en.name}"`); setValues(en); } catch (e) { state.enums.pop(); throw e; }
    commit();
    return { ok: true, summary: `Added enum "${en.name}"`, id: en.id };
  }
  const en = findBy(state.enums, args, 'enum');
  if (args.action === 'delete') {
    state.enums = state.enums.filter(x => x !== en);
    commit();
    return { ok: true, summary: `Deleted enum "${en.name}"` };
  }
  const before = clone(en);
  try {
    if (args.rename !== undefined) {
      const old = en.name;
      en.name = args.rename;
      validated(enumError(en), `Enum "${en.name}"`);
      renameTypeRefs(old, en.name);
    }
    setValues(en);
  } catch (e) { Object.assign(en, before); throw e; }
  commit();
  return { ok: true, summary: `Updated enum "${en.name}"` };
}

// Check a value against a Model-tab type tree, the way the Mock Data tab and
// its Dart output read it. Returns the value to store (Sets arrive as lists).
function checkValue(type, value, path) {
  const base = type.base;
  const want = (ok, what) => { if (!ok) fail(`${path} must be ${what}, got ${JSON.stringify(value)}`); return value; };
  if (base === 'String') return want(typeof value === 'string', 'text');
  if (base === 'int') return want(Number.isInteger(value), 'a whole number');
  if (base === 'double') return want(typeof value === 'number' && isFinite(value), 'a number');
  if (base === 'bool') return want(typeof value === 'boolean', 'true or false');
  if (base === 'List' || base === 'Set') {
    want(Array.isArray(value), 'a list');
    return value.map((v, i) => checkValue(type.args[0], v, `${path}[${i}]`));
  }
  if (base === 'Map') {
    want(value && typeof value === 'object' && !Array.isArray(value), 'an object');
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, checkValue(type.args[1], v, `${path}.${k}`)]));
  }
  const en = state.enums.find(e => e.name === base);
  if (en) {
    const names = en.values.map(v => v.name);
    return want(names.includes(value), `one of ${en.name}'s values (${names.join(', ')})`);
  }
  const m = state.models.find(x => x.name === base);
  if (m) return checkObject(m, value, path);
  fail(`${path} has type ${base}, which no longer exists — fix the model first`);
}

function checkObject(model, value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be a ${model.name} object`);
  const fields = new Map(model.properties.map(p => [p.name, p]));
  const unknown = Object.keys(value).filter(k => !fields.has(k));
  if (unknown.length) fail(`${path} has no field ${unknown.map(k => `"${k}"`).join(', ')} — ${model.name}'s fields are ${[...fields.keys()].join(', ')}`);
  const out = {};
  for (const p of model.properties) {
    const v = value[p.name];
    if (v === undefined || v === null) {
      if (p.required !== false) fail(`${path}.${p.name} is required`);
      out[p.name] = null;
    } else out[p.name] = checkValue(p.type, v, `${path}.${p.name}`);
  }
  return out;
}

// Supplied values for a set, checked against its model and kind.
function checkedData(set, data) {
  const m = state.models.find(x => x.id === set.modelId);
  if (set.kind === 'list') {
    if (!Array.isArray(data) || !data.length) fail('For a list, "data" is a non-empty list of objects');
    if (data.length > 50) fail('A mock list holds at most 50 items');
    return data.map((row, i) => checkObject(m, row, `data[${i}]`));
  }
  if (Array.isArray(data)) fail('For kind single, "data" is one object — or use kind "list"');
  return checkObject(m, data, 'data');
}

function editMockData(args) {
  const modelNamed = (name) => {
    const m = state.models.find(x => x.name === name);
    if (!m) fail(`No model "${name}" — create it with edit_model first`);
    return m;
  };
  // Fill a set: the supplied values, or generated ones.
  const fill = (set) => {
    if (args.data !== undefined) {
      set.data = checkedData(set, args.data);
      if (set.kind === 'list') set.count = set.data.length;
    } else generateMock(set);
  };
  if (args.action === 'create') {
    const m = modelNamed(args.model);
    const kind = args.kind || (Array.isArray(args.data) ? 'list' : 'single');
    const set = { id: 'mock' + state.nextMockId++, name: args.name || mockName(m, kind), modelId: m.id, kind, count: args.count || 5, data: null };
    fill(set);
    state.mockSets.push(set);
    commit();
    return { ok: true, summary: `Added mock data "${set.name}" (${kind === 'list' ? plural(set.count, m.name) : `one ${m.name}`})`, id: set.id };
  }
  const set = findBy(state.mockSets, args, 'mock data set');
  if (args.action === 'delete') {
    state.mockSets = state.mockSets.filter(x => x !== set);
    commit();
    return { ok: true, summary: `Deleted mock data "${set.name}"` };
  }
  if (args.model !== undefined) set.modelId = modelNamed(args.model).id;
  if (args.kind !== undefined) set.kind = args.kind;
  if (args.count !== undefined) set.count = Math.max(1, Math.min(50, args.count));
  if (args.name !== undefined) set.name = String(args.name);
  if (args.action === 'regenerate') generateMock(set);
  else if (args.data !== undefined) fill(set);
  // Changing the model or kind makes the old values the wrong shape.
  else if (args.model !== undefined || args.kind !== undefined || args.count !== undefined) generateMock(set);
  commit();
  return { ok: true, summary: `${args.action === 'regenerate' ? 'Regenerated' : 'Updated'} mock data "${set.name}"` };
}

function editProvider(args) {
  const baseUrl = () => { if (args.base_url !== undefined) state.apiBaseUrl = String(args.base_url); };
  const modelOk = (name, allowJson) => {
    if (!name) return '';
    if (name === 'json' && allowJson) return 'json';
    if (!state.models.some(m => m.name === name)) fail(`No model "${name}"${allowJson ? ' (or use "json")' : ''}`);
    return name;
  };
  const setEndpoints = (p) => {
    if (args.endpoints === undefined) return;
    if (!Array.isArray(args.endpoints)) fail('endpoints is a list');
    const kv = (o, prefix, counter) => Object.entries(o || {}).map(([key, value]) => ({ id: prefix + state[counter]++, key, value: String(value) }));
    p.apis = args.endpoints.map(e => {
      const method = String(e.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) fail(`Method "${e.method}" — GET, POST, PUT, PATCH or DELETE`);
      return {
        id: 'a' + state.nextApiId++, name: String(e.name || 'endpoint' + state.nextApiId), method,
        version: e.version !== undefined ? String(e.version) : 'v1', route: String(e.route || ''),
        params: kv(e.params, 'q', 'nextParamId'), headers: kv(e.headers, 'h', 'nextHeaderId'),
        body: e.body !== undefined ? (typeof e.body === 'string' ? e.body : JSON.stringify(e.body, null, 2)) : '',
        output: { type: e.output_type === 'list' ? 'list' : 'single', model: modelOk(e.output, true) },
      };
    });
    p.apis.forEach(a => validated(apiNameError(p, a), `Endpoint "${a.name}"`));
  };
  const setOutput = (p) => {
    if (args.output !== undefined) p.output.model = modelOk(args.output, false);
    if (args.output_type !== undefined) p.output.type = args.output_type;
  };
  // What fills the provider: the endpoint build() returns, and its design preview.
  const setSource = (p) => {
    if (args.load !== undefined) {
      if (!args.load) p.load = null;
      else {
        const a = p.apis.find(x => x.name === args.load);
        if (!a) fail(`Provider "${p.name}" has no endpoint "${args.load}"`);
        if (a.output.model !== p.output.model || a.output.type !== p.output.type) {
          fail(`load: "${a.name}" returns ${a.output.type} ${a.output.model || 'nothing'}, but the provider holds ${p.output.type} ${p.output.model || 'nothing'}`);
        }
        p.load = a.id;
      }
    }
    if (args.preview !== undefined) {
      if (!args.preview) p.preview = null;
      else {
        const s = previewCandidates(p).find(x => x.name === args.preview);
        if (!s) fail(`preview: no ${p.output.type} mock set of ${p.output.model} named "${args.preview}" (there are: ${previewCandidates(p).map(x => x.name).join(', ') || 'none'})`);
        p.preview = s.id;
      }
    }
  };

  if (args.action === 'create') {
    const p = { id: 'pr' + state.nextProviderId++, name: args.name || 'provider' + state.nextProviderId, output: { type: 'single', model: '' }, apis: [] };
    state.providers.push(p);
    try { validated(provNameError(p), `Provider "${p.name}"`); setOutput(p); setEndpoints(p); setSource(p); } catch (e) { state.providers.pop(); throw e; }
    baseUrl();
    commit();
    return { ok: true, summary: `Added provider "${p.name}" with ${plural(p.apis.length, 'endpoint')}`, id: p.id };
  }
  if (args.action === 'update' && !args.id && !args.name && args.base_url !== undefined) {
    baseUrl();
    commit();
    return { ok: true, summary: `API base URL set to ${state.apiBaseUrl}` };
  }
  const p = findBy(state.providers, args, 'provider');
  if (args.action === 'delete') {
    state.providers = state.providers.filter(x => x !== p);
    baseUrl();
    commit();
    return { ok: true, summary: `Deleted provider "${p.name}"` };
  }
  const before = clone(p);
  try {
    if (args.rename !== undefined) { p.name = args.rename; validated(provNameError(p), `Provider "${p.name}"`); }
    setOutput(p); setEndpoints(p); setSource(p);
  } catch (e) { Object.assign(p, before); throw e; }
  baseUrl();
  commit();
  return { ok: true, summary: `Updated provider "${p.name}"` };
}

// ═════════════════════════════ Project ══════════════════════════════════════

async function comments(args) {
  const pid = state.projectId;
  if (!pid) fail('Comments need a saved project');
  const check = (res, what) => { if (!res.ok) fail(`Couldn't ${what}: ${res.error || 'request failed'}`); return res.data; };
  let summary;
  if (args.action === 'list') {
    const threads = check(await listComments(pid), 'load comments') || [];
    return {
      ok: true, summary: `${plural(threads.length, 'comment thread')}`,
      threads: threads.map(t => ({
        id: t.uuid, x: t.x, y: t.y, resolved: !!t.resolved,
        messages: (t.messages || []).map(m => ({ author: m.author_name, text: m.text })),
      })),
    };
  }
  if (args.action === 'add') {
    if (!args.text) fail('A comment needs text');
    let { x, y } = args;
    if (args.element_id) {
      const n = need(getNode(args.element_id), args.element_id);
      const wp = getWorldPos(n);
      x = wp.x + n.w; y = wp.y;
    }
    if (!isNum(x) || !isNum(y)) fail('Pin the comment with element_id, or x and y');
    const t = check(await createComment(pid, x, y, String(args.text)), 'post the comment');
    summary = 'Added a comment';
    await loadComments();
    return { ok: true, summary, thread_id: t && t.uuid };
  }
  if (!args.thread_id) fail('Give thread_id (see comments list)');
  if (args.action === 'reply') {
    if (!args.text) fail('A reply needs text');
    check(await replyComment(pid, args.thread_id, String(args.text)), 'reply');
    summary = 'Replied';
  } else {
    check(await resolveComment(pid, args.thread_id, args.action === 'resolve'), args.action);
    summary = args.action === 'resolve' ? 'Resolved the thread' : 'Reopened the thread';
  }
  await loadComments();
  return { ok: true, summary };
}

async function renameProject({ name }) {
  const v = String(name || '').trim();
  if (!v) fail('The name can\'t be empty');
  state.projectName = v;
  const input = document.getElementById('project-name');
  if (input) input.value = v;
  if (state.projectId) {
    const res = await updateProject(state.projectId, { name: v });
    if (!res.ok) fail(`Couldn't rename: ${res.error || 'request failed'}`);
  }
  return { ok: true, summary: `Renamed the project to "${v}"` };
}

function undoRedo(args) {
  const steps = args.steps || 1;
  for (let i = 0; i < steps; i++) (args.redo ? redo : undo)();
  return { ok: true, summary: `${args.redo ? 'Redid' : 'Undid'} ${plural(steps, 'step')}` };
}

async function exportCode() {
  const problems = [
    anyFrameError() && 'screen or section names/routes',
    anyColorError() && 'color variables',
    anyTypoError() && 'text styles',
    anyModelError() && 'models',
    anyEnumError() && 'enums',
    anyProviderError() && 'providers',
  ].filter(Boolean);
  if (problems.length) fail(`Fix the errors first — in ${problems.join(', ')} (names must follow the naming rules and be unique)`);
  await resolveRefsForExport(state.nodes);
  const r = exportModelsCode(null);
  if (!r.ok) fail('Nothing to export yet — add a screen, model, provider or color');
  const parts = [];
  if (r.screens) parts.push(plural(r.screens, 'screen'));
  if (r.models) parts.push(plural(r.models, 'model'));
  if (r.enums) parts.push(plural(r.enums, 'enum'));
  if (r.providers) parts.push(plural(r.providers, 'provider'));
  if (r.theme) parts.push('theme');
  return { ok: true, summary: `Exported ${parts.join(' + ')} — the zip is in Downloads` };
}

// ═════════════════════════════ Checking ═════════════════════════════════════
// Measured from the rendered canvas, so Claude sees what the person sees.

const screenOf = (node) => {
  let n = node;
  while (n && !isScreenFrame(n)) n = n.parentId ? getNode(n.parentId) : null;
  return n || null;
};
const subtree = (root) => {
  const out = [];
  const walk = (id) => { const n = getNode(id); if (!n) return; out.push(n); (n.children || []).forEach(walk); };
  (root.children || []).forEach(walk);
  return out;
};
const rgb = (css) => { const m = (css || '').match(/[\d.]+/g); return m ? m.map(Number) : null; };
function luminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
// The solid color behind an element: the nearest node that paints one. null
// over a gradient or photo, where one color can't stand for the background.
function backdrop(el) {
  for (let e = el; e && e.classList && e.classList.contains('node'); e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
    const c = rgb(cs.backgroundColor);
    if (c && (c.length < 4 || c[3] > 0.5)) return c;
  }
  return [255, 255, 255];
}

function lintScreen(frame) {
  const issues = [];
  const z = state.zoom || 1;
  const fEl = document.getElementById('node-' + frame.id);
  if (!fEl) return issues;
  const fr = fEl.getBoundingClientRect();
  const add = (n, problem) => issues.push({ id: n.id, name: n.name, screen: frame.name, problem });
  const elOf = (n) => document.getElementById('node-' + n.id);
  const rectOf = (n) => { const e = elOf(n); return e && e.getClientRects().length ? e.getBoundingClientRect() : null; };
  const flagged = new Set(); // report where a problem starts, not every descendant along with it

  for (const n of subtree(frame)) {
    const r = rectOf(n);
    if (!r || n.visible === false) continue;
    const el = elOf(n);

    if (n.type === 'text' && (n.text || '').trim()) {
      const cs = getComputedStyle(el);
      const fg = rgb(cs.color);
      const bg = backdrop(el.parentElement);
      if (fg && bg) {
        const L1 = luminance(fg), L2 = luminance(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const px = parseFloat(cs.fontSize);
        const need = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight, 10) >= 700) ? 3 : 4.5;
        if (ratio < need) add(n, `text "${n.text.slice(0, 30)}" has ${ratio.toFixed(1)}:1 contrast against its background (needs ${need}:1)`);
      }
    }

    if (flagged.has(n.parentId)) { flagged.add(n.id); continue; }
    const parent = getNode(n.parentId);
    const inScreen = !parent || parent.id === frame.id;
    const pr = inScreen ? fr : rectOf(parent);
    const over = pr ? Math.max(r.right - pr.right, pr.left - r.left) / z : 0;
    if (over > 1) {
      flagged.add(n.id);
      add(n, `sticks out ${Math.round(over)}px past ${inScreen ? 'the screen' : `"${parent.name}"`} — shrink it or its siblings, let siblings share the row with width "fill", or use a wrap layout`);
    } else if (r.top >= fr.bottom - 1) {
      flagged.add(n.id);
      add(n, 'is below the bottom of the screen and can\'t be seen — tighten spacing, or make the screen taller so it scrolls');
    } else if (r.bottom > fr.bottom + 1) {
      flagged.add(n.id);
      add(n, `is cut off at the bottom of the screen (${Math.round((r.bottom - fr.bottom) / z)}px hidden) — tighten spacing, or make the screen taller so it scrolls`);
    }

    const tappable = (n.action && n.action.type !== 'none') || /button|btn|cta/i.test(n.name || '');
    if (tappable && n.type !== 'text' && r.height / z < 43.5) add(n, `tap target is ${Math.round(r.height / z)}px tall (44px minimum)`);
  }
  return issues;
}

const lint = (frames) => frames.flatMap(lintScreen);

// Attach the check for the screens a change touched to a tool's result.
function withChecks(result, nodes) {
  const frames = [...new Set(nodes.map(screenOf).filter(Boolean))];
  const issues = lint(frames);
  if (!issues.length) return result;
  return { ...result, summary: `${result.summary} — ${plural(issues.length, 'issue')} to fix (see issues)`, issues };
}

function checkDesign({ id }) {
  const frames = id ? [need(getNode(id), id)] : state.nodes.filter(isScreenFrame);
  if (id && !isScreenFrame(frames[0])) fail(`"${frames[0].name}" isn't a screen`);
  const issues = lint(frames);
  const screens = new Set(issues.map(i => i.screen)).size;
  return {
    ok: true,
    summary: issues.length ? `${plural(issues.length, 'issue')} on ${plural(screens, 'screen')}` : `No issues on ${plural(frames.length, 'screen')}`,
    issues,
  };
}

// ═════════════════════════════ Dispatch ═════════════════════════════════════

const HANDLERS = {
  get_design: getDesign, get_element: getElement, get_data: getData,
  create_screen: createScreen, create_section: createSection, add_elements: addElements,
  update_element: updateElement, move_element: moveElement, duplicate_elements: duplicateElements,
  delete_elements: deleteElements, make_component: makeComponent, edit_component: editComponent, set_interaction: setInteraction,
  search_icons: searchIcons, focus, check_design: checkDesign,
  edit_color: editColor, edit_theme: editTheme, set_color_role: setColorRole, edit_text_style: editTextStyle,
  edit_model: editModel, edit_enum: editEnum, edit_mock_data: editMockData, edit_provider: editProvider,
  comments, rename_project: renameProject, undo: undoRedo, export_code: exportCode,
};
const READ_ONLY = new Set(TOOLS.filter(t => t.annotations.readOnlyHint).map(t => t.name));

export async function run(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return { ok: false, summary: `Unknown tool "${name}"` };
  if (state.readonly && !READ_ONLY.has(name) && !(name === 'comments' && (args || {}).action === 'list')) {
    return { ok: false, summary: 'This project is view-only for this person, so it can\'t be changed' };
  }
  // A tool that fails partway leaves nothing behind: the document goes back to
  // how it was before the call (nothing was committed, so undo never sees it).
  const before = READ_ONLY.has(name) ? null : captureState();
  try {
    return await handler(args || {});
  } catch (error) {
    if (before) restoreState(before);
    if (error instanceof ToolError) return { ok: false, summary: error.message };
    console.error('claude tool failed', name, error);
    return { ok: false, summary: `${name} failed in the editor: ${error.message || error}` };
  }
}

// Answer the app's relayed MCP requests: `list`, `call`, and `permission` —
// Claude Code asking the person to approve something, which `onPermission`
// (the chat panel) puts in front of them; it resolves to
// { behavior: 'allow' } or { behavior: 'deny', message }.
export function initClaudeTools({ onPermission } = {}) {
  const tauri = window.__TAURI__;
  if (!tauri) return;
  tauri.event.listen('scaffold-tool', async ({ payload }) => {
    const { id, method, name, arguments: args } = payload || {};
    const result = method === 'list' ? { ok: true, tools: TOOLS }
      : method === 'call' ? await run(name, args)
      : method === 'permission' && onPermission ? await onPermission(args || {})
      : { ok: false, summary: `Unknown request "${method}"` };
    tauri.core.invoke('tool_reply', { id, result });
  });
}
