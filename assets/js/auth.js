// Authentication page — wired to the Rust auth API under /api/v1/auth.
// Flows: sign in, sign up → email OTP verification, and forgot-password
// (request code → verify code → set new password), plus social sign-in.
// On success the auth payload (access/refresh tokens) is stored and the user
// is sent to the dashboard; the sign-in endpoint also sets a session cookie.

import { Fetcher } from './fetcher.js';

// Auth endpoints live under /api/v1/auth; Fetcher prefixes /api, so paths here
// start at /v1/auth.
const API_BASE = '/v1/auth';
const AUTH_KEY = 'ff_auth';

const tabs = document.querySelectorAll('.auth-tab');
const title = document.getElementById('auth-title');
const sub = document.getElementById('auth-sub');
const submit = document.getElementById('auth-submit');
const foot = document.getElementById('auth-foot');
const pwInput = document.getElementById('auth-password');
const nameInput = document.getElementById('auth-name');

// ───────── API + feedback helpers ─────────

// A small message banner under the subtitle, shared by every view.
const flashEl = document.createElement('div');
flashEl.className = 'auth-flash';
flashEl.hidden = true;
sub.insertAdjacentElement('afterend', flashEl);

function flash(message, kind = 'error') {
  flashEl.textContent = message;
  flashEl.className = `auth-flash ${kind}`;
  flashEl.hidden = false;
}
function clearFlash() { flashEl.hidden = true; }

// Disable a button and swap its label while a request is in flight.
function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    if (btn.dataset.label == null) btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.textContent = label || 'Please wait…';
  } else {
    btn.disabled = false;
    if (btn.dataset.label != null) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
  }
}

// JSON request to the auth API via the shared Fetcher. Resolves with the parsed
// body on 2xx; rejects with an Error carrying the server's `message` otherwise.
// `showError` is off so the auth card surfaces failures through its own flash
// banner rather than a global toast.
async function api(path, body, method = 'POST') {
  const endpoint = API_BASE + path;
  const res = method === 'GET'
    ? await Fetcher.get({ endpoint, showError: false })
    : await Fetcher.post({ endpoint, body, showError: false });
  if (!res.ok) throw new Error(res.error || 'Request failed. Please try again.');
  return res.data || {};
}

// Persist the auth payload for the rest of the app, then continue to the
// dashboard — or back to a `?next=` target (e.g. a shared project link), as long
// as it's a same-origin path so it can't be used to redirect off-site.
function completeAuth(payload) {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({
      access_token: payload.access_token,
      access_token_valid_till: payload.access_token_valid_till,
      refresh_token: payload.refresh_token,
      user_id: payload.user_id,
      role: payload.role,
    }));
  } catch { /* storage unavailable — session cookie still applies */ }
  const next = new URLSearchParams(window.location.search).get('next');
  window.location.href = (next && /^\/(?!\/)/.test(next)) ? next : '/dashboard.html';
}

// ───────── Sign in / Sign up mode toggle ─────────

const COPY = {
  signin: {
    title: 'Welcome back', sub: 'Sign in to your account to continue.', submit: 'Sign in',
    foot: 'Don’t have an account? <a id="auth-switch">Sign up</a>', autocomplete: 'current-password',
  },
  signup: {
    title: 'Create your account', sub: 'Start designing in minutes.', submit: 'Sign up',
    foot: 'Already have an account? <a id="auth-switch">Sign in</a>', autocomplete: 'new-password',
  },
};

function setMode(mode) {
  clearFlash();
  document.body.classList.toggle('signup', mode === 'signup');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  const c = COPY[mode];
  title.textContent = c.title;
  sub.textContent = c.sub;
  submit.textContent = c.submit;
  foot.innerHTML = c.foot;
  pwInput.setAttribute('autocomplete', c.autocomplete);
  // The footer link is re-created, so (re)bind it to flip to the other mode.
  document.getElementById('auth-switch')?.addEventListener('click', () => {
    setMode(mode === 'signin' ? 'signup' : 'signin');
  });
}

tabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));

// ───────── Views: credentials form ⇄ OTP verification ─────────
const mainView = document.getElementById('auth-main');
const otpView = document.getElementById('auth-otp');
const otpBoxes = [...document.querySelectorAll('#auth-otp .otp-box')];
const emailInput = document.getElementById('auth-email');

// The account awaiting email verification (set by a successful sign-up).
let pendingUserId = null;

function showOtp() {
  clearFlash();
  const email = (emailInput.value || 'your email').trim();
  title.textContent = 'Verify your email';
  sub.innerHTML = `Enter the 6-digit code we sent to <strong>${email}</strong>.`;
  mainView.hidden = true;
  otpView.hidden = false;
  clearBoxes(otpBoxes);
  otpBoxes[0].focus();
}

function showForm() {
  clearFlash();
  otpView.hidden = true;
  mainView.hidden = false;
  setMode('signup'); // OTP only comes from sign-up, so return there
}

// Wire a group of single-digit code boxes: one digit each, auto-advance /
// backspace, and paste support. Shared by the sign-up OTP and the reset code.
function wireOtpBoxes(boxes) {
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      box.classList.toggle('filled', !!box.value);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
    });
    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, boxes.length);
      digits.split('').forEach((d, j) => { boxes[j].value = d; boxes[j].classList.add('filled'); });
      boxes[Math.min(digits.length, boxes.length - 1)].focus();
    });
  });
}
const clearBoxes = (boxes) => boxes.forEach(b => { b.value = ''; b.classList.remove('filled'); });
const codeOf = (boxes) => boxes.map(b => b.value).join('');
wireOtpBoxes(otpBoxes);

document.getElementById('otp-back')?.addEventListener('click', showForm);
document.getElementById('otp-resend')?.addEventListener('click', async (e) => {
  if (!pendingUserId) { flash('Start by creating an account first.'); return; }
  const link = e.target;
  link.style.pointerEvents = 'none';
  try {
    await api('/resend-verification-code', { user_id: pendingUserId });
    clearBoxes(otpBoxes); otpBoxes[0].focus();
    flash('A new code is on its way.', 'success');
  } catch (err) {
    flash(err.message);
  } finally {
    link.style.pointerEvents = '';
  }
});

// Sign in → dashboard; sign up → create account, then OTP verification.
document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFlash();
  const isSignup = document.body.classList.contains('signup');
  const email = emailInput.value.trim();
  const password = pwInput.value;

  if (!email || !password) { flash('Email and password are required.'); return; }

  if (isSignup) {
    const fullName = nameInput.value.trim();
    if (!fullName) { flash('Please enter your name.'); return; }
    if (password.length < 6) { flash('Password must be at least 6 characters.'); return; }
    busy(submit, true, 'Creating account…');
    try {
      // No separate confirm field in the UI — the single password is confirmed.
      const res = await api('/sign-up', {
        full_name: fullName, email_address: email,
        password, confirm_password: password,
      });
      pendingUserId = res.user_id;
      showOtp();
    } catch (err) {
      flash(err.message);
    } finally {
      busy(submit, false);
    }
  } else {
    busy(submit, true, 'Signing in…');
    try {
      const res = await api('/sign-in', { email_or_username: email, password });
      if (res.auth_payload) completeAuth(res.auth_payload);
      else flash('Two-factor sign-in isn’t supported here yet.');
    } catch (err) {
      flash(err.message);
    } finally {
      busy(submit, false);
    }
  }
});

// Verifying the emailed code finishes onboarding and signs the user in.
document.getElementById('otp-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFlash();
  const code = codeOf(otpBoxes);
  if (code.length < 6) { flash('Enter the full 6-digit code.'); return; }
  if (!pendingUserId) { flash('Your session expired — please sign up again.'); return; }
  const verifyBtn = document.getElementById('otp-verify');
  busy(verifyBtn, true, 'Verifying…');
  try {
    const res = await api('/validate-email', { user_id: pendingUserId, verification_code: code });
    completeAuth(res);
  } catch (err) {
    flash(err.message);
    busy(verifyBtn, false);
  }
});

// Social sign-in. Real OAuth needs a Firebase ID token (see social_login.rs);
// when a provider integration exposes `window.ffSocialToken(provider)`, use it,
// otherwise tell the user it isn't configured rather than faking a login.
document.querySelectorAll('.auth-social-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const provider = btn.dataset.provider;
    clearFlash();
    if (typeof window.ffSocialToken !== 'function') {
      flash(`${provider} sign-in isn’t configured yet.`, 'info');
      return;
    }
    busy(btn, true, 'Connecting…');
    try {
      const token = await window.ffSocialToken(provider);
      const res = await api('/social-login', { provider, token });
      completeAuth(res);
    } catch (err) {
      flash(err.message);
    } finally {
      busy(btn, false);
    }
  });
});

// ───────── Forgot password (request code → verify code → set new password) ─────────
const resetView = document.getElementById('auth-reset');
const resetEmail = document.getElementById('reset-email');
const resetBoxes = [...document.querySelectorAll('.reset-box')];
const resetSteps = {
  request: document.getElementById('reset-request'),
  code: document.getElementById('reset-code'),
  new: document.getElementById('reset-new'),
};
wireOtpBoxes(resetBoxes);

// The account being reset (resolved from the email) and, after code
// verification, the secret key that authorizes the password change.
let resetUserId = null;
let resetSecret = null;

// Shared title/sub copy per reset step (reuses the card's heading like the OTP flow).
const RESET_COPY = {
  request: () => ['Reset password', 'Enter your email and we’ll send you a reset code.'],
  code: () => ['Check your email', `Enter the 6-digit code we sent to <strong>${(resetEmail.value || 'your email').trim()}</strong>.`],
  new: () => ['Set a new password', 'Choose a new password for your account.'],
};

function showReset(step) {
  clearFlash();
  mainView.hidden = true;
  otpView.hidden = true;
  resetView.hidden = false;
  const [t, s] = RESET_COPY[step]();
  title.textContent = t;
  sub.innerHTML = s;
  Object.entries(resetSteps).forEach(([k, form]) => { form.hidden = k !== step; });
  document.getElementById('reset-resend-foot').hidden = step !== 'code';
  if (step === 'code') { clearBoxes(resetBoxes); resetBoxes[0].focus(); }
  else if (step === 'request') { resetEmail.focus(); }
}

// Return to the sign-in form from any other view.
function backToSignIn() {
  otpView.hidden = true;
  resetView.hidden = true;
  mainView.hidden = false;
  setMode('signin');
}

// Prefill the reset email with whatever was typed on the sign-in form.
document.getElementById('auth-forgot-link')?.addEventListener('click', () => {
  if (emailInput.value) resetEmail.value = emailInput.value;
  showReset('request');
});

// Step 1 — resolve the email to a user id, then request a reset code.
resetSteps.request.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFlash();
  const email = resetEmail.value.trim();
  if (!email) { flash('Enter your email address.'); return; }
  const btn = resetSteps.request.querySelector('.auth-submit');
  busy(btn, true, 'Sending…');
  try {
    const user = await api(`/user/${encodeURIComponent(email)}`, undefined, 'GET');
    resetUserId = user.user_id;
    await api('/forgot-password', { user_id: resetUserId });
    showReset('code');
  } catch (err) {
    flash(err.message);
  } finally {
    busy(btn, false);
  }
});

// Step 2 — verify the code, capturing the secret key for step 3.
resetSteps.code.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFlash();
  const code = codeOf(resetBoxes);
  if (code.length < 6) { flash('Enter the full 6-digit code.'); return; }
  const btn = resetSteps.code.querySelector('.auth-submit');
  busy(btn, true, 'Verifying…');
  try {
    const res = await api('/verify-reset-code', { user_id: resetUserId, validation_code: code });
    resetSecret = res.secret_key;
    showReset('new');
  } catch (err) {
    flash(err.message);
  } finally {
    busy(btn, false);
  }
});

// Step 3 — set the new password.
resetSteps.new.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFlash();
  const pw = document.getElementById('reset-pw').value;
  const pw2 = document.getElementById('reset-pw2').value;
  const err = document.getElementById('reset-error');
  if (!pw || pw !== pw2) { err.hidden = false; return; }
  err.hidden = true;
  const btn = resetSteps.new.querySelector('.auth-submit');
  busy(btn, true, 'Saving…');
  try {
    await api('/reset-password', {
      user_id: resetUserId, secret_key: resetSecret,
      new_password: pw, confirm_password: pw2,
    });
    backToSignIn();
    sub.textContent = 'Password updated — sign in with your new password.';
  } catch (e2) {
    flash(e2.message);
  } finally {
    busy(btn, false);
  }
});

document.getElementById('reset-resend')?.addEventListener('click', async () => {
  if (!resetUserId) { flash('Start the reset from your email again.'); return; }
  try {
    await api('/forgot-password', { user_id: resetUserId });
    clearBoxes(resetBoxes); resetBoxes[0].focus();
    flash('A new code is on its way.', 'success');
  } catch (err) {
    flash(err.message);
  }
});
document.getElementById('reset-back')?.addEventListener('click', backToSignIn);

setMode('signin');
