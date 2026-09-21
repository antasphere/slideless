import { describe, expect, it } from 'vitest';
import { offeredMembers, type Candidate } from './candidates';

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
