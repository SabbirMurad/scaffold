// The Claude panel. A terminal-style view of the person's own Claude Code, which
// the desktop app runs headless (desktop/src-tauri/src/agent.rs) — no API key,
// usage counts toward their Claude plan. Claude edits the design through
// Scaffold's tools (claude-tools.js); this module is only the conversation: it
// sends a message, then shows the turn as it streams in as `claude` events.
//
// Each project is one Claude Code session. Its session id and the transcript
// shown here are kept per project on this machine, so reopening the project —
// even after restarting the app — continues the same conversation.

import { state } from './state.js';
import { showToast } from './utils.js';
import { initClaudeTools } from './claude-tools.js';
import { renderMarkdown } from './markdown.js';

const SETUP_URL = 'https://code.claude.com/docs/en/setup';
const CHAT_KEY = (projectId) => 'claude_chat:' + projectId;
const KEEP_MESSAGES = 200;

// Readable names for the tools in the activity lines.
const ACTIVITY = {
  get_design: 'Reading the design',
  create_screen: 'Creating a screen',
  add_elements: 'Adding elements',
  update_element: 'Updating an element',
  delete_elements: 'Deleting elements',
};

// The spinner Claude Code shows while it works.
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

let panel, promptEl, messagesEl, statusEl, missingEl, chatEl;
let tauri = null;
let found = null;      // Claude Code's path, once looked up; '' when it isn't installed
let loadedFor;         // the project whose chat is shown (undefined until first open)
let session = null;    // that project's Claude Code session id
let lastText = '';     // the message in flight, to resend if its session has gone
let busy = false;
let stopping = false;  // the person pressed stop; the turn's end isn't an error
let saidThisTurn = false; // Claude has said something since the message was sent
const activity = new Map(); // tool call id → { group, item, tool, input }
const waiting = new Set(); // permission cards still waiting for the person
const turnEnd = [];        // what to do once the turn ends (e.g. open another project)

// ── panel ────────────────────────────────────────────────────────────────────
function isOpen() { return document.body.classList.contains('claude-open'); }

async function refreshView() {
  // A found Claude Code is remembered; a missing one is looked for again every
  // time, since it may have been installed — or been mid-update — since.
  if (!found) {
    try {
      const status = await tauri.core.invoke('claude_status');
      found = status.claude || '';
    } catch (error) {
      found = null;
      showToast('Couldn’t check for Claude Code: ' + error);
      return;
    }
  }
  missingEl.hidden = !!found;
  chatEl.hidden = !found;
  if (found && loadedFor !== project()) loadChat();
  if (found && !messagesEl.childElementCount) {
    addMessage({ role: 'assistant', text: 'Hi! Tell me what to design or change — e.g. “a login screen with email, password and a sign-in button”, or “make the buttons on the Home screen rounder”.' });
  }
}

async function open() {
  if (!tauri) { showToast('Claude is available in the Scaffold desktop app'); return; }
  if (state.readonly) { showToast('Viewers can’t edit with Claude'); return; }
  document.body.classList.add('claude-open');
  await refreshView();
  if (found) setTimeout(() => promptEl.focus(), 0);
}

function close() { document.body.classList.remove('claude-open'); }
function toggle() { isOpen() ? close() : open(); }

// ── the project's conversation ───────────────────────────────────────────────
// An unsaved scratch canvas has no id; its chat lives only until the page closes.
function project() { return state.projectId || null; }

function loadChat() {
  loadedFor = project();
  session = null;
  messagesEl.innerHTML = '';
  if (!loadedFor) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CHAT_KEY(loadedFor))); } catch (e) { /* storage unavailable */ }
  if (!saved) return;
  session = saved.session || null;
  // Consecutive calls of one tool share a line, including in older chats that
  // saved each call on its own line.
  const messages = [];
  for (const m of saved.messages || []) {
    const msg = upgrade(m);
    if (!msg) continue;
    const prev = messages[messages.length - 1];
    if (msg.role === 'activity' && prev && prev.role === 'activity' && msg.tool && prev.tool === msg.tool) {
      prev.items.push(...msg.items);
    } else messages.push(msg);
  }
  messages.forEach(addMessage);
  scrollDown();
}

// Chats saved before the terminal view kept each line as { role, text }, with
// tool lines as role "activity" (or "activity failed") and a ✓ / ✕ in front —
// most of them just "Using <tool>".
function upgrade(m) {
  if (!m || !m.role) return null;
  if (m.role === 'activity' && Array.isArray(m.items)) return m;
  const [role, flag] = m.role.split(' ');
  if (role === 'activity') {
    let text = String(m.text || '').replace(/^[✓✕]\s*/, '');
    const using = /^Using ([a-z][a-z0-9_]*)\b(.*)$/.exec(text);
    if (using) text = humanize(using[1]) + using[2];
    return { role: 'activity', tool: using ? using[1] : text, items: [{ ok: flag !== 'failed', text }] };
  }
  if (role === 'thinking') return null;
  if (role === 'permission') return { role: 'note', text: m.text };
  return { role, text: m.text };
}

function saveChat() {
  if (!loadedFor) return;
  const messages = [...messagesEl.children].map(el => el._msg).filter(Boolean).slice(-KEEP_MESSAGES);
  try {
    localStorage.setItem(CHAT_KEY(loadedFor), JSON.stringify({ session, messages }));
  } catch (e) { /* storage unavailable — the session still runs, it just won't be remembered */ }
}

// Look again after the person installs Claude Code, without reopening the app.
async function recheck() {
  found = null;
  await refreshView();
  if (found === '') showToast('Claude Code still isn’t installed');
}

// ── transcript ───────────────────────────────────────────────────────────────
// Each line is an element carrying its message as `_msg`, which is what's saved:
//   { role: 'user' | 'assistant' | 'error' | 'note', text }
//   { role: 'activity', tool, items: [{ ok, text }] } — consecutive calls of one
//   tool, shown as a single line ("… · used 12 times") that expands to each call.
function addMessage(msg) {
  const el = document.createElement('div');
  el.className = 'claude-msg ' + msg.role;
  el._msg = msg;
  if (msg.role === 'activity') {
    el.innerHTML = '<div class="claude-act-line"></div><div class="claude-act-items" hidden></div>';
    el.querySelector('.claude-act-line').addEventListener('click', () => {
      if (el._msg.items.length < 2) return;
      const list = el.querySelector('.claude-act-items');
      list.hidden = !list.hidden;
      el.classList.toggle('open', !list.hidden);
    });
    drawGroup(el);
  } else if (msg.role === 'assistant') {
    el.innerHTML = renderMarkdown(msg.text);
  } else {
    el.textContent = msg.text;
  }
  const stick = nearBottom();
  messagesEl.appendChild(el);
  if (stick) scrollDown();
  return el;
}

function say(role, text) {
  if (role === 'assistant') saidThisTurn = true;
  addMessage({ role, text });
  saveChat();
}

// Follow the transcript as it grows, unless the person has scrolled up to read.
function nearBottom() { return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40; }
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

const clip = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

const humanize = (tool) => {
  const name = String(tool || 'a tool').replace(/^mcp__\w+?__/, '').replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
};

// Scaffold's own tools arrive with their prefix removed (snake_case); Claude
// Code's built-ins are PascalCase and other servers' tools keep "mcp__".
const isScaffoldTool = (tool) => /^[a-z][a-z0-9_]*$/.test(tool);

function drawGroup(el) {
  const { tool, items } = el._msg;
  const pending = items.some(i => i.ok === undefined);
  const failed = items.filter(i => i.ok === false).length;
  let text;
  if (items.length === 1) text = items[0].text;
  else {
    text = `${humanize(tool)} · used ${items.length} times`;
    if (failed) text += ` · ${failed} failed`;
  }
  el.classList.toggle('pending', pending);
  el.classList.toggle('failed', !pending && failed > 0 && failed === items.length);
  el.classList.toggle('partial', !pending && failed > 0 && failed < items.length);
  el.classList.toggle('many', items.length > 1);
  el.querySelector('.claude-act-line').textContent = clip(text, 160);
  const list = el.querySelector('.claude-act-items');
  list.innerHTML = '';
  if (items.length > 1) {
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'claude-act-item' + (item.ok === false ? ' failed' : '');
      row.textContent = clip(item.text, 160);
      list.appendChild(row);
    }
  }
}

// ── status line ──────────────────────────────────────────────────────────────
// While a turn runs, a spinner, what Claude is doing and how long it's been
// going sit above the prompt, so a long step never looks stuck.
let statusTimer = null, statusStart = 0, statusFrame = 0, statusText = '';

function startStatus(text) {
  statusStart = Date.now();
  statusFrame = 0;
  statusText = text;
  statusEl.hidden = false;
  clearInterval(statusTimer);
  statusTimer = setInterval(drawStatus, 120);
  drawStatus();
}

function setStatus(text) { statusText = text; if (statusTimer) drawStatus(); }

function drawStatus() {
  const secs = Math.floor((Date.now() - statusStart) / 1000);
  const time = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  statusEl.querySelector('.claude-spin').textContent = SPINNER[statusFrame++ % SPINNER.length];
  statusEl.querySelector('.claude-status-text').textContent = statusText;
  statusEl.querySelector('.claude-status-time').textContent = `(${time} · `;
}

function stopStatus() {
  clearInterval(statusTimer);
  statusTimer = null;
  statusEl.hidden = true;
}

// What the status line says while tools run: the latest call still going.
function statusForActivity() {
  if (stopping) return;
  const running = [...activity.values()].filter(a => a.item.ok === undefined);
  const last = running[running.length - 1];
  setStatus(last ? describeTool(last.tool, last.input) + '…' : 'Thinking…');
}

function autoGrow() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 160) + 'px';
}

function setBusy(on) {
  busy = on;
  panel.classList.toggle('busy', on);
}

// ── a turn ───────────────────────────────────────────────────────────────────
function stop() {
  if (!busy || stopping) return;
  stopping = true;
  turnEnd.length = 0; // stopped: don't go on to open whatever Claude asked for
  setStatus('Stopping…');
  tauri.core.invoke('claude_stop');
}

async function send() {
  if (busy) return;
  const text = promptEl.value.trim();
  if (!text) return;

  addMessage({ role: 'user', text });
  scrollDown();
  promptEl.value = '';
  autoGrow();
  saveChat();
  activity.clear();
  saidThisTurn = false;
  lastText = text;
  setBusy(true);
  startStatus('Thinking…');
  await ask(text);
}

async function ask(text) {
  try {
    await tauri.core.invoke('claude_ask', { project: project() || '', text, resume: session });
  } catch (error) {
    say('error', String(error));
    finish();
  }
}

function finish() {
  stopping = false;
  // A turn that ended (or was stopped) can't use an answer any more.
  waiting.forEach(settle => settle('expired'));
  // Calls that never answered (the turn was stopped) end as they are.
  for (const { group, item } of activity.values()) {
    if (item.ok === undefined) { item.ok = false; item.text += ' — stopped'; drawGroup(group); }
  }
  activity.clear();
  stopStatus();
  setBusy(false);
  saveChat();
  turnEnd.splice(0).forEach(fn => setTimeout(fn, 300));
}

// ── built-in tools, as the person would say them ─────────────────────────────
function describeTool(tool, input = {}) {
  if (ACTIVITY[tool]) return ACTIVITY[tool];
  switch (tool) {
    case 'Skill': return `Using the ${input.skill || input.command || ''} skill`;
    case 'Bash': case 'PowerShell': return `Running ${clip(input.command)}`;
    case 'Read': return `Reading ${clip(input.file_path)}`;
    case 'Write': return `Writing ${clip(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${clip(input.file_path)}`;
    case 'Glob': case 'Grep': return `Searching for ${clip(input.pattern)}`;
    case 'WebFetch': return `Fetching ${clip(input.url)}`;
    case 'WebSearch': return `Searching the web for ${clip(input.query)}`;
    case 'ToolSearch': return 'Loading tools';
    default: return humanize(tool);
  }
}

// ── permission prompts ───────────────────────────────────────────────────────
// What would ask the person in a terminal asks them here: a box with the
// request and Allow / Deny. Resolves once they choose (or the turn ends).
function askPermission({ tool_name: tool = 'a tool', input = {} }) {
  document.body.classList.add('claude-open');
  const name = tool.replace(/^mcp__\w+?__/, '');
  const card = document.createElement('div');
  card.className = 'claude-msg permission';
  const detail = input.command || input.file_path || input.url || input.query || input.skill
    || (Object.keys(input).length ? JSON.stringify(input) : '');
  card.innerHTML = '<div class="claude-perm-title"></div><pre class="claude-perm-detail"></pre>'
    + '<div class="claude-perm-actions"><button type="button" class="claude-perm-deny">Deny</button>'
    + '<button type="button" class="claude-perm-allow">Allow</button></div>';
  card.querySelector('.claude-perm-title').textContent = `Claude wants to use ${name}`;
  const pre = card.querySelector('.claude-perm-detail');
  if (detail) pre.textContent = detail; else pre.remove();
  messagesEl.appendChild(card);
  scrollDown();
  card.querySelector('.claude-perm-allow').focus();
  setStatus('Waiting for your answer…');

  return new Promise(resolve => {
    const settle = (choice) => {
      waiting.delete(settle);
      const label = { allow: 'Allowed', deny: 'Denied', expired: 'No longer needed' }[choice];
      card.querySelector('.claude-perm-actions').replaceWith(Object.assign(document.createElement('div'), {
        className: 'claude-perm-result ' + choice, textContent: label,
      }));
      // Kept in the saved transcript as a one-line note.
      card._msg = { role: 'note', text: `${label}: ${name}${detail ? ' ' + clip(detail, 120) : ''}` };
      if (busy) statusForActivity();
      saveChat();
      resolve(choice === 'allow' ? { behavior: 'allow' }
        : { behavior: 'deny', message: choice === 'deny' ? 'The person denied this in Scaffold.' : 'The request expired.' });
    };
    waiting.add(settle);
    card.querySelector('.claude-perm-allow').addEventListener('click', () => settle('allow'));
    card.querySelector('.claude-perm-deny').addEventListener('click', () => settle('deny'));
  });
}

// A tool call joins the line above when it's the same tool, called again.
function startCall(id, tool, input) {
  const item = { ok: undefined, text: describeTool(tool, input) };
  const last = messagesEl.lastElementChild;
  let group;
  if (last && last._msg && last._msg.role === 'activity' && last._msg.tool === tool) {
    group = last;
    group._msg.items.push(item);
    drawGroup(group);
  } else {
    group = addMessage({ role: 'activity', tool, items: [item] });
  }
  activity.set(id, { group, item, tool, input });
  statusForActivity();
}

function onEvent({ payload: ev }) {
  if (!ev || !busy) return;
  switch (ev.kind) {
    case 'preparing':
      // Before Claude Code starts (e.g. installing the design skill).
      setStatus(ev.text);
      break;
    case 'said':
      say('assistant', ev.text);
      break;
    case 'using':
      startCall(ev.id, ev.tool, ev.input);
      break;
    case 'answered': {
      const a = activity.get(ev.id);
      if (!a) break;
      // Scaffold's tools answer with a summary written for the person; other
      // tools keep their description (their raw output isn't for the chat),
      // plus the reason when they fail.
      a.item.ok = ev.ok;
      a.item.text = isScaffoldTool(a.tool) ? ev.summary || describeTool(a.tool, a.input)
        : describeTool(a.tool, a.input) + (ev.ok ? '' : ' — ' + ev.summary);
      drawGroup(a.group);
      statusForActivity();
      saveChat();
      break;
    }
    case 'done':
      if (ev.session) session = ev.session;
      if (ev.stopped_by) say('error', ev.stopped_by);
      else if (!ev.ok) say('error', ev.summary || 'Claude Code ran into a problem.');
      else if (!saidThisTurn) say('assistant', ev.summary || 'Done.');
      finish();
      break;
    case 'session_missing':
      // The project's session is gone from Claude Code (its history was
      // cleared, or this is another computer): start a new one and resend.
      session = null;
      ask(lastText);
      break;
    case 'failed':
      if (stopping) { say('note', 'Stopped.'); finish(); break; }
      say('error', ev.detail || 'Claude Code stopped unexpectedly.');
      finish();
      break;
  }
}

export function initAi() {
  panel = document.getElementById('claude-panel');
  if (!panel) return;
  tauri = window.__TAURI__ || null;
  missingEl = document.getElementById('claude-missing');
  chatEl = document.getElementById('claude-chat');
  promptEl = document.getElementById('ai-prompt');
  messagesEl = document.getElementById('claude-messages');
  statusEl = document.getElementById('claude-status');

  document.getElementById('tool-ai')?.addEventListener('click', toggle);
  document.getElementById('claude-close')?.addEventListener('click', close);
  document.getElementById('claude-recheck')?.addEventListener('click', recheck);
  const setup = document.getElementById('claude-setup');
  if (setup) setup.href = SETUP_URL;
  statusEl?.querySelector('.claude-status-stop')?.addEventListener('click', stop);
  // Clicking the transcript's empty space puts the cursor back in the prompt,
  // as in a terminal — but not while selecting text to copy.
  chatEl?.addEventListener('mouseup', e => {
    if (e.target.closest('button, a, .claude-act-line, textarea') || String(window.getSelection())) return;
    promptEl.focus();
  });
  promptEl?.addEventListener('input', autoGrow);
  promptEl?.addEventListener('keydown', e => {
    // As in Claude Code: Esc interrupts a turn in progress; otherwise it closes the panel.
    if (e.key === 'Escape') { e.stopPropagation(); if (busy) stop(); else close(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  if (!tauri) return;
  initClaudeTools({
    onPermission: askPermission,
    // Opening/leaving a project mid-turn would cut Claude off: wait for the turn.
    onTurnEnd: (fn) => { if (busy) turnEnd.push(fn); else setTimeout(fn, 300); },
  });
  tauri.event.listen('claude', onEvent);
  // Leaving the editor mid-turn: stop Claude rather than let it edit a page
  // that's gone.
  window.addEventListener('beforeunload', () => { if (busy) tauri.core.invoke('claude_stop'); });
}
