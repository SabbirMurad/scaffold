// Share requests — persisted in localStorage so an invite created in the editor
// shows up in the home page's Requests tab. Demo only: no real collaboration or
// access control happens, this just models the flow across the two pages.

const KEY = 'frameforge_shares';
const SEED_FLAG = 'frameforge_shares_seeded';

// Populate the Requests tab with a few example join-requests the first time the
// dashboard loads, so it isn't empty before the user has invited anyone. Runs
// once ever (guarded by a flag) and never clobbers real data. Projects here match
// the demo project names in home.js.
export function seedDemoShares() {
  try {
    if (localStorage.getItem(SEED_FLAG)) return; // already seeded before
    localStorage.setItem(SEED_FLAG, '1');
    if (getShares().length) return; // real invites already exist — leave them alone
    const now = Date.now();
    const demo = [
      { email: 'maria.chen@example.com',  project: 'Mobile Banking App', role: 'editor', status: 'pending',  hrsAgo: 2 },
      { email: 'devon.park@example.com',   project: 'E-commerce Store',   role: 'viewer', status: 'pending',  hrsAgo: 6 },
      { email: 'liam.nguyen@example.com',  project: 'Fitness Tracker',    role: 'editor', status: 'pending',  hrsAgo: 26 },
      { email: 'aisha.khan@example.com',   project: 'Mobile Banking App', role: 'editor', status: 'accepted', hrsAgo: 72 },
    ];
    save(demo.map((d, i) => ({
      id: 's' + (now - i) + Math.floor(Math.random() * 1000),
      email: d.email,
      project: d.project,
      role: d.role,
      status: d.status,
      date: now - d.hrsAgo * 3600 * 1000,
    })));
  } catch { /* storage unavailable */ }
}

export function getShares() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

export const ROLES = ['viewer', 'editor', 'owner']; // access levels, least → most

export function addShare(email, project, role = 'editor') {
  const list = getShares();
  list.unshift({
    id: 's' + Date.now() + Math.floor(Math.random() * 1000),
    email,
    project: project || 'Untitled',
    role: ROLES.includes(role) ? role : 'editor', // viewer | editor | owner
    status: 'pending', // pending | accepted | declined
    date: Date.now(),
  });
  save(list);
}

export function setShareStatus(id, status) {
  const list = getShares();
  const r = list.find(x => x.id === id);
  if (r) { r.status = status; save(list); }
  return list;
}

export function removeShare(id) {
  save(getShares().filter(x => x.id !== id));
  return getShares();
}

export function setShareRole(id, role) {
  if (!ROLES.includes(role)) return getShares();
  const list = getShares();
  const r = list.find(x => x.id === id);
  if (r) { r.role = role; save(list); }
  return list;
}

// Everyone this project has been shared with (excludes declined invites).
export function sharesFor(project) {
  return getShares().filter(r => r.project === (project || 'Untitled') && r.status !== 'declined');
}

export function pendingCount() {
  return getShares().filter(r => r.status === 'pending').length;
}
