/**
 * A project as the dashboard reads it (PRDCT-2582): a subgroup of the
 * workspace, with members who each hold a role, and what the tool links to it.
 * The shapes are the chassis contract's; this file is the one place the
 * dashboard names them.
 */
export type {
  Project,
  ProjectCreate,
  ProjectMember,
  ProjectMemberAdd,
  ProjectRole,
  ProjectUpdate,
  ProjectsArchivedFilter as ProjectArchivedFilter
} from '@antasphere/chassis-contract';
import type { ProjectRole } from '@antasphere/chassis-contract';

export const PROJECT_ROLES: readonly ProjectRole[] = ['manager', 'editor', 'viewer'];
