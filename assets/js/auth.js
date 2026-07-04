// Authentication page (UI scaffold). Toggles between Sign in / Sign up and, on
// submit, sends the user to the home page. No real authentication happens here —
// credentials are not validated, stored, or sent anywhere.

const tabs = document.querySelectorAll('.auth-tab');
const title = document.getElementById('auth-title');
const sub = document.getElementById('auth-sub');
const submit = document.getElementById('auth-submit');
const foot = document.getElementById('auth-foot');
const pwInput = document.getElementById('auth-password');

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
const otpBoxes = [...document.querySelectorAll('.otp-box')];
const emailInput = document.getElementById('auth-email');

function showOtp() {
  // Repurpose the shared title/sub for the verification step.
  const email = (emailInput.value || 'your email').trim();
  title.textContent = 'Verify your email';
  sub.innerHTML = `Enter the 6-digit code we sent to <strong>${email}</strong>.`;
  mainView.hidden = true;
  otpView.hidden = false;
  otpBoxes.forEach(b => { b.value = ''; b.classList.remove('filled'); });
  otpBoxes[0].focus();
}

function showForm() {
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
wireOtpBoxes(otpBoxes);

document.getElementById('otp-back')?.addEventListener('click', showForm);
document.getElementById('otp-resend')?.addEventListener('click', () => {
  otpBoxes.forEach(b => { b.value = ''; b.classList.remove('filled'); });
  otpBoxes[0].focus();
});

// Demo only — no real code is sent or checked.
// Sign up → OTP verification step; sign in → straight to the dashboard.
document.getElementById('auth-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (document.body.classList.contains('signup')) showOtp();
  else window.location.href = '/dashboard';
});

// Verifying the code (any value, demo) finishes onboarding.
document.getElementById('otp-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  window.location.href = '/dashboard';
});

// Social sign-in (demo scaffold — no real OAuth). Like the email flow, it just
// continues to the dashboard; OAuth providers are pre-verified, so no OTP step.
document.querySelectorAll('.auth-social-btn').forEach((btn) => {
  btn.addEventListener('click', () => { window.location.href = '/dashboard'; });
});

// ───────── Forgot password (request code → verify code → set new password) ─────────
// Demo only — no real code is sent or checked, and no password is stored.
const resetView = document.getElementById('auth-reset');
const resetEmail = document.getElementById('reset-email');
const resetBoxes = [...document.querySelectorAll('.reset-box')];
const resetSteps = {
  request: document.getElementById('reset-request'),
  code: document.getElementById('reset-code'),
  new: document.getElementById('reset-new'),
};
wireOtpBoxes(resetBoxes);

// Shared title/sub copy per reset step (reuses the card's heading like the OTP flow).
const RESET_COPY = {
  request: () => ['Reset password', 'Enter your email and we’ll send you a reset code.'],
  code: () => ['Check your email', `Enter the 6-digit code we sent to <strong>${(resetEmail.value || 'your email').trim()}</strong>.`],
  new: () => ['Set a new password', 'Choose a new password for your account.'],
};

function showReset(step) {
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

resetSteps.request.addEventListener('submit', (e) => { e.preventDefault(); showReset('code'); });
resetSteps.code.addEventListener('submit', (e) => { e.preventDefault(); showReset('new'); });
resetSteps.new.addEventListener('submit', (e) => {
  e.preventDefault();
  const pw = document.getElementById('reset-pw').value;
  const pw2 = document.getElementById('reset-pw2').value;
  const err = document.getElementById('reset-error');
  if (!pw || pw !== pw2) { err.hidden = false; return; }
  err.hidden = true;
  backToSignIn();
  sub.textContent = 'Password updated — sign in with your new password.';
});

document.getElementById('reset-resend')?.addEventListener('click', () => {
  clearBoxes(resetBoxes);
  resetBoxes[0].focus();
});
document.getElementById('reset-back')?.addEventListener('click', backToSignIn);

setMode('signin');
