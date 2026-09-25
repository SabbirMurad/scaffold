// The Claude panel. A chat with the person's own Claude Code, which the desktop
// app runs headless (desktop/src-tauri/src/agent.rs) — no API key, usage counts
// toward their Claude plan. Claude edits the design through Scaffold's tools
// (claude-tools.js); this module is only the conversation: it sends a message,
// then shows the turn as it streams in as `claude` events.
//
// Each project is one Claude Code session. Its session id and the chat shown
// here are kept per project on this machine, so reopening the project — even
// after restarting the app — continues the same conversation.

import { state } from './state.js';
import { showToast } from './utils.js';
import { initClaudeTools } from './claude-tools.js';

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

let panel, promptEl, messagesEl, sendBtn, missingEl, chatEl;
let tauri = null;
let found = null;      // Claude Code's path, once looked up; '' when it isn't installed
let loadedFor;         // the project whose chat is shown (undefined until first open)
let session = null;    // that project's Claude Code session id
let lastText = '';     // the message in flight, to resend if its session has gone
let busy = false;
let stopping = false; // the person pressed stop; the turn's end isn't an error
let pendingEl = null;  // the "Thinking…" bubble, replaced by the first thing Claude says
const activity = new Map(); // tool call id → its line in the chat
const waiting = new Set(); // permission cards still waiting for the person

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
    addMessage('assistant', 'Hi! Tell me what to design or change — e.g. “a login screen with email, password and a sign-in button”, or “make the buttons on the Home screen rounder”.');
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
  (saved.messages || []).forEach(m => addMessage(m.role, m.text));
}

function saveChat() {
  if (!loadedFor) return;
  const messages = [...messagesEl.children]
    .filter(el => !el.classList.contains('thinking'))
    .map(el => ({ role: el.className.replace('claude-msg ', ''), text: el.textContent }))
    .slice(-KEEP_MESSAGES);
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

// ── messages ─────────────────────────────────────────────────────────────────
// `role`: 'user' | 'assistant' | 'error' | 'thinking' | 'activity'.
function addMessage(role, text) {
  const el = document.createElement('div');
  el.className = 'claude-msg ' + role;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function say(role, text) {
  if (pendingEl) {
    pendingEl.className = 'claude-msg ' + role;
    pendingEl.textContent = text;
    pendingEl = null;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return;
  }
  addMessage(role, text);
}

function autoGrow() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
}

// While a turn runs, the send button stops it instead.
function setBusy(on) {
  busy = on;
  sendBtn.classList.toggle('stop', on);
  sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
  sendBtn.title = on ? 'Stop' : '';
}

// ── a turn ───────────────────────────────────────────────────────────────────
async function send() {
  if (busy) { stopping = true; tauri.core.invoke('claude_stop'); return; }
  const text = promptEl.value.trim();
  if (!text) return;

  addMessage('user', text);
  promptEl.value = '';
  autoGrow();
  saveChat();
  pendingEl = addMessage('thinking', 'Thinking…');
  activity.clear();
  lastText = text;
  setBusy(true);
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
  setBusy(false);
  saveChat();
}

// ── built-in tools, as the person would say them ─────────────────────────────
const clip = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

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
    default: return `Using ${tool.replace(/^mcp__\w+?__/, '')}`;
  }
}

// ── permission prompts ───────────────────────────────────────────────────────
// What would ask the person in a terminal asks them here: a card with the
// request and Allow / Deny. Resolves once they choose (or the turn ends).
function askPermission({ tool_name: tool = 'a tool', input = {} }) {
  document.body.classList.add('claude-open');
  if (pendingEl) { pendingEl.remove(); pendingEl = null; }
  const card = document.createElement('div');
  card.className = 'claude-msg permission';
  const detail = input.command || input.file_path || input.url || input.query || input.skill
    || (Object.keys(input).length ? JSON.stringify(input) : '');
  card.innerHTML = '<div class="claude-perm-title"></div><pre class="claude-perm-detail"></pre>'
    + '<div class="claude-perm-actions"><button type="button" class="claude-perm-deny">Deny</button>'
    + '<button type="button" class="claude-perm-allow">Allow</button></div>';
  card.querySelector('.claude-perm-title').textContent = `Claude wants to use ${tool.replace(/^mcp__\w+?__/, '')}`;
  const pre = card.querySelector('.claude-perm-detail');
  if (detail) pre.textContent = detail; else pre.remove();
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  card.querySelector('.claude-perm-allow').focus();

  return new Promise(resolve => {
    const settle = (choice) => {
      waiting.delete(settle);
      const label = { allow: 'Allowed', deny: 'Denied', expired: 'No longer needed' }[choice];
      card.querySelector('.claude-perm-actions').replaceWith(Object.assign(document.createElement('div'), {
        className: 'claude-perm-result ' + choice, textContent: label,
      }));
      resolve(choice === 'allow' ? { behavior: 'allow' }
        : { behavior: 'deny', message: choice === 'deny' ? 'The person denied this in Scaffold.' : 'The request expired.' });
    };
    waiting.add(settle);
    card.querySelector('.claude-perm-allow').addEventListener('click', () => settle('allow'));
    card.querySelector('.claude-perm-deny').addEventListener('click', () => settle('deny'));
  });
}

function onEvent({ payload: ev }) {
  if (!ev || !busy) return;
  switch (ev.kind) {
    case 'said':
      say('assistant', ev.text);
      break;
    case 'using':
      if (pendingEl) { pendingEl.remove(); pendingEl = null; }
      activity.set(ev.id, { el: addMessage('activity', describeTool(ev.tool, ev.input) + '…'), tool: ev.tool, input: ev.input });
      break;
    case 'answered': {
      const a = activity.get(ev.id);
      if (!a) break;
      activity.delete(ev.id);
      // Scaffold's tools answer with a summary written for the person; other
      // tools keep their description (their raw output isn't for the chat),
      // plus the reason when they fail.
      const text = ACTIVITY[a.tool] ? ev.summary || describeTool(a.tool, a.input)
        : describeTool(a.tool, a.input) + (ev.ok ? '' : ' — ' + ev.summary);
      a.el.textContent = (ev.ok ? '✓ ' : '✕ ') + clip(text, 160);
      a.el.classList.toggle('failed', !ev.ok);
      break;
    }
    case 'done':
      if (ev.session) session = ev.session;
      if (ev.stopped_by) say('error', ev.stopped_by);
      else if (!ev.ok) say('error', ev.summary || 'Claude Code ran into a problem.');
      else if (pendingEl) say('assistant', ev.summary || 'Done.');
      finish();
      break;
    case 'session_missing':
      // The project's session is gone from Claude Code (its history was
      // cleared, or this is another computer): start a new one and resend.
      session = null;
      ask(lastText);
      break;
    case 'failed':
      if (stopping) { say('activity', 'Stopped.'); finish(); break; }
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
  sendBtn = document.getElementById('ai-send');

  document.getElementById('tool-ai')?.addEventListener('click', toggle);
  document.getElementById('claude-close')?.addEventListener('click', close);
  document.getElementById('claude-recheck')?.addEventListener('click', recheck);
  const setup = document.getElementById('claude-setup');
  if (setup) setup.href = SETUP_URL;
  sendBtn?.addEventListener('click', send);
  promptEl?.addEventListener('input', autoGrow);
  promptEl?.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  if (!tauri) return;
  initClaudeTools({ onPermission: askPermission });
  tauri.event.listen('claude', onEvent);
  // Leaving the editor mid-turn: stop Claude rather than let it edit a page
  // that's gone.
  window.addEventListener('beforeunload', () => { if (busy) tauri.core.invoke('claude_stop'); });
}
