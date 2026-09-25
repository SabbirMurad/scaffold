// Project API client — thin wrappers over the /api/v1/project endpoints, built
// on the shared Fetcher. Every call carries the bearer access token, and a 401
// triggers a single silent token refresh + retry before giving up.

import { Fetcher } from './fetcher.js';
import { getAuth, refreshToken } from './session.js';

function authHeader(token) {
  const t = token || (getAuth() && getAuth().access_token);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// Run a Fetcher method with auth; on 401, refresh once and retry. Exported so
// sibling API clients (e.g. feedback.js) share the same auth + refresh behaviour.
export async function authed(method, opts) {
  const call = (headers) => Fetcher[method]({ ...opts, headers, showError: false });
  let res = await call(authHeader());
  if (res.status === 401) {
    const fresh = await refreshToken();
    if (fresh) res = await call(authHeader(fresh));
  }
  return res;
}

// ── Projects ──
export const listProjects   = ()               => authed('get',    { endpoint: '/v1/project' });
export const createProject  = (body)            => authed('post',   { endpoint: '/v1/project', body });
export const getProject     = (id)              => authed('get',    { endpoint: `/v1/project/${id}` });
export const saveProjectDoc = (id, content, version) => authed('put', { endpoint: `/v1/project/${id}`, body: { content, version } });
export const updateProject  = (id, body)        => authed('patch',  { endpoint: `/v1/project/${id}`, body });
// Pin/unpin is per-user state, not shared metadata, so it has its own endpoint.
export const pinProject     = (id, pinned)      => authed('post',   { endpoint: `/v1/project/${id}/pin`, body: { pinned } });
export const deleteProject  = (id)              => authed('delete', { endpoint: `/v1/project/${id}` });
// Owner: turn the public view link on / off → { public_token } (null when off).
export const setPublicLink  = (id, enabled)     => authed('post',   { endpoint: `/v1/project/${id}/public-link`, body: { enabled } });

// ── Public view link (no account) ──
const pub = (token) => `/v1/public/${encodeURIComponent(token)}`;
export const getPublicProject  = (token) => Fetcher.get({ endpoint: pub(token), showError: false });
export const getPublicComments = (token) => Fetcher.get({ endpoint: `${pub(token)}/comments`, showError: false });
export const requestAccess  = (id)              => authed('post',   { endpoint: `/v1/project/${id}/request-access` });

// ── Collaborators ──
export const listCollaborators   = (id)                   => authed('get',    { endpoint: `/v1/project/${id}/collaborators` });
export const inviteCollaborator  = (id, email, role)      => authed('post',   { endpoint: `/v1/project/${id}/collaborators`, body: { email_address: email, role } });
export const respondInvite       = (id, inviteId, status) => authed('patch',  { endpoint: `/v1/project/${id}/collaborators/${inviteId}`, body: { status } });
export const setCollaboratorRole = (id, inviteId, role)   => authed('put',    { endpoint: `/v1/project/${id}/collaborators/${inviteId}`, body: { role } });
export const removeCollaborator  = (id, inviteId)         => authed('delete', { endpoint: `/v1/project/${id}/collaborators/${inviteId}` });

// ── Comments ──
export const listComments   = (id)                => authed('get',    { endpoint: `/v1/project/${id}/comments` });
export const createComment  = (id, x, y, text)    => authed('post',   { endpoint: `/v1/project/${id}/comments`, body: { x, y, text } });
export const replyComment   = (id, cid, text)     => authed('post',   { endpoint: `/v1/project/${id}/comments/${cid}/messages`, body: { text } });
export const resolveComment = (id, cid, resolved) => authed('patch',  { endpoint: `/v1/project/${id}/comments/${cid}`, body: { resolved } });
export const deleteComment  = (id, cid)           => authed('delete', { endpoint: `/v1/project/${id}/comments/${cid}` });

// Pending invites addressed to the current user (across all projects).
export const myInvites = () => authed('get', { endpoint: '/v1/invites' });

// The signed-in user's profile (name/email/avatar), resolved from the token.
export const getMe = () => authed('get', { endpoint: '/v1/auth/me' });

// ── AI ──
// Text-to-design: describe a screen, get back a compact design DSL to render.
export const generateDesign = (prompt, device) => authed('post', { endpoint: '/v1/ai/generate', body: { prompt, device } });
