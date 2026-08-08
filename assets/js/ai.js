// Text-to-design (Claude). A slide-in chat panel. The user connects their OWN
// Anthropic API key (stored only in this browser); requests go directly to
// Anthropic with the browser-access header, so the key never touches our server.
// Claude returns a compact design DSL, expanded here into real nodes via makeNode
// and the auto-layout engine — no coordinates are ever computed.

import { state, makeNode } from './state.js';
import { canvasWrap, showToast } from './utils.js';
import { canvasToWorld } from './nodes.js';
import { render, applyTransform } from './render.js';
import { saveHistory } from './history.js';

const DEVICE_W = 393;
const DEVICE_H = 852;
const KEY_STORE = 'claude_api_key';
const MODEL = 'claude-opus-5';

// The design DSL Claude must emit (kept here since the browser calls Anthropic
// directly). Small and flat-per-node — expanded into real nodes below.
const SYSTEM_PROMPT = [
  'You are a mobile UI generator for a Flutter design tool. Given a plain-language request, output ONE mobile screen as JSON. Respond with ONLY the JSON object — no prose, no markdown fences.',
  '',
  'Shape: { "screen": { "name": "Login", "background": "#ffffff", "padding": 20, "gap": 16, "align": "stretch", "children": [ <node>, ... ] } }',
  '',
  'A <node> is one of:',
  '  text:      { "type":"text", "text":"...", "fontSize":16, "fontWeight":"400|500|600|700", "color":"#111827", "align":"left|center|right" }',
  '  container: { "type":"container", "layout":"column|row|stack|none", "gap":12, "padding":16, "fill":"#f3f4f6", "radius":12, "align":"stretch|left|center|right", "height":<px optional>, "children":[ <node>, ... ] }',
  '  image:     { "type":"image", "height":180, "radius":12, "fill":"#e5e7eb" }',
  '  button:    { "type":"button", "text":"Sign in", "fill":"#2563eb", "color":"#ffffff", "radius":10 }',
  '',
  'Rules: Output valid JSON only, double-quoted keys and hex colors. Compose realistic, well-spaced mobile layouts; prefer column, use row for horizontal groups. Group related fields into containers with a fill/radius to make cards. Use concrete realistic copy (never lorem ipsum). Widths are automatic (children fill their parent) — never specify width or x/y. Keep it to a single screen.',
].join('\n');

let panel, promptEl, messagesEl, sendBtn, connectEl, chatEl, disconnectBtn, keyInput, connectErr, busy = false;

const getKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } };
const setKey = k => { try { localStorage.setItem(KEY_STORE, k); } catch (e) { /* noop */ } };
const clearKey = () => { try { localStorage.removeItem(KEY_STORE); } catch (e) { /* noop */ } };

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const box = (v, d) => (typeof v === 'number' ? { t: v, r: v, b: v, l: v } : { t: d, r: d, b: d, l: d });
const alignH = a => (a === 'center' ? 'center' : a === 'right' ? 'right' : 'left');

// ── DSL → nodes ──────────────────────────────────────────────────────────────
function buildScreen(screen, x, y) {
  const created = [];
  const frame = makeNode('frame', x, y, DEVICE_W, DEVICE_H, null);
  frame.layout = 'column';
  frame.gap = num(screen.gap, 12);
  frame.padding = box(screen.padding, 20);
  frame.alignment = { h: alignH(screen.align), v: 'top' };
  frame.colorId = null;                       // use an explicit hex, not a color variable
  frame.fill = screen.background || '#ffffff';
  state.nodes.push(frame);
  created.push(frame);
  (screen.children || []).forEach(child => buildNode(child, frame, created));
  return { frame, created };
}

function buildNode(spec, parent, created) {
  if (!spec || typeof spec !== 'object') return;
  const type = spec.type === 'text' ? 'text'
    : spec.type === 'image' ? 'image'
    : spec.type === 'button' ? 'button'
    : 'container';

  if (type === 'text') return addText(spec, parent, created);
  if (type === 'image') return addImage(spec, parent, created);
  if (type === 'button') return addButton(spec, parent, created);
  return addContainer(spec, parent, created);
}

function attach(node, parent, created) {
  state.nodes.push(node);
  parent.children.push(node.id);
  created.push(node);
}

function addText(spec, parent, created) {
  const n = makeNode('text', 0, 0, 200, 24, parent.id);
  n.text = typeof spec.text === 'string' ? spec.text : 'Text';
  n.fontSize = num(spec.fontSize, 16);
  n.fontWeight = String(spec.fontWeight || '400');
  n.color = spec.color || '#111827';
  n.typoId = null;                            // custom size/colour instead of a type style
  n.autoSize = false;
  n.wMode = 'fill';
  n.hMode = 'hug';
  n.alignment = { h: alignH(spec.align), v: 'top' };
  attach(n, parent, created);
}

function addImage(spec, parent, created) {
  const n = makeNode('image', 0, 0, 200, num(spec.height, 180), parent.id);
  n.colorId = null;
  n.fill = spec.fill || '#e5e7eb';
  n.radius = num(spec.radius, 8);
  n.wMode = 'fill';
  n.hMode = 'fixed';
  attach(n, parent, created);
}

function addButton(spec, parent, created) {
  const c = makeNode('container', 0, 0, 200, 48, parent.id);
  c.layout = 'none';                          // single-child wrapper → centres its label
  c.alignment = { h: 'center', v: 'center' };
  c.colorId = null;
  c.fill = spec.fill || '#2563eb';
  c.radius = num(spec.radius, 10);
  c.padding = { t: 12, r: 16, b: 12, l: 16 };
  c.wMode = 'fill';
  c.hMode = 'hug';
  attach(c, parent, created);

  const label = makeNode('text', 0, 0, 100, 20, c.id);
  label.text = typeof spec.text === 'string' ? spec.text : 'Button';
  label.color = spec.color || '#ffffff';
  label.fontWeight = String(spec.fontWeight || '600');
  label.fontSize = num(spec.fontSize, 15);
  label.typoId = null;
  label.autoSize = true;
  attach(label, c, created);
}

function addContainer(spec, parent, created) {
  const layout = ['row', 'column', 'stack', 'wrap', 'none'].includes(spec.layout) ? spec.layout : 'column';
  const c = makeNode('container', 0, 0, 200, 120, parent.id);
  c.layout = layout;
  c.gap = num(spec.gap, 12);
  c.padding = box(spec.padding, 0);
  c.colorId = null;
  c.fill = spec.fill || 'transparent';
  c.radius = num(spec.radius, 0);
  c.alignment = { h: alignH(spec.align), v: 'top' };
  c.wMode = 'fill';
  if (typeof spec.height === 'number') { c.hMode = 'fixed'; c.h = spec.height; }
  else c.hMode = 'hug';
  attach(c, parent, created);
  (spec.children || []).forEach(child => buildNode(child, c, created));
}

// Where to drop the generated screen: to the right of everything already on the
// canvas (or the viewport centre when the canvas is empty), then pan to it.
function placement() {
  const frames = state.nodes.filter(n => !n.parentId);
  if (!frames.length) {
    const c = canvasToWorld(canvasWrap.clientWidth / 2, canvasWrap.clientHeight / 2);
    return { x: Math.round(c.x - DEVICE_W / 2), y: Math.round(c.y - DEVICE_H / 2) };
  }
  const maxX = Math.max(...frames.map(n => n.x + (n.w || 0)));
  const minY = Math.min(...frames.map(n => n.y));
  return { x: Math.round(maxX + 80), y: Math.round(minY) };
}

function panTo(x, y, w, h) {
  state.panX = canvasWrap.clientWidth / 2 - (x + w / 2) * state.zoom;
  state.panY = canvasWrap.clientHeight / 2 - (y + h / 2) * state.zoom;
  applyTransform();
}

// ── direct Anthropic call (browser, user's own key) ───────────────────────────
// Pull the JSON object out of the model's text (whole string, else first '{'..'}').
function extractJson(text) {
  try { return JSON.parse(text.trim()); } catch (e) { /* fall through */ }
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (err) { return null; }
}

// Returns { design } | { error } | { auth: true }.
async function callClaude(prompt) {
  const key = getKey();
  if (!key) return { auth: true };
  const body = {
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Design this screen for a ${DEVICE_W}x${DEVICE_H} phone.\n\nRequest: ${prompt}` }],
  };
  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch (e) { return { error: 'Couldn’t reach Claude — check your connection.' }; }

  let data;
  try { data = await resp.json(); } catch (e) { return { error: 'Claude returned an unreadable response.' }; }
  if (resp.status === 401) return { auth: true };
  if (!resp.ok) return { error: (data.error && data.error.message) || 'Claude returned an error.' };
  if (data.stop_reason === 'refusal') return { error: 'That request was declined — try describing a UI screen.' };

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const design = extractJson(text);
  return design ? { design } : { error: 'Claude’s response wasn’t valid — try rephrasing.' };
}

// ── sliding chat panel ────────────────────────────────────────────────────────
// Toggled via a body class; CSS slides the panel in from the right and shifts the
// rest of the right rail left to make room.
function isOpen() { return document.body.classList.contains('claude-open'); }

// Show the connect view (no key) or the chat view (connected).
function refreshView() {
  const connected = !!getKey();
  connectEl.hidden = connected;
  chatEl.hidden = !connected;
  disconnectBtn.hidden = !connected;
  if (connected && !messagesEl.childElementCount) {
    addMessage('assistant', 'Hi! Describe a screen and I’ll build it on the canvas — e.g. “a login screen with email, password, and a sign-in button.”');
  }
}

function open() {
  if (state.readonly) { showToast('Viewers can’t generate designs'); return; }
  document.body.classList.add('claude-open');
  refreshView();
  setTimeout(() => (getKey() ? promptEl : keyInput).focus(), 0);
}

function close() { document.body.classList.remove('claude-open'); }
function toggle() { isOpen() ? close() : open(); }

function connect() {
  const key = keyInput.value.trim();
  if (!key) { keyInput.focus(); return; }
  if (!/^sk-ant-/.test(key)) {
    connectErr.textContent = 'That doesn’t look like an Anthropic API key (it should start with “sk-ant-”).';
    connectErr.hidden = false;
    return;
  }
  connectErr.hidden = true;
  setKey(key);
  keyInput.value = '';
  refreshView();
  setTimeout(() => promptEl.focus(), 0);
}

function disconnect() {
  clearKey();
  refreshView();
  setTimeout(() => keyInput.focus(), 0);
}

// Append a chat bubble. `role`: 'user' | 'assistant' | 'error' | 'thinking'.
function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'claude-msg ' + role;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function autoGrow() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
}

function setBusy(on) {
  busy = on;
  if (sendBtn) sendBtn.disabled = on;
}

async function send() {
  if (busy) return;
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  addMessage('user', prompt);
  promptEl.value = '';
  autoGrow();

  const pending = addMessage('thinking', 'Thinking…');
  setBusy(true);
  const res = await callClaude(prompt);
  setBusy(false);

  if (res.auth) {
    pending.className = 'claude-msg error';
    pending.textContent = 'Your API key was rejected — reconnect with a valid key.';
    clearKey();
    refreshView();
    return;
  }
  if (res.error || !res.design) {
    pending.className = 'claude-msg error';
    pending.textContent = res.error || 'Couldn’t generate that — try rephrasing.';
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }

  const screen = res.design.screen || res.design;
  const { x, y } = placement();
  const { frame } = buildScreen(screen, x, y);
  state.selected = new Set([frame.id]);
  saveHistory();
  render();
  panTo(x, y, DEVICE_W, DEVICE_H);

  pending.className = 'claude-msg assistant';
  pending.textContent = 'Done — I added a new screen to the canvas.';
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

export function initAi() {
  panel = document.getElementById('claude-panel');
  if (!panel) return;
  connectEl = document.getElementById('claude-connect');
  chatEl = document.getElementById('claude-chat');
  disconnectBtn = document.getElementById('claude-disconnect');
  keyInput = document.getElementById('claude-key');
  connectErr = document.getElementById('claude-connect-error');
  promptEl = document.getElementById('ai-prompt');
  messagesEl = document.getElementById('claude-messages');
  sendBtn = document.getElementById('ai-send');

  document.getElementById('tool-ai')?.addEventListener('click', toggle);
  document.getElementById('claude-close')?.addEventListener('click', close);
  document.getElementById('claude-connect-btn')?.addEventListener('click', connect);
  disconnectBtn?.addEventListener('click', disconnect);
  keyInput?.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); connect(); }
  });
  sendBtn?.addEventListener('click', send);
  promptEl?.addEventListener('input', autoGrow);
  promptEl?.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  refreshView();
}
