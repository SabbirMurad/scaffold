// Project API client — thin wrappers over the /api/v1/project endpoints, built
// on the shared Fetcher. Every call carries the bearer access token, and a 401
// triggers a single silent token refresh + retry before giving up.

import { Fetcher } from './fetcher.js';
import { getAuth, refreshToken } from './session.js';

function authHeader(token) {
  const t = token || (getAuth() && getAuth().access_token);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// Run a Fetcher method with auth; on 401, refresh once and retry.
async function authed(method, opts) {
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
export const deleteProject  = (id)              => authed('delete', { endpoint: `/v1/project/${id}` });
export const requestAccess  = (id)              => authed('post',   { endpoint: `/v1/project/${id}/request-access` });

// ── Collaborators ──
export const listCollaborators   = (id)                   => authed('get',    { endpoint: `/v1/project/${id}/collaborators` });
export const inviteCollaborator  = (id, email, role)      => authed('post',   { endpoint: `/v1/project/${id}/collaborators`, body: { email_address: email, role } });
export const respondInvite       = (id, inviteId, status) => authed('patch',  { endpoint: `/v1/project/${id}/collaborators/${inviteId}`, body: { status } });
export const setCollaboratorRole = (id, inviteId, role)   => authed('put',    { endpoint: `/v1/project/${id}/collaborators/${inviteId}`, body: { role } });
export const removeCollaborator  = (id, inviteId)         => authed('delete', { endpoint: `/v1/project/${id}/collaborators/${inviteId}` });

// Pending invites addressed to the current user (across all projects).
export const myInvites = () => authed('get', { endpoint: '/v1/invites' });
