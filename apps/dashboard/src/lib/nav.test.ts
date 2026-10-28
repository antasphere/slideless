import { describe, expect, it, vi } from 'vitest';

// The rail as the shell builds it when a tool keeps the workspace group (`workspaceNav`), whatever
// the template's own tool says: a tool with nothing of its own, its administration shown to everyone.
const contribution = vi.hoisted(() => ({
  nav: () => [],
  navAfter: () => [],
  phoneTabs: [] as string[],
  workspaceNav: 'everyone' as 'everyone' | 'admins' | 'none'
}));
vi.mock('$lib/tool', () => ({ tool: contribution }));

const { buildNav } = await import('./nav');

const workspaceIds = (role: 'owner' | 'admin' | 'member', origin: 'local' | 'guest' = 'local') =>
  buildNav({ role, origin }).workspace.map((item) => item.id);

describe('the connections entry of the rail (PRDCT-3773)', () => {
  it('sits right after the webhooks for an owner or an admin, and after the API keys for a member', () => {
    for (const role of ['owner', 'admin'] as const) {
      const ids = workspaceIds(role);
      expect(ids[ids.indexOf('webhooks') + 1], role).toBe('connections');
    }
    const member = workspaceIds('member');
    expect(member[member.indexOf('api-keys') + 1]).toBe('connections');
    const entry = buildNav({ role: 'member', origin: 'local' }).workspace.find((i) => i.id === 'connections');
    expect(entry).toMatchObject({ href: '/connections', title: 'Connections' });
  });

  it('is never offered to a guest', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      expect(workspaceIds(role, 'guest'), role).not.toContain('connections');
    }
  });

  it('is offered to an owner or an admin only when the tool keeps the group for them', () => {
    contribution.workspaceNav = 'admins';
    try {
      expect(workspaceIds('admin')).toContain('connections');
      expect(workspaceIds('member')).not.toContain('connections');
    } finally {
      contribution.workspaceNav = 'everyone';
    }
  });

  it('lights Settings when the rail does not list it', () => {
    contribution.workspaceNav = 'none';
    try {
      const nav = buildNav({ role: 'member', origin: 'local' });
      expect(nav.workspace).toEqual([]);
      expect(nav.primary.at(-1)?.also).toContain('/connections');
    } finally {
      contribution.workspaceNav = 'everyone';
    }
  });
});
