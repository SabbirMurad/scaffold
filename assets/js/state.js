export const state = {
  nodes: [],
  selected: new Set(),
  tool: 'select',
  zoom: 1,
  panX: 60,
  panY: 60,
  projectName: 'Untitled',
  nextId: 1,
  nextFrameNum: 1,
  nextContainerNum: 1,
  nextSectionNum: 1,
  // Components: reusable node subtrees (masters). Each is { id, name, rootId }; the
  // master root node lives in `nodes`, flagged with a matching componentId. Instances
  // are `type:'instance'` nodes that live-mirror a master (see render.js).
  components: [],
  nextComponentId: 1,
  // Color tab: reusable color variables (solid or gradient). Fully theme-aware —
  // themes live in `state.themes` and each color has one shared name but a
  // per-theme value stored in `color.values[themeId]`. The top-level
  // fill/alpha/gradient fields mirror the *active* theme's value so the renderer
  // and property swatches can keep reading them directly. Two themes (dark +
  // light) are seeded; the model supports more, the UI just doesn't add them yet.
  themes: [],
  nextThemeId: 1,
  activeThemeId: null, // which theme the Color tab is currently editing/previewing
  colors: [],
  nextColorId: 1,
  selectedColorId: null,
  // Maps Material ColorScheme roles (primary, surface, error…) to a color id, so
  // generated ThemeData can build a ColorScheme. Global (one mapping shared by
  // every theme); each theme supplies the mapped color's per-theme value.
  colorRoles: {},
  // Typography tab: reusable text styles (font, size, weight, line height, color)
  typography: [],
  nextTypoId: 1,
  selectedTypoId: null,
  history: [],
  historyIndex: -1,
  // Model tab: data models (entities) with typed properties
  models: [],
  nextModelId: 1,
  nextPropId: 1,
  // Model tab: enums (named sets of values) usable as field types
  enums: [],
  nextEnumId: 1,
  nextEnumValId: 1,
  // Mock Data tab: generated fake instances (single/list) of a chosen model
  mockSets: [],
  nextMockId: 1,
  // Provider tab: providers group related endpoints (apis) and share one base URL.
  // Each provider has a name + output model; each endpoint has its own name + output.
  providers: [],
  nextProviderId: 1,
  apiBaseUrl: '',
  nextApiId: 1,
  nextHeaderId: 1,
  nextParamId: 1,
};

export function getNode(id) {
  return state.nodes.find(n => n.id === id);
}

// A fresh node id. The counter normally stays ahead of every id in use; the check
// makes sure a stale counter can never hand out an id that's taken.
export function nextNodeId() {
  let id;
  do { id = 'n' + (state.nextId++); } while (getNode(id));
  return id;
}

// Every id counter, with the ids it numbers. A document whose counters fell behind
// its ids (e.g. a save that lost the counter but kept the nodes) would hand out
// duplicate ids, and a new element would replace an existing one.
const COUNTERS = [
  ['nextId', 'n', () => state.nodes],
  ['nextComponentId', 'cmp', () => state.components],
  ['nextThemeId', 'th', () => state.themes],
  ['nextColorId', 'c', () => state.colors],
  ['nextTypoId', 't', () => state.typography],
  ['nextModelId', 'm', () => state.models],
  ['nextPropId', 'p', () => state.models.flatMap(m => m.properties || [])],
  ['nextEnumId', 'e', () => state.enums],
  ['nextEnumValId', 'ev', () => state.enums.flatMap(e => e.values || [])],
  ['nextMockId', 'mock', () => state.mockSets],
  ['nextProviderId', 'pr', () => state.providers],
  ['nextApiId', 'a', () => state.providers.flatMap(p => p.apis || [])],
  ['nextHeaderId', 'h', () => state.providers.flatMap(p => (p.apis || []).flatMap(a => a.headers || []))],
  ['nextParamId', 'q', () => state.providers.flatMap(p => (p.apis || []).flatMap(a => a.params || []))],
];

// Move every counter past the highest id actually in use.
export function repairCounters() {
  for (const [key, prefix, items] of COUNTERS) {
    const re = new RegExp('^' + prefix + '(\\d+)$');
    let max = 0;
    for (const it of items() || []) {
      const m = it && typeof it.id === 'string' && re.exec(it.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    if (!(state[key] > max)) state[key] = max + 1;
  }
}

// Seed a fresh project with sensible starting variables: white + black color
// swatches and a default "body" type style (white, 14px, 400) that new text
// adopts. Runs once at boot, before the first history snapshot.
// A fresh per-theme color value (solid, with a sensible gradient fallback).
export function makeColorValue(hex) {
  return {
    fillType: 'solid', fill: hex, alpha: 1,
    gradient: { angle: 90, stops: [{ color: hex, alpha: 1, pos: 0 }, { color: '#ffffff', alpha: 1, pos: 100 }] },
  };
}

export function seedDefaults() {
  // Seed the two starting themes (dark + light) if none exist. The model stays
  // fully dynamic (keyed by theme id) so more themes can be added later — the UI
  // just doesn't expose add/rename for now. `brightness` drives Dart's Brightness
  // + ColorScheme.dark/.light at code-generation time.
  if (state.themes.length === 0) {
    state.themes.push(
      { id: 'th' + (state.nextThemeId++), name: 'dark', brightness: 'dark' },
      { id: 'th' + (state.nextThemeId++), name: 'light', brightness: 'light' },
    );
  }
  if (!state.activeThemeId || !state.themes.some(t => t.id === state.activeThemeId)) {
    state.activeThemeId = state.themes[0].id;
  }
  // Brightness is fixed per theme (the manual toggle was removed), so keep the
  // canonical dark/light themes' brightness in step with their name — repairing
  // any project where it drifted (e.g. an earlier accidental toggle).
  state.themes.forEach(t => {
    if (t.name === 'dark') t.brightness = 'dark';
    else if (t.name === 'light') t.brightness = 'light';
  });
  // Ensure every color has a value under every theme (migrates older projects
  // whose colors predate theming — their top-level fields seed each theme).
  state.colors.forEach(c => {
    if (!c.values) c.values = {};
    state.themes.forEach(t => {
      if (!c.values[t.id]) {
        c.values[t.id] = { fillType: c.fillType, fill: c.fill, alpha: c.alpha, gradient: JSON.parse(JSON.stringify(c.gradient)) };
      }
    });
  });

  if (state.colors.length) return; // already seeded / not a fresh project
  const mkColor = (name, hex) => {
    const values = {};
    state.themes.forEach(t => { values[t.id] = makeColorValue(hex); });
    const c = { id: 'c' + (state.nextColorId++), name, values };
    Object.assign(c, JSON.parse(JSON.stringify(values[state.activeThemeId])));
    return c;
  };
  const white = mkColor('white', '#ffffff');
  const black = mkColor('black', '#000000');
  state.colors.push(white, black);
  state.selectedColorId = white.id;

  const body = {
    id: 't' + (state.nextTypoId++), name: 'body', fontFamily: 'IBM Plex Sans',
    fontSize: 14, fontWeight: '400', lineHeight: 1.4, letterSpacing: 0, colorId: white.id,
  };
  state.typography.push(body);
  state.selectedTypoId = body.id;
}

export function getColorById(id) {
  return state.colors.find(c => c.id === id);
}

export function getTypoById(id) {
  return state.typography.find(t => t.id === id);
}

// ── Components ──
export function getComponent(id) { return state.components.find(c => c.id === id); }
// The live master root node for a component (edited normally; instances mirror it).
export function getMasterNode(componentId) {
  const c = getComponent(componentId);
  return c ? getNode(c.rootId) : null;
}
export function isInstance(node) { return !!node && node.type === 'instance'; }
// A master is a normal node flagged with a componentId (an instance also has one,
// so exclude that type).
export function isMaster(node) { return !!node && node.type !== 'instance' && node.componentId != null; }

// Slugify a name into a leading-slash dashed-case route (e.g. "frame_2" → "/frame-2").
export function routeFromName(name) {
  const s = (name || 'screen').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return '/' + (s || 'screen');
}

export function makeNode(type, x, y, w, h, parentId = null) {
  const defaults = {
    frame:     { fill: '#ffffff', stroke: 'transparent', strokeW: 0, strokeOpacity: 1, strokeStyle: 'solid', opacity: 1, name: 'Frame' },
    // A Section is just a named, resizable region that groups frames (→ a folder
    // in generated code). It carries no visual styling of its own.
    section:   { fill: 'transparent', stroke: 'transparent', strokeW: 0, strokeOpacity: 1, strokeStyle: 'solid', opacity: 1, name: 'Section' },
    container: { fill: 'transparent', stroke: 'transparent', strokeW: 0, strokeOpacity: 1, strokeStyle: 'solid', opacity: 1, name: 'Container' },
    row:       { fill: 'transparent', stroke: '#c7c7c7', strokeW: 1, strokeOpacity: 1, strokeStyle: 'dashed', opacity: 1, name: 'Row' },
    column:    { fill: 'transparent', stroke: '#c7c7c7', strokeW: 1, strokeOpacity: 1, strokeStyle: 'dashed', opacity: 1, name: 'Column' },
    wrap:      { fill: 'transparent', stroke: '#c7c7c7', strokeW: 1, strokeOpacity: 1, strokeStyle: 'dashed', opacity: 1, name: 'Wrap' },
    stack:     { fill: 'transparent', stroke: '#c7c7c7', strokeW: 1, strokeOpacity: 1, strokeStyle: 'dashed', opacity: 1, name: 'Stack' },
    image:     { fill: 'transparent', stroke: 'transparent', strokeW: 0, strokeOpacity: 1, strokeStyle: 'solid', opacity: 1, name: 'Image' },
    icon:      { fill: 'transparent', stroke: 'transparent', strokeW: 0, strokeOpacity: 1, strokeStyle: 'solid', opacity: 1, name: 'Icon' },
    text:      { fill: 'transparent', stroke: 'transparent', strokeW: 0, strokeOpacity: 1, strokeStyle: 'solid', opacity: 1, name: 'Text', text: 'Text', fontSize: 16, fontWeight: '400', color: '#1a1a1a' },
  };
  const d = defaults[type] || defaults.container;
  const node = {
    id: nextNodeId(),
    type, x, y, w, h, parentId,
    children: [],
    visible: true,
    locked: false,
    name: d.name,
    fill: d.fill,
    stroke: d.stroke,
    strokeW: d.strokeW,
    strokeOpacity: d.strokeOpacity,
    strokeStyle: d.strokeStyle,
    opacity: d.opacity,
    radius: 0,
    radii: { tl: 0, tr: 0, br: 0, bl: 0 }, // per-corner radii (used when radiusMode === 'corners')
    radiusMode: 'uniform', // 'uniform' (single radius) | 'corners' (independent)
    rotation: 0, // degrees
    flipH: false,
    flipV: false,
    // Drop shadows (container/image) — a list; each {x,y,blur,spread,colorId,alpha}.
    // colorId null → black; alpha is 0..1. Empty list = no shadow.
    shadows: [],
    shape: 'rect',
    colorId: null,
    strokeColorId: null,
    typoId: null,
    fillType: 'solid',
    gradient: {
      angle: 90,
      stops: [
        { color: d.fill && d.fill !== 'transparent' ? d.fill : '#5b8af5', pos: 0 },
        { color: '#ffffff', pos: 100 },
      ],
    },
    src: '',
    // Icon nodes: `svg` is the raw (monochrome, currentColor) markup rendered
    // inline; `iconId` is the Iconify id (e.g. 'mdi:home') kept for reference/replace.
    svg: '',
    iconId: '',
    fit: 'cover',
    gap: 8,
    gapH: 8,
    gapV: 8,
    padding: { t: 0, r: 0, b: 0, l: 0 },
    margin: { t: 0, r: 0, b: 0, l: 0 },
    scroll: false, // container scroll on/off; axis follows the layout (Row→horizontal, Column→vertical)
    layout: 'none', // container auto-layout: 'none' | 'row' | 'column' | 'wrap' | 'stack'
    autoSize: type === 'text', // text nodes size to their content (Figma auto-width)
    wMode: 'fixed', // width sizing: 'fixed' (px) | 'fill' (match parent) | 'hug' (match child)
    hMode: 'fixed', // height sizing: same options as wMode
    text: d.text || '',
    fontSize: d.fontSize || 14,
    fontWeight: d.fontWeight || '400',
    color: d.color || '#000000',
    // Text with a style: per-text overrides of the style's size / weight (null =
    // the style's own). Colour overrides go through colorId (a colour variable).
    fontSizeOverride: null,
    fontWeightOverride: null,
    alignment: { h: 'left', v: 'top' },
    // Interaction (Phase 1 of navigation): what a tap on this node does. Any node
    // can carry one; frames use `routePath`/`isInitial` as navigation targets.
    //   type: 'none' | 'navigate' | 'back'
    //   targetFrameId: the destination screen (a frame node id) when navigating
    //   mode: 'push' | 'replace' | 'clear'   transition: 'platform'|'fade'|'slideRight'|'none'
    action: { type: 'none', targetFrameId: null, mode: 'push', transition: 'platform' },
    // Frame-only: the route path this screen is reachable at, and whether it is
    // the app's start screen. Empty routePath is auto-derived from the name.
    routePath: '',
    isInitial: false,
  };
  // Image is a leaf node — it can't contain anything, so it carries no children.
  if (type === 'image') delete node.children;
  if (type === 'container') node.name = 'Container_' + state.nextContainerNum++;
  // Sections become folders in generated code, so name them like a snake_case dir.
  if (type === 'section') node.name = 'section_' + state.nextSectionNum++;
  // Frames get a numbered name and a concrete route derived from it *once*, at
  // creation. The route is then independent — renaming the frame won't change it.
  if (type === 'frame') {
    node.name = 'frame_' + state.nextFrameNum++;
    node.routePath = routeFromName(node.name);
    // The device screen height. The frame can be dragged taller (bottom handle) to
    // hold scrollable content, but this marks where the visible screen ends (a
    // dotted fold line). Set once at creation from the drawn height.
    node.screenH = h;
  }
  // Give new nodes a sensible default reference instead of an invisible one:
  // frames/containers adopt the first color variable, text adopts the first type style.
  if ((type === 'container' || type === 'frame') && state.colors.length) node.colorId = state.colors[0].id;
  if (type === 'text' && state.typography.length) node.typoId = state.typography[0].id;
  // Icons tint via `currentColor`; adopt the first color variable by default.
  if (type === 'icon' && state.colors.length) node.colorId = state.colors[0].id;
  return node;
}
