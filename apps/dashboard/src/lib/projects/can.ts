import type { Project, ProjectMember, ProjectRole } from './types';

/**
 * Which controls of a project a person gets (PRDCT-2582). A control is on
 * screen only for who may use it: the server answers 403 to a reader who may
 * not do the act and 409 `project_archived` to every change of an archived
 * project but the unarchive, and this file is the dashboard's reading of the
 * same two rules, from the `myRole` the API hands over. It decides what is
 * SHOWN, never what is allowed.
 */
const RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, manager: 2 };

export function atLeast(role: ProjectRole, floor: ProjectRole): boolean {
  return RANK[role] >= RANK[floor];
}

type Facts = Pick<Project, 'myRole' | 'archivedAt'>;

const archived = (p: Facts) => p.archivedAt !== null;

export const projectCan = {
  /** Name, description. */
  edit: (p: Facts) => p.myRole === 'manager' && !archived(p),
  archive: (p: Facts) => p.myRole === 'manager' && !archived(p),
  /** The one change an archived project takes. */
  unarchive: (p: Facts) => p.myRole === 'manager' && archived(p),
  /** Add a member, change a role, remove someone else. */
  manageMembers: (p: Facts) => p.myRole === 'manager' && !archived(p),
  /** What an editor does with the tool's resources: add their own, write the linked ones. */
  write: (p: Facts) => atLeast(p.myRole, 'editor') && !archived(p),
  /**
   * Leaving is removing your own row. A workspace admin who reads a project as
   * its manager without being a member of it has no row, so nothing to leave.
   */
  leave: (p: Facts, members: Pick<ProjectMember, 'userId'>[], myUserId: string) =>
    !archived(p) && members.some((m) => m.userId === myUserId)
};
