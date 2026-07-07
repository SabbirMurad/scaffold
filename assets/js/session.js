// Client-side session helpers shared across pages. The auth payload (tokens +
// user id/role) is persisted by the auth page on sign-in; other pages read it
// here and clear it on logout.

import { Fetcher } from './fetcher.js';

const AUTH_KEY = 'ff_auth';

// A data-URI SVG avatar of a name's initials on a deterministic coloured circle —
// used when the user has no profile picture set (replaces the static "SH" icon).
export function initialsAvatar(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  const initials = parts.length
    ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
    : '?';
  let h = 0;
  for (const ch of (name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">`
    + `<rect width="72" height="72" rx="36" fill="hsl(${h},45%,45%)"/>`
    + `<text x="36" y="36" dy="0.35em" text-anchor="middle" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="30" font-weight="600" fill="#fff">${initials}</text>`
    + `</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// The stored auth payload, or null when signed out / never signed in.
export function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || null; }
  catch { return null; }
}

// Exchange the stored refresh token for a fresh access token, updating the
// stored payload. Returns the new access token, or null when refresh fails
// (expired/blocked → the caller should send the user back to sign in).
export async function refreshToken() {
  const auth = getAuth();
  if (!auth || !auth.refresh_token) return null;
  const res = await Fetcher.post({
    endpoint: '/v1/auth/refresh',
    showError: false,
    body: { refresh_token: auth.refresh_token, user_id: auth.user_id, role: auth.role },
  });
  if (res.ok && res.data && res.data.access_token) {
    const updated = {
      ...auth,
      access_token: res.data.access_token,
      access_token_valid_till: res.data.access_token_valid_till,
    };
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(updated)); } catch { /* storage unavailable */ }
    return updated.access_token;
  }
  return null;
}

// Purge the server session (best-effort) and the local tokens, then return to
// the authentication page.
export async function logout() {
  // Best-effort server purge; clear tokens locally regardless of the outcome.
  await Fetcher.post({ endpoint: '/v1/auth/sign-out', showError: false });
  try { localStorage.removeItem(AUTH_KEY); } catch { /* storage unavailable */ }
  window.location.href = '/authentication';
}
