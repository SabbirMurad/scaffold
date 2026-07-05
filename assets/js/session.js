// Client-side session helpers shared across pages. The auth payload (tokens +
// user id/role) is persisted by the auth page on sign-in; other pages read it
// here and clear it on logout.

import { Fetcher } from './fetcher.js';

const AUTH_KEY = 'ff_auth';

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
