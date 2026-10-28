import { describe, expect, it, vi } from 'vitest';

// the tabs read the tool's own, whose components import SvelteKit's modules
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/'), params: {} } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn(), onNavigate: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: false, dev: false, building: false }));

import { settingsTabs, showsDemoLinks, type SettingsFacts } from './settings-tabs';

const facts = (over: {
  demoSignIn?: boolean;
  role?: SettingsFacts['me']['role'];
  via?: SettingsFacts['me']['via'];
  origin?: SettingsFacts['me']['origin'];
}): SettingsFacts => ({
  instance: 'demoSignIn' in over ? { demoSignIn: over.demoSignIn } : {},
  me: {
    role: 'role' in over ? (over.role ?? null) : 'owner',
    via: over.via ?? 'session',
    ...(over.origin ? { origin: over.origin } : {})
  }
});

const hrefs = (f: SettingsFacts) => settingsTabs(f).map((tab) => tab.href);

describe('the demo links tab', () => {
  it('shows to an owner in a browser session while the instance says demoSignIn', () => {
    const on = facts({ demoSignIn: true });
    expect(showsDemoLinks(on)).toBe(true);
    expect(hrefs(on)).toEqual([
      '/members',
      '/api-keys',
      '/webhooks',
      '/connections',
      '/files',
      '/audit',
      '/settings/instance',
      '/settings/demo',
      '/account',
      '/settings'
    ]);
  });

  it('is absent while the switch is off, or the key absent', () => {
    expect(showsDemoLinks(facts({}))).toBe(false);
    expect(showsDemoLinks(facts({ demoSignIn: false }))).toBe(false);
    expect(hrefs(facts({}))).toEqual([
      '/members',
      '/api-keys',
      '/webhooks',
      '/connections',
      '/files',
      '/audit',
      '/settings/instance',
      '/account',
      '/settings'
    ]);
  });

  it('is absent for anyone but an owner', () => {
    for (const role of ['admin', 'member', null] as const) {
      expect(showsDemoLinks(facts({ demoSignIn: true, role })), String(role)).toBe(false);
    }
  });

  it('is absent outside a browser session', () => {
    for (const via of ['api_key', 'oauth'] as const) {
      expect(showsDemoLinks(facts({ demoSignIn: true, via })), via).toBe(false);
    }
  });
});

describe('the workspace tabs', () => {
  it('a member gets no audit log; an admin does', () => {
    expect(hrefs(facts({ role: 'member' }))).not.toContain('/audit');
    expect(hrefs(facts({ role: 'admin' }))).toContain('/audit');
  });

  it('the webhooks sit right after the API keys, for an owner or an admin only', () => {
    for (const role of ['owner', 'admin'] as const) {
      const tabs = hrefs(facts({ role }));
      expect(tabs[tabs.indexOf('/api-keys') + 1], role).toBe('/webhooks');
    }
    for (const role of ['member', null] as const) {
      expect(hrefs(facts({ role })), String(role)).not.toContain('/webhooks');
    }
    expect(hrefs(facts({ role: 'admin', origin: 'guest' }))).not.toContain('/webhooks');
  });

  it('the connections sit right after the webhooks, for every member but a guest', () => {
    for (const role of ['owner', 'admin'] as const) {
      const tabs = hrefs(facts({ role }));
      expect(tabs[tabs.indexOf('/webhooks') + 1], role).toBe('/connections');
    }
    for (const role of ['member', null] as const) {
      const tabs = hrefs(facts({ role }));
      expect(tabs[tabs.indexOf('/api-keys') + 1], String(role)).toBe('/connections');
    }
    expect(hrefs(facts({ role: 'admin', origin: 'guest' }))).not.toContain('/connections');
  });

  it('a guest is offered neither the roster nor the files', () => {
    expect(hrefs(facts({ role: 'member', origin: 'guest' }))).toEqual([
      '/api-keys',
      '/settings/instance',
      '/account',
      '/settings'
    ]);
  });

  it('People is lit on its three pages', () => {
    for (const path of ['/members', '/teams', '/teams/t1', '/invitations']) {
      expect(settingsTabs(facts({}), path)[0], path).toMatchObject({ href: '/members', on: true });
    }
    expect(settingsTabs(facts({}), '/files')[0]).not.toHaveProperty('on');
  });

  it('the workspace’s own settings sit apart at the end', () => {
    expect(settingsTabs(facts({})).at(-1)).toMatchObject({ href: '/settings', end: true });
  });
});
