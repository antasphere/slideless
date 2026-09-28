import { describe, expect, it } from 'vitest';
import { settingsTabs, showsDemoLinks, type SettingsFacts } from './settings-tabs';

const facts = (over: {
  demoSignIn?: boolean;
  role?: SettingsFacts['me']['role'];
  via?: SettingsFacts['me']['via'];
}): SettingsFacts => ({
  instance: 'demoSignIn' in over ? { demoSignIn: over.demoSignIn } : {},
  me: { role: 'role' in over ? (over.role ?? null) : 'owner', via: over.via ?? 'session' }
});

const hrefs = (f: SettingsFacts) => settingsTabs(f).map((tab) => tab.href);

describe('the demo links tab', () => {
  it('shows to an owner in a browser session while the instance says demoSignIn', () => {
    const on = facts({ demoSignIn: true });
    expect(showsDemoLinks(on)).toBe(true);
    expect(hrefs(on)).toEqual(['/settings', '/settings/instance', '/settings/demo', '/account']);
  });

  it('is absent while the switch is off, or the key absent', () => {
    expect(showsDemoLinks(facts({}))).toBe(false);
    expect(showsDemoLinks(facts({ demoSignIn: false }))).toBe(false);
    expect(hrefs(facts({}))).toEqual(['/settings', '/settings/instance', '/account']);
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
