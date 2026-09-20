import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { workspaceMembers } from '@antasphere/chassis-db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * A deck belongs to projects, and the project's members read it (ADR 026,
 * PRDCT-2578). The read rule has THREE homes and this suite pins each one on
 * its own, so that losing the branch in any one of them turns a test red:
 *
 *   home 1  canReadDeck        the deck, its versions, a version, an asset
 *   home 2  the list's WHERE   GET /presentations, with and without ?project
 *   home 3  blobReadScope      GET /files/{id}/content, and the commit guard
 *
 * plus the write rule's editor branch (a version commit), the tiers of the
 * link and unlink routes, `projectIds` on a push, the project's brand, and
 * the ADR 013 posture on every new path: 404, never 403, to a non-reader.
 */
const PASSWORD = 'deck-projects-pass-0001';
const people = {
  /** The workspace owner: sets the instance up and appears nowhere else (a workspace owner manages every project). */
  owner: { email: 'owner@deck-projects.test', name: 'Workspace Owner' },
  /** A plain member who pushes the decks: the deck owner, on no project until a test adds them. */
  author: { email: 'author@deck-projects.test', name: 'Deck Author' },
  manager: { email: 'manager@deck-projects.test', name: 'Project Manager' },
  editor: { email: 'editor@deck-projects.test', name: 'Project Editor' },
  viewer: { email: 'viewer@deck-projects.test', name: 'Project Viewer' },
  outsider: { email: 'outsider@deck-projects.test', name: 'Plain Member' },
  guest: { email: 'guest@deck-projects.test', name: 'A Guest' }
} as const;
type Who = keyof typeof people;

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const htmlOf = (label: string) => Buffer.from(`<!doctype html><html><body><h1>${label}</h1></body></html>`);
const brandMd = (label: string) => Buffer.from(`---\ntype: Brand\ntitle: ${label}\n---\n# ${label}\n`);
type Blob = { path: string; bytes: Buffer; contentType: string };
const entryOf = (b: Blob) => ({
  path: b.path,
  sha256: shaOf(b.bytes),
  sizeBytes: b.bytes.length,
  contentType: b.contentType
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
const cookies: Record<Who, string> = {} as Record<Who, string>;
const userIds: Record<Who, string> = {} as Record<Who, string>;
const memberIds: Record<Who, string> = {} as Record<Who, string>;
/** The project under test: manager, editor and viewer on it; the author and the outsider are not. */
let project = '';
/** The author's deck, linked to `project`. */
let deck = '';
const DECK_HTML = htmlOf('the linked deck');

let ipCounter = 0;
const nextIp = () => `10.79.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (method: string, path: string, who: Who | { key: string }, body?: unknown) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      'x-forwarded-for': nextIp(),
      ...(typeof who === 'string' ? { cookie: cookies[who] } : { authorization: `Bearer ${who.key}` }),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = await readJson(res.clone());
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
}

async function upload(who: Who, b: Blob): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(b.bytes));
  form.set('file', new Blob([new Uint8Array(b.bytes)], { type: b.contentType }), b.path);
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie: cookies[who], 'x-forwarded-for': nextIp() },
    body: form
  });
  expect(res.status).toBe(201);
}

/** Reserve + commit, the blobs uploaded first. Returns the commit response. */
async function push(
  who: Who,
  title: string,
  blobs: Blob[],
  extra: Record<string, unknown> = {}
): Promise<Response> {
  for (const b of blobs) await upload(who, b);
  const reserve = await readJson(await send('POST', '/presentations/uploads', who));
  return send('POST', `/presentations/uploads/${reserve.uploadSession.id}/commit`, who, {
    title,
    entryPath: 'index.html',
    manifest: blobs.map(entryOf),
    ...extra
  });
}

async function pushDeck(
  who: Who,
  title: string,
  blobs: Blob[],
  extra: Record<string, unknown> = {}
): Promise<string> {
  const res = await push(who, title, blobs, extra);
  expect(res.status).toBe(201);
  return (await readJson(res)).presentation.id;
}

/** The four read endpoints of one deck, as one status snapshot (home 1). */
async function reads(who: Who, id: string, sha: string) {
  const [get, versions, detail, asset] = await Promise.all([
    send('GET', `/presentations/${id}`, who),
    send('GET', `/presentations/${id}/versions`, who),
    send('GET', `/presentations/${id}/versions/1`, who),
    send('GET', `/presentations/${id}/assets/${sha}`, who)
  ]);
  return { get: get.status, versions: versions.status, detail: detail.status, asset: asset.status };
}
const ALL_200 = { get: 200, versions: 200, detail: 200, asset: 200 };
const ALL_404 = { get: 404, versions: 404, detail: 404, asset: 404 };

async function listIds(who: Who, query = ''): Promise<string[]> {
  const res = await send('GET', `/presentations${query}`, who);
  expect(res.status).toBe(200);
  return ((await readJson(res)).presentations as Array<{ id: string }>).map((p) => p.id);
}

async function fileIdOf(sha: string): Promise<string> {
  const { rows } = await app.db.pool.query('SELECT id FROM files WHERE sha256 = $1 AND workspace_id = $2', [
    sha,
    workspaceId
  ]);
  return rows[0].id as string;
}

async function blobStatus(who: Who, sha: string): Promise<number> {
  return (await send('GET', `/files/${await fileIdOf(sha)}/content`, who)).status;
}

async function addToProject(
  who: Who,
  role: 'manager' | 'editor' | 'viewer',
  target = project
): Promise<void> {
  const res = await send('POST', `/projects/${target}/members`, 'manager', { userId: userIds[who], role });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'deck_projects'));
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({
      setupToken: 'integration-test-setup-token',
      instanceName: 'Deck projects',
      owner: { ...people.owner, password: PASSWORD }
    })
  });
  expect(setup.status).toBe(201);
  workspaceId = (await readJson(setup)).workspaceId;

  for (const who of Object.keys(people) as Who[]) {
    if (who !== 'owner') {
      const created = await app.auth.api.signUpEmail({ body: { ...people[who], password: PASSWORD } });
      await app.db.db.insert(workspaceMembers).values({
        workspaceId,
        userId: created.user.id,
        role: 'member',
        origin: who === 'guest' ? 'guest' : 'local'
      });
    }
    const signIn = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ email: people[who].email, password: PASSWORD })
    });
    expect(signIn.status).toBe(200);
    cookies[who] = extractCookie(signIn);
    const me = await readJson(await send('GET', '/me', who));
    userIds[who] = me.user.id;
    const { rows } = await app.db.pool.query(
      'SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, me.user.id]
    );
    memberIds[who] = rows[0].id;
  }

  const created = await send('POST', '/projects', 'manager', { name: 'Autumn launch' });
  expect(created.status).toBe(201);
  project = (await readJson(created)).id;
  await addToProject('editor', 'editor');
  await addToProject('viewer', 'viewer');

  deck = await pushDeck('author', 'The linked deck', [
    { path: 'index.html', bytes: DECK_HTML, contentType: 'text/html' }
  ]);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('linking a deck to a project: the deck administrator’s act, with editor or more on the project', () => {
  it('before any link, the project’s members do not read the author’s deck', async () => {
    expect(await reads('viewer', deck, shaOf(DECK_HTML))).toEqual(ALL_404);
    expect(await listIds('viewer')).not.toContain(deck);
  });

  it('the tiers: 404 for a non-reader of the deck, 404 for a non-reader of the project, 403 below editor, 409 archived', async () => {
    // The outsider cannot read the deck: 404, never 403, whatever the project.
    await expectError(
      await send('PUT', `/presentations/${deck}/projects/${project}`, 'outsider'),
      404,
      'not_found'
    );
    // The author administers the deck but is not on the project: the project is not theirs to see.
    await expectError(
      await send('PUT', `/presentations/${deck}/projects/${project}`, 'author'),
      404,
      'project_not_found'
    );
    await addToProject('author', 'viewer');
    await expectError(
      await send('PUT', `/presentations/${deck}/projects/${project}`, 'author'),
      403,
      'insufficient_project_role'
    );
    const promoted = await send('PATCH', `/projects/${project}/members/${userIds.author}`, 'manager', {
      role: 'editor'
    });
    expect(promoted.status).toBe(200);
    expect((await send('POST', `/projects/${project}/archive`, 'manager')).status).toBe(200);
    await expectError(
      await send('PUT', `/presentations/${deck}/projects/${project}`, 'author'),
      409,
      'project_archived'
    );
    expect((await send('POST', `/projects/${project}/unarchive`, 'manager')).status).toBe(200);
    // A guest never links anything.
    await expectError(
      await send('PUT', `/presentations/${deck}/projects/${project}`, 'guest'),
      403,
      'guest_forbidden'
    );
  });

  it('the author links the deck, and the payload names the project; linking twice is the same 200', async () => {
    const res = await send('PUT', `/presentations/${deck}/projects/${project}`, 'author');
    expect(res.status).toBe(200);
    expect((await readJson(res)).projects).toEqual([{ id: project, name: 'Autumn launch', isBrand: false }]);
    expect((await send('PUT', `/presentations/${deck}/projects/${project}`, 'author')).status).toBe(200);
    const { rows } = await app.db.pool.query(
      'SELECT 1 FROM presentation_projects WHERE presentation_id = $1',
      [deck]
    );
    expect(rows).toHaveLength(1);
  });

  it('a reader of the deck who does not administer it cannot link it elsewhere (403, a proven reader)', async () => {
    const other = (await readJson(await send('POST', '/projects', 'viewer', { name: 'The viewer’s own' })))
      .id;
    await expectError(
      await send('PUT', `/presentations/${deck}/projects/${other}`, 'viewer'),
      403,
      'forbidden'
    );
  });
});

describe('home 1: canReadDeck reads the deck, its versions and its assets for every project role', () => {
  it.each(['manager', 'editor', 'viewer'] as const)('%s reads all four', async (who) => {
    expect(await reads(who, deck, shaOf(DECK_HTML))).toEqual(ALL_200);
  });

  it('the outsider and the guest get 404 on all four', async () => {
    expect(await reads('outsider', deck, shaOf(DECK_HTML))).toEqual(ALL_404);
    expect(await reads('guest', deck, shaOf(DECK_HTML))).toEqual(ALL_404);
  });
});

describe('home 2: the list’s WHERE, and the ?project filter', () => {
  it('a project member’s list carries the deck; the outsider’s does not', async () => {
    expect(await listIds('viewer')).toContain(deck);
    expect(await listIds('outsider')).not.toContain(deck);
  });

  it('?project keeps the project’s decks, 404 to a non-reader of the project under every type', async () => {
    expect(await listIds('viewer', `?project=${project}`)).toEqual([deck]);
    expect(await listIds('viewer', `?project=${project}&type=brand`)).toEqual([]);
    await expectError(
      await send('GET', `/presentations?project=${project}`, 'outsider'),
      404,
      'project_not_found'
    );
    await expectError(
      await send('GET', `/presentations?project=${project}&type=brand`, 'outsider'),
      404,
      'project_not_found'
    );
    await expectError(
      await send('GET', `/presentations?project=${project}&type=reference`, 'outsider'),
      404,
      'project_not_found'
    );
    await expectError(
      await send('GET', `/presentations?project=${project}`, 'guest'),
      404,
      'project_not_found'
    );
    // The filter narrows, it never widens: a project deck of another owner
    // shows through the project, an unlinked deck of the owner does not.
    const loose = await pushDeck('author', 'Not linked', [
      { path: 'index.html', bytes: htmlOf('loose'), contentType: 'text/html' }
    ]);
    expect(await listIds('viewer', `?project=${project}`)).not.toContain(loose);
  });
});

describe('home 3: blobReadScope streams the deck’s bytes to the project’s members, and binds them', () => {
  const sha = shaOf(DECK_HTML);

  it('a viewer streams the blob; the outsider and the guest get 404', async () => {
    expect(await blobStatus('viewer', sha)).toBe(200);
    expect(await blobStatus('outsider', sha)).toBe(404);
    // A guest is refused the generic /files surface flat (D2): 403, before any rule.
    expect(await blobStatus('guest', sha)).toBe(403);
  });

  it('the commit guard binds the blob for a member and reports missing_blobs for a non-member', async () => {
    const commitNaming = async (who: Who) => {
      const reserve = await readJson(await send('POST', '/presentations/uploads', who));
      return send('POST', `/presentations/uploads/${reserve.uploadSession.id}/commit`, who, {
        title: `Reuse by ${who}`,
        entryPath: 'index.html',
        manifest: [{ path: 'index.html', sha256: sha, sizeBytes: DECK_HTML.length, contentType: 'text/html' }]
      });
    };
    const reused = await commitNaming('viewer');
    expect(reused.status).toBe(201);
    // The viewer now OWNS a deck carrying the blob; delete it so the next
    // tests read the blob through the project alone.
    expect(
      (await send('DELETE', `/presentations/${(await readJson(reused)).presentation.id}`, 'viewer')).status
    ).toBe(200);
    const refused = await commitNaming('outsider');
    await expectError(refused, 400, 'missing_blobs');
    expect((await readJson(refused)).error.details.missing).toEqual([sha]);
  });
});

describe('the write rule: an editor commits a version, a viewer does not', () => {
  const v2 = { path: 'index.html', bytes: htmlOf('version two'), contentType: 'text/html' };

  it('a viewer’s push is the uniform 404, an editor’s lands as a dev-style commit', async () => {
    await upload('viewer', v2);
    await expectError(
      await send('POST', `/presentations/${deck}/versions`, 'viewer', {
        expectedBaseVersion: 1,
        entryPath: 'index.html',
        manifest: [entryOf(v2)]
      }),
      404,
      'not_found'
    );
    await upload('editor', v2);
    const res = await send('POST', `/presentations/${deck}/versions`, 'editor', {
      expectedBaseVersion: 1,
      entryPath: 'index.html',
      manifest: [entryOf(v2)]
    });
    expect(res.status).toBe(201);
    expect((await readJson(res)).version).toMatchObject({ version: 2, createdByRole: 'dev' });
  });

  it('an archived project still reads and no longer writes; unarchived, it writes again', async () => {
    expect((await send('POST', `/projects/${project}/archive`, 'manager')).status).toBe(200);
    expect(await reads('viewer', deck, shaOf(v2.bytes))).toEqual(ALL_200);
    expect(await reads('editor', deck, shaOf(v2.bytes))).toEqual(ALL_200);
    expect(await listIds('editor')).toContain(deck);
    expect(await blobStatus('viewer', shaOf(v2.bytes))).toBe(200);
    const v3 = { path: 'index.html', bytes: htmlOf('version three'), contentType: 'text/html' };
    await upload('editor', v3);
    const body = { expectedBaseVersion: 2, entryPath: 'index.html', manifest: [entryOf(v3)] };
    await expectError(
      await send('POST', `/presentations/${deck}/versions`, 'editor', body),
      404,
      'not_found'
    );
    // The manager is bound by the archive like the editor.
    await expectError(
      await send('POST', `/presentations/${deck}/versions`, 'manager', body),
      404,
      'not_found'
    );
    expect((await send('POST', `/projects/${project}/unarchive`, 'manager')).status).toBe(200);
    expect((await send('POST', `/presentations/${deck}/versions`, 'editor', body)).status).toBe(201);
  });
});

describe('a grant that ends, ends the reads on the next request', () => {
  const sha = shaOf(DECK_HTML);

  it('a member removed from the project reads none of the four, nor the blob, nor the list', async () => {
    const removed = await send('DELETE', `/projects/${project}/members/${userIds.viewer}`, 'manager');
    expect(removed.status).toBe(200);
    expect(await reads('viewer', deck, sha)).toEqual(ALL_404);
    expect(await blobStatus('viewer', sha)).toBe(404);
    expect(await listIds('viewer')).not.toContain(deck);
    await expectError(
      await send('GET', `/presentations?project=${project}`, 'viewer'),
      404,
      'project_not_found'
    );
    await addToProject('viewer', 'viewer');
    expect(await reads('viewer', deck, sha)).toEqual(ALL_200);
  });

  it('a workspace membership that is deleted takes the grant, and a re-invite starts with none', async () => {
    await app.db.pool.query('DELETE FROM workspace_members WHERE id = $1', [memberIds.viewer]);
    await app.db.db.insert(workspaceMembers).values({ workspaceId, userId: userIds.viewer, role: 'member' });
    expect(await reads('viewer', deck, sha)).toEqual(ALL_404);
    expect(await blobStatus('viewer', sha)).toBe(404);
    await addToProject('viewer', 'viewer');
    expect(await reads('viewer', deck, sha)).toEqual(ALL_200);
  });

  it('a guest with a grant row forced in still reads nothing: the three homes refuse the guest', async () => {
    await app.db.pool.query(
      `INSERT INTO project_members (project_id, member_id, role) VALUES ($1, $2, 'manager')`,
      [project, memberIds.guest]
    );
    expect(await reads('guest', deck, sha)).toEqual(ALL_404);
    expect(await blobStatus('guest', sha)).toBe(403);
    expect(await listIds('guest')).not.toContain(deck);
    await app.db.pool.query('DELETE FROM project_members WHERE member_id = $1', [memberIds.guest]);
  });
});

describe('the deck payload names only the projects the caller can read', () => {
  it('a second, private project of the author shows to the author and not to the viewer', async () => {
    const secret = (await readJson(await send('POST', '/projects', 'author', { name: 'Author’s private' })))
      .id;
    expect((await send('PUT', `/presentations/${deck}/projects/${secret}`, 'author')).status).toBe(200);
    const byOwner = await readJson(await send('GET', `/presentations/${deck}`, 'author'));
    expect(byOwner.projects.map((p: { name: string }) => p.name)).toEqual([
      'Author’s private',
      'Autumn launch'
    ]);
    const byViewer = await readJson(await send('GET', `/presentations/${deck}`, 'viewer'));
    expect(byViewer.projects.map((p: { name: string }) => p.name)).toEqual(['Autumn launch']);
    const listed = (await readJson(await send('GET', '/presentations', 'viewer'))).presentations.find(
      (p: { id: string }) => p.id === deck
    );
    expect(listed.projects.map((p: { name: string }) => p.name)).toEqual(['Autumn launch']);
    expect((await send('DELETE', `/presentations/${deck}/projects/${secret}`, 'author')).status).toBe(200);
  });
});

describe('unlinking: the deck administrator, or a project manager', () => {
  it('a viewer or editor cannot; a manager can; the deck administrator can even on an archived project', async () => {
    await expectError(
      await send('DELETE', `/presentations/${deck}/projects/${project}`, 'viewer'),
      403,
      'forbidden'
    );
    await expectError(
      await send('DELETE', `/presentations/${deck}/projects/${project}`, 'editor'),
      403,
      'forbidden'
    );
    await expectError(
      await send('DELETE', `/presentations/${deck}/projects/${project}`, 'outsider'),
      404,
      'not_found'
    );
    const byManager = await send('DELETE', `/presentations/${deck}/projects/${project}`, 'manager');
    expect(byManager.status).toBe(200);
    expect((await readJson(byManager)).projects).toEqual([]);
    // Gone for the manager too: they read the deck through the link only.
    await expectError(await send('GET', `/presentations/${deck}`, 'manager'), 404, 'not_found');
    await expectError(
      await send('DELETE', `/presentations/${deck}/projects/${project}`, 'author'),
      404,
      'not_linked'
    );

    expect((await send('PUT', `/presentations/${deck}/projects/${project}`, 'author')).status).toBe(200);
    expect((await send('POST', `/projects/${project}/archive`, 'manager')).status).toBe(200);
    await expectError(
      await send('DELETE', `/presentations/${deck}/projects/${project}`, 'manager'),
      409,
      'project_archived'
    );
    expect((await send('DELETE', `/presentations/${deck}/projects/${project}`, 'author')).status).toBe(200);
    expect((await send('POST', `/projects/${project}/unarchive`, 'manager')).status).toBe(200);
    expect((await send('PUT', `/presentations/${deck}/projects/${project}`, 'author')).status).toBe(200);
  });
});

describe('projectIds on a push: an editor lands a deck the project’s viewers read', () => {
  const blob = (label: string): Blob => ({
    path: 'index.html',
    bytes: htmlOf(label),
    contentType: 'text/html'
  });

  it('the editor’s push is linked in the same commit', async () => {
    const id = await pushDeck('editor', 'Pushed into the project', [blob('editor push')], {
      projectIds: [project]
    });
    const body = await readJson(await send('GET', `/presentations/${id}`, 'viewer'));
    expect(body.projects).toEqual([{ id: project, name: 'Autumn launch', isBrand: false }]);
    expect(await listIds('viewer', `?project=${project}`)).toContain(id);
  });

  it('a viewer, an outsider and a guest are refused with the same 404, and nothing is created', async () => {
    const countDecks = async () =>
      Number((await app.db.pool.query('SELECT count(*) FROM presentations')).rows[0].count);
    const before = await countDecks();
    for (const who of ['viewer', 'outsider'] as const) {
      const res = await push(who, `By ${who}`, [blob(`${who} push`)], { projectIds: [project] });
      await expectError(res, 404, 'project_not_found');
      expect((await readJson(res)).error.details).toEqual({ projectId: project });
    }
    const phantom = await push('editor', 'Phantom', [blob('phantom')], {
      projectIds: ['00000000-0000-4000-8000-000000000000']
    });
    await expectError(phantom, 404, 'project_not_found');
    expect(await countDecks()).toBe(before);
  });

  it('an archived project refuses the push the same way', async () => {
    expect((await send('POST', `/projects/${project}/archive`, 'manager')).status).toBe(200);
    await expectError(
      await push('editor', 'Into archived', [blob('archived push')], { projectIds: [project] }),
      404,
      'project_not_found'
    );
    expect((await send('POST', `/projects/${project}/unarchive`, 'manager')).status).toBe(200);
  });

  it('a session that failed on projectIds is not consumed: the same session commits without them', async () => {
    const b = blob('retry');
    await upload('viewer', b);
    const reserve = await readJson(await send('POST', '/presentations/uploads', 'viewer'));
    const body = { title: 'Retry', entryPath: 'index.html', manifest: [entryOf(b)] };
    await expectError(
      await send('POST', `/presentations/uploads/${reserve.uploadSession.id}/commit`, 'viewer', {
        ...body,
        projectIds: [project]
      }),
      404,
      'project_not_found'
    );
    expect(
      (await send('POST', `/presentations/uploads/${reserve.uploadSession.id}/commit`, 'viewer', body)).status
    ).toBe(201);
  });
});

describe('the project’s brand: a brand reference linked to the project, one per project', () => {
  let brandA = '';
  let brandB = '';
  const brandBlobs = (label: string): Blob[] => [
    { path: 'index.html', bytes: htmlOf(label), contentType: 'text/html' },
    { path: 'AGENT.md', bytes: brandMd(label), contentType: 'text/markdown' }
  ];

  beforeAll(async () => {
    brandA = await pushDeck('author', 'Brand A', brandBlobs('Brand A'), { projectIds: [project] });
    brandB = await pushDeck('author', 'Brand B', brandBlobs('Brand B'));
  });

  it('starts empty, and a non-reader of the project gets 404 on the three brand routes', async () => {
    expect(await readJson(await send('GET', `/projects/${project}/brand`, 'viewer'))).toEqual({
      brand: null
    });
    await expectError(await send('GET', `/projects/${project}/brand`, 'outsider'), 404, 'project_not_found');
    await expectError(
      await send('PUT', `/projects/${project}/brand`, 'outsider', { presentationId: brandA }),
      404,
      'project_not_found'
    );
    await expectError(
      await send('DELETE', `/projects/${project}/brand`, 'outsider'),
      404,
      'project_not_found'
    );
    await expectError(await send('GET', `/projects/${project}/brand`, 'guest'), 403, 'guest_forbidden');
  });

  it('only a manager sets it; the deck must be a linked brand reference', async () => {
    await expectError(
      await send('PUT', `/projects/${project}/brand`, 'editor', { presentationId: brandA }),
      403,
      'insufficient_project_role'
    );
    await expectError(
      await send('PUT', `/projects/${project}/brand`, 'manager', { presentationId: deck }),
      400,
      'not_a_brand'
    );
    // Brand B is the author's and unlinked: the manager cannot even read it.
    await expectError(
      await send('PUT', `/projects/${project}/brand`, 'manager', { presentationId: brandB }),
      404,
      'not_found'
    );
    const set = await send('PUT', `/projects/${project}/brand`, 'manager', { presentationId: brandA });
    expect(set.status).toBe(200);
    expect((await readJson(set)).brand).toMatchObject({
      id: brandA,
      projects: [{ id: project, isBrand: true }]
    });
    const read = await readJson(await send('GET', `/projects/${project}/brand`, 'viewer'));
    expect(read.brand.id).toBe(brandA);
  });

  it('a second brand replaces the first; the database holds one flag per project', async () => {
    expect((await send('PUT', `/presentations/${brandB}/projects/${project}`, 'author')).status).toBe(200);
    expect(
      (await send('PUT', `/projects/${project}/brand`, 'manager', { presentationId: brandB })).status
    ).toBe(200);
    const { rows } = await app.db.pool.query(
      'SELECT presentation_id FROM presentation_projects WHERE project_id = $1 AND is_brand',
      [project]
    );
    expect(rows.map((r) => r.presentation_id)).toEqual([brandB]);
    await expect(
      app.db.pool.query('UPDATE presentation_projects SET is_brand = true WHERE presentation_id = $1', [
        brandA
      ])
    ).rejects.toThrow(/presentation_projects_brand_uniq/);
  });

  it('the flag drops in the same commit when the deck stops being a brand, and the warning says so', async () => {
    const plain: Blob = { path: 'index.html', bytes: htmlOf('Brand B, plain now'), contentType: 'text/html' };
    await upload('author', plain);
    const res = await send('POST', `/presentations/${brandB}/versions`, 'author', {
      expectedBaseVersion: 1,
      entryPath: 'index.html',
      manifest: [entryOf(plain)]
    });
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.version.referenceWarning).toContain('no longer the brand of the project');
    expect(body.presentation.projects).toEqual([{ id: project, name: 'Autumn launch', isBrand: false }]);
    expect(await readJson(await send('GET', `/projects/${project}/brand`, 'viewer'))).toEqual({
      brand: null
    });
  });

  it('an archived project refuses set and clear; a manager clears it; unlinking the brand clears it too', async () => {
    expect(
      (await send('PUT', `/projects/${project}/brand`, 'manager', { presentationId: brandA })).status
    ).toBe(200);
    expect((await send('POST', `/projects/${project}/archive`, 'manager')).status).toBe(200);
    await expectError(
      await send('PUT', `/projects/${project}/brand`, 'manager', { presentationId: brandA }),
      409,
      'project_archived'
    );
    await expectError(await send('DELETE', `/projects/${project}/brand`, 'manager'), 409, 'project_archived');
    // Reads stay.
    expect((await readJson(await send('GET', `/projects/${project}/brand`, 'viewer'))).brand.id).toBe(brandA);
    expect((await send('POST', `/projects/${project}/unarchive`, 'manager')).status).toBe(200);
    expect(await readJson(await send('DELETE', `/projects/${project}/brand`, 'manager'))).toEqual({
      brand: null
    });

    expect(
      (await send('PUT', `/projects/${project}/brand`, 'manager', { presentationId: brandA })).status
    ).toBe(200);
    expect((await send('DELETE', `/presentations/${brandA}/projects/${project}`, 'author')).status).toBe(200);
    expect(await readJson(await send('GET', `/projects/${project}/brand`, 'manager'))).toEqual({
      brand: null
    });
    await expectError(
      await send('PUT', `/projects/${project}/brand`, 'manager', { presentationId: brandA }),
      404,
      'not_found'
    );
  });

  it('machine principals: the read scope reads the brand, the write scope sets it, nothing else reaches it', async () => {
    const mint = async (scopes: string[]) =>
      (await readJson(await send('POST', '/api-keys', 'manager', { name: scopes.join('+'), scopes })))
        .key as string;
    const readKey = { key: await mint(['presentations:read']) };
    const writeKey = { key: await mint(['presentations:write']) };
    const exportKey = { key: await mint(['data:export']) };
    expect((await send('GET', `/projects/${project}/brand`, readKey)).status).toBe(200);
    await expectError(
      await send('PUT', `/projects/${project}/brand`, readKey, { presentationId: brandA }),
      403,
      'insufficient_scope'
    );
    await expectError(await send('DELETE', `/projects/${project}/brand`, readKey), 403, 'insufficient_scope');
    expect((await send('DELETE', `/projects/${project}/brand`, writeKey)).status).toBe(200);
    await expectError(await send('GET', `/projects/${project}/brand`, writeKey), 403, 'insufficient_scope');
    await expectError(await send('GET', `/projects/${project}/brand`, exportKey), 403, 'insufficient_scope');
    await expectError(
      await send('POST', `/projects/${project}/brand`, writeKey, {}),
      403,
      'endpoint_not_allowed'
    );
  });
});
