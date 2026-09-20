import { describe, expect, it } from 'vitest';
import { atLeast, projectCan } from './can';
import type { ProjectRole } from './types';

const open = (myRole: ProjectRole) => ({ myRole, archivedAt: null });
const shut = (myRole: ProjectRole) => ({ myRole, archivedAt: '2026-09-20T10:00:00.000Z' });

describe('which controls of a project a person gets', () => {
  it('ranks the three roles', () => {
    expect(atLeast('manager', 'editor')).toBe(true);
    expect(atLeast('editor', 'editor')).toBe(true);
    expect(atLeast('viewer', 'editor')).toBe(false);
  });

  it.each([
    ['manager', { edit: true, archive: true, unarchive: false, manageMembers: true, write: true }],
    ['editor', { edit: false, archive: false, unarchive: false, manageMembers: false, write: true }],
    ['viewer', { edit: false, archive: false, unarchive: false, manageMembers: false, write: false }]
  ] as const)('an open project, as %s', (role, want) => {
    const p = open(role);
    expect({
      edit: projectCan.edit(p),
      archive: projectCan.archive(p),
      unarchive: projectCan.unarchive(p),
      manageMembers: projectCan.manageMembers(p),
      write: projectCan.write(p)
    }).toEqual(want);
  });

  it.each(['manager', 'editor', 'viewer'] as const)('an archived project is read-only, as %s', (role) => {
    const p = shut(role);
    expect(projectCan.edit(p)).toBe(false);
    expect(projectCan.archive(p)).toBe(false);
    expect(projectCan.manageMembers(p)).toBe(false);
    expect(projectCan.write(p)).toBe(false);
    expect(projectCan.leave(p, [{ userId: 'me' }], 'me')).toBe(false);
    // the one change it takes, and only from a manager
    expect(projectCan.unarchive(p)).toBe(role === 'manager');
  });

  it('only a person with a row of their own can leave', () => {
    expect(projectCan.leave(open('viewer'), [{ userId: 'me' }, { userId: 'you' }], 'me')).toBe(true);
    // a workspace admin reads the project as its manager without being a member of it
    expect(projectCan.leave(open('manager'), [{ userId: 'you' }], 'me')).toBe(false);
  });
});
