/**
 * The one seam between the Projects section and the API (PRDCT-2582).
 *
 * STUB UNTIL THE REBASE: the server half (the contract, the routes, the SDK
 * methods) lands on dev from the sister lane. Until then `projects` answers
 * from memory, so every page can be built and walked. At the rebase the body
 * of this file becomes calls on `api` from `$lib/api`, the `ProjectsClient`
 * shape stays, and no page changes.
 */
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

/** What the stub throws where the API would answer an error: the pages read `status` and `code`. */
export class StubApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

const now = () => new Date().toISOString();
const base = (id: string, name: string, description: string | null, myRole: ProjectRole): Project => ({
  id,
  workspaceId: 'stub',
  name,
  description,
  metadata: {},
  archivedAt: null,
  createdBy: null,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-18T15:30:00.000Z',
  myRole
});

let rows: Project[] = [
  base(
    '00000000-0000-4000-8000-000000000001',
    'Autumn launch',
    'Every deck of the October launch.',
    'manager'
  ),
  base('00000000-0000-4000-8000-000000000002', 'Board meetings', null, 'editor'),
  base(
    '00000000-0000-4000-8000-000000000003',
    'Partner onboarding',
    'What a new partner reads first.',
    'viewer'
  ),
  {
    ...base('00000000-0000-4000-8000-000000000004', 'Spring roadshow', 'Closed in June.', 'manager'),
    archivedAt: '2026-06-30T17:00:00.000Z'
  }
];
const people: Record<string, ProjectMember[]> = {};
const membersOf = (id: string) =>
  (people[id] ??= [
    {
      userId: 'stub-user-1',
      email: 'maya@example.test',
      name: 'Maya Manager',
      role: 'manager',
      addedBy: null,
      createdAt: '2026-09-01T09:00:00.000Z'
    },
    {
      userId: 'stub-user-2',
      email: 'eli@example.test',
      name: 'Eli Editor',
      role: 'editor',
      addedBy: 'stub-user-1',
      createdAt: '2026-09-02T09:00:00.000Z'
    }
  ]);

function find(id: string): Project {
  const row = rows.find((r) => r.id === id);
  // whoever cannot read a project gets 404, never 403
  if (!row) throw new StubApiError(404, 'not_found', 'Project not found');
  return row;
}
function open(id: string): Project {
  const row = find(id);
  if (row.archivedAt) throw new StubApiError(409, 'project_archived', 'This project is archived');
  return row;
}
function put(next: Project): Project {
  rows = rows.map((r) => (r.id === next.id ? next : r));
  return next;
}

export const projects: ProjectsClient = {
  async list({ archived = 'false' }) {
    const shown = rows.filter((r) => archived === 'all' || (archived === 'true') === (r.archivedAt !== null));
    return { projects: shown, nextCursor: null };
  },
  async create(body) {
    const row = base(crypto.randomUUID(), body.name, body.description ?? null, 'manager');
    rows = [{ ...row, createdAt: now(), updatedAt: now() }, ...rows];
    return rows[0];
  },
  async get(id) {
    return find(id);
  },
  async update(id, body) {
    return put({ ...open(id), ...body, updatedAt: now() });
  },
  async archive(id) {
    return put({ ...open(id), archivedAt: now(), updatedAt: now() });
  },
  async unarchive(id) {
    return put({ ...find(id), archivedAt: null, updatedAt: now() });
  },
  async members(id) {
    find(id);
    return { members: membersOf(id), nextCursor: null };
  },
  async addMember(id, body) {
    open(id);
    const email = 'email' in body ? body.email : `${body.userId}@example.test`;
    const userId = 'userId' in body ? body.userId : `stub-${email}`;
    if (membersOf(id).some((m) => m.userId === userId))
      throw new StubApiError(409, 'already_member', 'Already a member of this project');
    const member: ProjectMember = {
      userId,
      email,
      name: null,
      role: body.role,
      addedBy: null,
      createdAt: now()
    };
    people[id] = [...membersOf(id), member];
    return member;
  },
  async setMemberRole(id, userId, { role }) {
    open(id);
    people[id] = membersOf(id).map((m) => (m.userId === userId ? { ...m, role } : m));
    return people[id].find((m) => m.userId === userId)!;
  },
  async removeMember(id, userId) {
    open(id);
    people[id] = membersOf(id).filter((m) => m.userId !== userId);
  }
};
