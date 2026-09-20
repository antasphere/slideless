/**
 * A project as the dashboard reads it (PRDCT-2582): a subgroup of the
 * workspace, with members who each hold a role, and what the tool links to it.
 *
 * STUB UNTIL THE REBASE: these shapes follow the design of 20 September 2026
 * and are replaced by the types of `@antasphere/chassis-contract` once the
 * server half lands on dev. Nothing else in the dashboard spells them.
 */
export type ProjectRole = 'manager' | 'editor' | 'viewer';

export const PROJECT_ROLES: readonly ProjectRole[] = ['manager', 'editor', 'viewer'];

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  /** Set on an archived project: out of the default list, and read-only. */
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** The caller's own role; a workspace admin or owner reads `manager` on every project. */
  myRole: ProjectRole;
}

export interface ProjectMember {
  userId: string;
  email: string;
  name: string | null;
  role: ProjectRole;
  addedBy: string | null;
  createdAt: string;
}

export type ProjectArchivedFilter = 'false' | 'true' | 'all';

export interface ProjectCreate {
  name: string;
  description?: string | null;
}
export type ProjectUpdate = Partial<ProjectCreate>;

/** A member is added from the workspace's own people, by user id or by the email of one of them. */
export type ProjectMemberAdd = ({ userId: string } | { email: string }) & { role: ProjectRole };
