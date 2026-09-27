import { describe, expect, it } from 'vitest';
import { peopleTabs, type PeopleTabsFacts } from './people-tabs';

const me = (over: Partial<PeopleTabsFacts> & { hubOrigin?: boolean } = {}): PeopleTabsFacts => ({
  role: over.role ?? 'member',
  origin: over.origin ?? 'local',
  workspace: { hubOrigin: over.hubOrigin ?? false }
});

const hrefs = (facts: PeopleTabsFacts, path?: string) => peopleTabs(facts, path).map((tab) => tab.href);

describe('the People tabs', () => {
  it('gives an owner or an admin of a local workspace the three tabs, in order', () => {
    expect(hrefs(me({ role: 'owner' }))).toEqual(['/members', '/teams', '/invitations']);
    expect(hrefs(me({ role: 'admin' }))).toEqual(['/members', '/teams', '/invitations']);
  });

  it('gives a plain member the members and the teams, never the invitations', () => {
    expect(hrefs(me({ role: 'member' }))).toEqual(['/members', '/teams']);
  });

  it('drops the invitations on a hub-origin workspace, whatever the role, and keeps the teams', () => {
    expect(hrefs(me({ role: 'owner', origin: 'hub', hubOrigin: true }))).toEqual(['/members', '/teams']);
    expect(hrefs(me({ role: 'member', origin: 'hub', hubOrigin: true }))).toEqual(['/members', '/teams']);
  });

  it('never offers the teams to a guest', () => {
    expect(hrefs(me({ role: 'member', origin: 'guest' }))).toEqual(['/members']);
  });

  it("lights the Teams tab on a team's own page, and on no other", () => {
    const onTeam = peopleTabs(me(), '/teams/5f0c3a4e-0000-4000-8000-000000000000');
    expect(onTeam.find((tab) => tab.href === '/teams')?.on).toBe(true);
    expect(onTeam.filter((tab) => tab.on)).toHaveLength(1);
    expect(peopleTabs(me(), '/teams').some((tab) => tab.on)).toBe(false);
    expect(peopleTabs(me(), '/members').some((tab) => tab.on)).toBe(false);
  });
});
