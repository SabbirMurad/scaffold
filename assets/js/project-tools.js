// Project tools for Scaffold's MCP server: list, create, open, pin and delete
// projects. Unlike the design tools (claude-tools.js), which act on the design
// open in the editor, these act on the person's project list, so both the
// editor and the dashboard answer them (the dashboard answers only these).
//
// Deleting always asks the person first, in the page. Opening a project loads
// another page, so it waits until the current Claude turn (if any) has ended —
// `later` runs it then.

import { listProjects, createProject, deleteProject, pinProject } from './projects.js';
import { confirmModal } from './confirm.js';
import { inTabs, openProject, closeThisTab } from './tabs.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });

export const PROJECT_TOOLS = [
  {
    name: 'list_projects', title: 'List projects',
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: 'The person\'s projects: id, name, whether they own it (only owners can delete), whether it\'s pinned, when it was last edited, and which one is open now.',
    inputSchema: obj({}),
  },
  {
    name: 'create_project', title: 'Create project',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Create a new, empty project owned by the person. Returns its id. "open": true opens it once your turn ends (the person\'s conversation with you is per project, so opening ends this one).',
    inputSchema: obj({ name: str('The project\'s name.'), open: bool('Open it when your turn ends.') }, ['name']),
  },
  {
    name: 'open_project', title: 'Open project',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Open a project in the editor (by id, from list_projects). Happens once your turn ends, and ends this conversation — each project has its own — so do it last.',
    inputSchema: obj({ id: str('The project id.') }, ['id']),
  },
  {
    name: 'pin_project', title: 'Pin project',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Pin a project to the top of the person\'s dashboard, or unpin it (pinned: false). Pins are the person\'s own; collaborators don\'t see them.',
    inputSchema: obj({ id: str('The project id.'), pinned: bool('true to pin (default), false to unpin.') }, ['id']),
  },
  {
    name: 'delete_project', title: 'Delete project',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    description: 'Delete a project the person owns. The person is always asked to confirm in Scaffold first; if they decline, nothing is deleted. Deleting the open project returns to the dashboard once your turn ends.',
    inputSchema: obj({ id: str('The project id.') }, ['id']),
  },
];

export const isProjectTool = (name) => PROJECT_TOOLS.some(t => t.name === name);

class ProjectToolError extends Error {}
const fail = (msg) => { throw new ProjectToolError(msg); };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const openUrl = (id) => `/editor.html?id=${encodeURIComponent(id)}`;

async function projects() {
  const res = await listProjects();
  if (!res.ok || !Array.isArray(res.data)) fail(`Couldn't load the projects: ${res.error || 'request failed'}`);
  return res.data;
}

async function find(id) {
  if (!id) fail('Give the project id (from list_projects)');
  const p = (await projects()).find(x => x.uuid === id);
  if (!p) fail(`No project with id "${id}" — use list_projects for the ids`);
  return p;
}

// `ctx`: { openId — the project open in this page (null on the dashboard),
//          later(fn) — run fn once the current Claude turn has ended,
//          changed() — the project list changed (the dashboard re-renders) }
export async function runProjectTool(name, args = {}, ctx) {
  try {
    switch (name) {
      case 'list_projects': {
        const list = (await projects()).map(p => ({
          id: p.uuid, name: p.name, owned: !!p.owned, pinned: !!p.pinned,
          edited: p.modified_at ? new Date(p.modified_at).toISOString() : null,
          open: p.uuid === ctx.openId,
        }));
        return { ok: true, summary: `${list.length} project${list.length === 1 ? '' : 's'}`, projects: list };
      }

      case 'create_project': {
        const name = String(args.name || '').trim();
        if (!name) fail('The name can\'t be empty');
        if (name.length > 120) fail('The name must be within 120 characters');
        const res = await createProject({ name });
        if (!res.ok || !res.data || !res.data.uuid) fail(`Couldn't create the project: ${res.error || 'request failed'}`);
        ctx.changed();
        if (args.open) {
          if (inTabs) openProject(res.data.uuid, name);
          else ctx.later(() => { window.location.href = openUrl(res.data.uuid); });
        }
        return { ok: true, summary: `Created project "${name}"${args.open ? (inTabs ? ' — opened in a new tab' : ' — it opens when this turn ends') : ''}`, id: res.data.uuid };
      }

      case 'open_project': {
        const p = await find(args.id);
        if (p.uuid === ctx.openId) return { ok: true, summary: `"${p.name}" is already open` };
        if (inTabs) { openProject(p.uuid, p.name); return { ok: true, summary: `Opened "${p.name}" in a tab` }; }
        ctx.later(() => { window.location.href = openUrl(p.uuid); });
        return { ok: true, summary: `Opening "${p.name}" when this turn ends` };
      }

      case 'pin_project': {
        const p = await find(args.id);
        const pinned = args.pinned !== false;
        if (!!p.pinned === pinned) return { ok: true, summary: `"${p.name}" is already ${pinned ? 'pinned' : 'unpinned'}` };
        const res = await pinProject(p.uuid, pinned);
        if (!res.ok) fail(`Couldn't ${pinned ? 'pin' : 'unpin'} it: ${res.error || 'request failed'}`);
        ctx.changed();
        return { ok: true, summary: `${pinned ? 'Pinned' : 'Unpinned'} "${p.name}"` };
      }

      case 'delete_project': {
        const p = await find(args.id);
        if (!p.owned) fail(`Only the owner can delete "${p.name}", and the person doesn't own it`);
        const ok = await confirmModal({
          title: 'Delete project?',
          message: `Claude wants to delete “<strong>${esc(p.name)}</strong>”. It will be permanently deleted — this can’t be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return { ok: false, summary: `The person chose not to delete "${p.name}" — nothing was deleted` };
        const res = await deleteProject(p.uuid);
        if (!res.ok) fail(`Couldn't delete it: ${res.error || 'request failed'}`);
        ctx.changed();
        if (p.uuid === ctx.openId) ctx.later(() => { if (inTabs) closeThisTab(); else window.location.href = '/dashboard.html'; });
        return { ok: true, summary: `Deleted "${p.name}"${p.uuid === ctx.openId ? ' — back to the dashboard when this turn ends' : ''}` };
      }
    }
    return { ok: false, summary: `Unknown tool "${name}"` };
  } catch (error) {
    if (error instanceof ProjectToolError) return { ok: false, summary: error.message };
    console.error('project tool failed', name, error);
    return { ok: false, summary: `${name} failed: ${error.message || error}` };
  }
}

// The dashboard's answer to the app's relayed MCP requests: only project tools
// (the design tools need a project open in the editor).
export function answerProjectTools({ changed }) {
  const tauri = window.__TAURI__;
  if (!tauri) return;
  const ctx = { openId: null, later: (fn) => setTimeout(fn, 300), changed };
  // This tab's own (see claude-tools.js): only calls sent to the dashboard tab.
  tauri.webview.getCurrentWebview().listen('scaffold-tool', async ({ payload }) => {
    const { id, method, name, arguments: args } = payload || {};
    const result = method === 'list' ? { ok: true, tools: PROJECT_TOOLS }
      : method === 'call' ? await runProjectTool(name, args, ctx)
      : { ok: false, summary: 'Open a project in the editor for that' };
    tauri.core.invoke('tool_reply', { id, result });
  });
}
