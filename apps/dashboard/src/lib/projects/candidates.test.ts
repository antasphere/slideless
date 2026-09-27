import { describe, expect, it } from 'vitest';
import { offeredMembers, offeredTeams, type Candidate, type TeamCandidate } from './candidates';

const person = (userId: string, over: Partial<Candidate> = {}): Candidate => ({
  userId,
  email: `${userId}@example.test`,
  name: null,
  isActive: true,
  ...over
});

describe('who the add dialog offers', () => {
  it('leaves out the inactive, the guests and who is in the project already', () => {
    const people = [
      person('ana'),
      person('ben', { isActive: false }),
      person('cleo', { origin: 'guest' }),
      person('dov', { origin: 'hub' }),
      person('eve')
    ];
    expect(offeredMembers(people, ['eve']).map((p) => p.userId)).toEqual(['ana', 'dov']);
  });

  it('searches the name and the email, whatever the case', () => {
    const people = [person('ana', { name: 'Ana Lopez' }), person('ben', { name: 'Ben Ito' })];
    expect(offeredMembers(people, [], ' LOPEZ ').map((p) => p.userId)).toEqual(['ana']);
    expect(offeredMembers(people, [], 'ben@').map((p) => p.userId)).toEqual(['ben']);
    expect(offeredMembers(people, [], 'nobody')).toEqual([]);
  });

  it('sorts by the name a person reads, the email when there is no name', () => {
    const people = [person('zed'), person('ben', { name: 'Ben Ito' }), person('amy', { name: '' })];
    expect(offeredMembers(people, []).map((p) => p.userId)).toEqual(['amy', 'ben', 'zed']);
  });
});

const team = (id: string, name: string, slug = name.toLowerCase()): TeamCandidate => ({ id, name, slug });

describe('which teams the add dialog offers', () => {
  it('leaves out the teams already on the project', () => {
    const teams = [team('t1', 'Design'), team('t2', 'Sales'), team('t3', 'Legal')];
    expect(offeredTeams(teams, ['t2']).map((t) => t.id)).toEqual(['t1', 't3']);
    expect(offeredTeams(teams, ['t1', 't2', 't3'])).toEqual([]);
  });

  it('searches the name and the slug, whatever the case', () => {
    const teams = [team('t1', 'Design', 'brand-design'), team('t2', 'Sales', 'go-to-market')];
    expect(offeredTeams(teams, [], ' BRAND ').map((t) => t.id)).toEqual(['t1']);
    expect(offeredTeams(teams, [], 'sal').map((t) => t.id)).toEqual(['t2']);
    expect(offeredTeams(teams, [], 'nobody')).toEqual([]);
  });

  it('sorts by name', () => {
    const teams = [team('t1', 'Sales'), team('t2', 'Design'), team('t3', 'Legal')];
    expect(offeredTeams(teams, []).map((t) => t.name)).toEqual(['Design', 'Legal', 'Sales']);
  });
});
