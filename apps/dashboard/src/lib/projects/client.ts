/**
 * The one seam between the Projects section and the API (PRDCT-2582): every
 * page reads and writes project data through `projects` and nothing else, so
 * the section knows the SDK by these twelve calls. A project the caller cannot
 * read answers 404 (never 403); an archived one answers 409 `project_archived`
 * to every change but the unarchive; a project is never deleted.
 */
import { api } from '$lib/api';
import type {
  Project,
  ProjectArchivedFilter,
  ProjectCreate,
  ProjectMember,
  ProjectMemberAdd,
  ProjectPersonMember,
  ProjectRole,
  ProjectTeamMember,
  ProjectUpdate
} from './types';

interface PageParams {
  cursor?: string;
  limit?: number;
}

export interface ProjectsClient {
  list(p: PageParams & { archived?: ProjectArchivedFilter }): Promise<{
    projects: Project[];
    nextCursor: string | null;
  }>;
  create(body: ProjectCreate): Promise<Project>;
  get(id: string): Promise<Project>;
  update(id: string, body: ProjectUpdate): Promise<Project>;
  archive(id: string): Promise<Project>;
  unarchive(id: string): Promise<Project>;
  members(id: string, p: PageParams): Promise<{ members: ProjectMember[]; nextCursor: string | null }>;
  addMember(id: string, body: ProjectMemberAdd): Promise<ProjectMember>;
  setMemberRole(id: string, userId: string, body: { role: ProjectRole }): Promise<ProjectPersonMember>;
  removeMember(id: string, userId: string): Promise<void>;
  /** A team on the project (PRDCT-2794): its role, and taking it off (its people keep their own entries). */
  setTeamRole(id: string, teamId: string, body: { role: ProjectRole }): Promise<ProjectTeamMember>;
  removeTeam(id: string, teamId: string): Promise<void>;
}

export const projects: ProjectsClient = {
  list: (p) => api.projects(p),
  create: (body) => api.createProject(body),
  get: (id) => api.project(id),
  update: (id, body) => api.updateProject(id, body),
  archive: (id) => api.archiveProject(id),
  unarchive: (id) => api.unarchiveProject(id),
  members: (id, p) => api.projectMembers(id, p),
  addMember: (id, body) => api.addProjectMember(id, body),
  setMemberRole: (id, userId, { role }) => api.setProjectMemberRole(id, userId, role),
  async removeMember(id, userId) {
    await api.removeProjectMember(id, userId);
  },
  setTeamRole: (id, teamId, { role }) => api.setProjectTeamRole(id, teamId, role),
  async removeTeam(id, teamId) {
    await api.removeProjectTeam(id, teamId);
  }
};
