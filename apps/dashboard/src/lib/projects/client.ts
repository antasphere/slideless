/**
 * The one seam between the Projects section and the API (PRDCT-2582): every
 * page reads and writes project data through `projects` and nothing else, so
 * the section knows the SDK by these ten calls. A project the caller cannot
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
  ProjectRole,
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
  setMemberRole(id: string, userId: string, body: { role: ProjectRole }): Promise<ProjectMember>;
  removeMember(id: string, userId: string): Promise<void>;
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
  }
};
