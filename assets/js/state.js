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
  // Color tab: reusable color variables (solid or gradient)
  colors: [],
  nextColorId: 1,
  selectedColorId: null,
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

// Seed a fresh project with sensible starting variables: white + black color
// swatches and a default "body" type style (white, 14px, 400) that new text
// adopts. Runs once at boot, before the first history snapshot.
export function seedDefaults() {
  if (state.colors.length) return; // already seeded / not a fresh project
  const mkColor = (name, hex) => ({
    id: 'c' + (state.nextColorId++), name, fillType: 'solid', fill: hex, alpha: 1,
    gradient: { angle: 90, stops: [{ color: hex, alpha: 1, pos: 0 }, { color: '#ffffff', alpha: 1, pos: 100 }] },
  });
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

// Slugify a name into a leading-slash dashed-case route (e.g. "Frame_2" → "/frame-2").
function routeFromName(name) {
  const s = (name || 'screen').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return '/' + (s || 'screen');
}

export function makeNode(type, x, y, w, h, parentId = null) {
  const defaults = {
    frame:     { fill: '#ffffff', stroke: 'transparent', strokeW: 0, strokeOpacity: 1, strokeStyle: 'solid', opacity: 1, name: 'Frame' },
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
    id: 'n' + (state.nextId++),
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
    scroll: 'none', // container scroll axis: 'none' | 'horizontal' | 'vertical'
    layout: 'none', // container auto-layout: 'none' | 'row' | 'column' | 'wrap' | 'stack'
    autoSize: type === 'text', // text nodes size to their content (Figma auto-width)
    wMode: 'fixed', // width sizing: 'fixed' (px) | 'fill' (match parent) | 'hug' (match child)
    hMode: 'fixed', // height sizing: same options as wMode
    text: d.text || '',
    fontSize: d.fontSize || 14,
    fontWeight: d.fontWeight || '400',
    color: d.color || '#000000',
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
  if (type === 'container') node.name = 'Container_' + state.nextContainerNum++;
  // Frames get a numbered name and a concrete route derived from it *once*, at
  // creation. The route is then independent — renaming the frame won't change it.
  if (type === 'frame') {
    node.name = 'Frame_' + state.nextFrameNum++;
    node.routePath = routeFromName(node.name);
  }
  // Give new nodes a sensible default reference instead of an invisible one:
  // containers adopt the first color variable, text adopts the first type style.
  if (type === 'container' && state.colors.length) node.colorId = state.colors[0].id;
  if (type === 'text' && state.typography.length) node.typoId = state.typography[0].id;
  // Icons tint via `currentColor`; adopt the first color variable by default.
  if (type === 'icon' && state.colors.length) node.colorId = state.colors[0].id;
  return node;
}
