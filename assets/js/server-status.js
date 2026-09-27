// The "server is down" screen. When Scaffold's server can't be reached (or
// can't reach its database), the page is covered by a screen saying so instead
// of showing a trail of errors, and the server is checked again every minute
// until it answers; then the page picks up where it was.
//
// Checked when a page opens (watchServer) and whenever a request fails in a way
// that points at the server rather than the request (reportUnreachable, from
// Fetcher): no connection, or 502 / 503 / 504 from the proxy in front of it.
// Either way the health endpoint confirms before the screen shows, so one
// dropped request doesn't take over the page.

const HEALTH = '/api/v1/health';
const POLL_SECONDS = 60;
const TIMEOUT_MS = 8000;

let screen = null;
let down = false;
let verifying = null;   // the health check in flight, shared by everyone asking
let nextCheck = 0;      // when the next automatic check runs (ms timestamp)
let ticker = null;
let options = { detail: '', onRecover: null };

export const serverIsDown = () => down;

// Status codes that mean the server (or the proxy's route to it) is down.
export const isServerDownStatus = (status) => status === -1 || status === 502 || status === 503 || status === 504;

async function healthy() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch((window.projectDomain || '') + HEALTH, { cache: 'no-store', signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Check the server; show the screen if it's down. Resolves to whether it's up.
export function checkServer() {
  if (!verifying) {
    verifying = healthy().then(up => {
      verifying = null;
      if (!up) showDown(); else if (down) recover();
      return up;
    });
  }
  return verifying;
}

// A request failed as if the server were down: confirm, and show the screen if so.
export function reportUnreachable() { return down ? Promise.resolve(false) : checkServer(); }

// Start watching from this page. `detail`: a line about the person's work on
// this page; `onRecover`: what to do once the server is back (default: reload,
// so everything that failed loads again).
export function watchServer(opts = {}) {
  options = { ...options, ...opts };
  checkServer();
  // Back online after being offline: don't wait for the next minute.
  window.addEventListener('online', () => { if (down) checkNow(); });
}

// ── the screen ───────────────────────────────────────────────────────────────
function showDown() {
  if (down) return;
  down = true;
  if (!screen) screen = build();
  document.body.appendChild(screen);
  document.body.classList.add('server-down');
  screen.querySelector('.srv-retry').focus();
  schedule();
}

function recover() {
  down = false;
  clearInterval(ticker);
  ticker = null;
  if (options.onRecover) {
    screen.remove();
    document.body.classList.remove('server-down');
    options.onRecover();
  } else {
    setStatus('Back up — reloading…', true);
    window.location.reload();
  }
}

function schedule() {
  nextCheck = Date.now() + POLL_SECONDS * 1000;
  clearInterval(ticker);
  ticker = setInterval(tick, 1000);
  tick();
}

function tick() {
  const left = Math.max(0, Math.ceil((nextCheck - Date.now()) / 1000));
  if (left === 0) { checkNow(); return; }
  setStatus(`Checking again in ${left}s`);
}

async function checkNow() {
  if (!down) return;
  clearInterval(ticker);
  ticker = null;
  setStatus('Checking…', true);
  screen.querySelector('.srv-retry').disabled = true;
  const up = await checkServer();
  if (!up) {
    screen.querySelector('.srv-retry').disabled = false;
    schedule();
  }
}

function setStatus(text, busy = false) {
  if (!screen) return;
  screen.querySelector('.srv-status-text').textContent = text;
  screen.querySelector('.srv-status').classList.toggle('busy', busy);
}

function build() {
  const el = document.createElement('div');
  el.className = 'srv-screen';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'srv-title');
  el.innerHTML = `
    <div class="srv-card">
      <svg class="srv-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 0 1 2.35 8.34"/><path d="M3 3l18 18"/>
      </svg>
      <h1 id="srv-title">Scaffold’s server is down</h1>
      <p class="srv-text">We’re working on it and it’ll be back soon.</p>
      <p class="srv-text srv-detail" hidden></p>
      <div class="srv-status" aria-live="polite"><span class="srv-spinner" aria-hidden="true"></span><span class="srv-status-text"></span></div>
      <button type="button" class="srv-retry">Try again now</button>
    </div>`;
  const detail = el.querySelector('.srv-detail');
  if (options.detail) { detail.textContent = options.detail; detail.hidden = false; }
  el.querySelector('.srv-retry').addEventListener('click', checkNow);
  // Keep keyboard focus inside the screen (it's the only thing to do).
  el.addEventListener('keydown', e => { if (e.key === 'Tab') { e.preventDefault(); el.querySelector('.srv-retry').focus(); } });
  return el;
}
