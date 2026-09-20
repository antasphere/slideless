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
 * The deck side of projects through the MCP tools (ADR 026, PRDCT-2579),
 * driven as a real MCP client would: raw JSON-RPC POSTs against /mcp with
 * one slk_ key per role. The API's own rules are pinned by
 * deck-projects.test.ts; this suite pins what a CALLER of the tools sees:
 *
 *  - `projectIds` on an upload lands a deck the project's viewers list
 *    (with `projectId`) and read; a viewer's upload is refused with the
 *    sentence, and nothing is created
 *  - a project the caller cannot read answers not found on the list filter,
 *    the brand read and the default-reference lookup — never a fall-through
 *  - link and unlink, with the roles the descriptions promise
 *  - `slideless_get_default_reference` with `projectId` answers the
 *    project's brand, falls back to the workspace default when the project
 *    has none, and says which it was
 *  - the set/clear pair of `slideless_set_project_brand`, and its refusals
 *    (below manager, not a brand, not linked)
 */

const PASSWORD = 'mcp-projects-pass-0001';
const people = {
  /** The workspace owner: sets the instance up; a workspace owner manages every project. */
  owner: { email: 'owner@mcp-projects.test', name: 'Workspace Owner' },
  /** A plain member who pushes the decks: the deck owner, on no project until a test adds them. */
  author: { email: 'author@mcp-projects.test', name: 'Deck Author' },
  manager: { email: 'manager@mcp-projects.test', name: 'Project Manager' },
  editor: { email: 'editor@mcp-projects.test', name: 'Project Editor' },
  viewer: { email: 'viewer@mcp-projects.test', name: 'Project Viewer' },
  outsider: { email: 'outsider@mcp-projects.test', name: 'Plain Member' }
} as const;
type Who = keyof typeof people;

const PROJECT_NAME = 'Spring launch';
const PHANTOM_PROJECT = '00000000-0000-4000-8000-000000000000';
const brandDoc = (label: string) => `---\ntype: Brand\ntitle: ${label}\n---\n# ${label}\n`;

let container: StartedPostgreSqlContainer;
let app: TestApp;
const cookies: Record<Who, string> = {} as Record<Who, string>;
const keys: Record<Who, string> = {} as Record<Who, string>;
const userIds: Record<Who, string> = {} as Record<Who, string>;
/** The project under test: manager, editor and viewer on it; the author and the outsider are not. */
let project = '';

let ipCounter = 0;
const nextIp = () => `10.98.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

let rpcId = 0;

/** JSON-RPC result of one raw POST to /mcp (throws on protocol-level errors). */
async function rpc(who: Who, method: string, params: unknown = {}) {
  const res = await app.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': nextIp(),
      authorization: `Bearer ${keys[who]}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error, `JSON-RPC error for ${method}: ${JSON.stringify(body.error)}`).toBeUndefined();
  return body.result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMaybe(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Call one tool as one person; returns { isError, text, data } (data = parsed JSON text). */
async function callTool(who: Who, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(who, 'tools/call', { name, arguments: args });
  const text: string = result.content?.[0]?.text ?? '';
  return { isError: result.isError === true, text, data: parseMaybe(text) };
}

/** A tool call that must succeed, unwrapped to its data. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok(who: Who, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await callTool(who, name, args);
  expect(result.isError, `${name} as ${who}: ${result.text}`).toBe(false);
  return result.data;
}

/** A refused call: the status and the code in the text, and never the other status. */
async function expectRefusal(
  who: Who,
  name: string,
  args: Record<string, unknown>,
  status: number,
  code: string
): Promise<string> {
  const result = await callTool(who, name, args);
  expect(result.isError, `${name} as ${who} was not refused: ${result.text}`).toBe(true);
  expect(result.text).toContain(`HTTP ${status}`);
  expect(result.text).toContain(code);
  if (status === 404) expect(result.text).not.toContain('403');
  return result.text;
}

const uploadHtml = (who: Who, title: string, extra: Record<string, unknown> = {}) =>
  callTool(who, 'slideless_upload_html_presentation', {
    html: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`,
    ...extra
  });

const uploadBrand = (who: Who, title: string, extra: Record<string, unknown> = {}) =>
  callTool(who, 'slideless_upload_presentation_files', {
    title,
    files: [
      { path: 'index.html', contentText: `<!doctype html><title>${title}</title><h1>${title}</h1>` },
      { path: 'AGENT.md', contentText: brandDoc(title) }
    ],
    ...extra
  });

const idsOf = (data: { presentations: Array<{ id: string }> }) => data.presentations.map((p) => p.id);

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'mcp_projects_decks'));
  const setup = await app.app.request(
    '/api/v1/setup',
    json({
      setupToken: 'integration-test-setup-token',
      instanceName: 'MCP Projects',
      owner: { ...people.owner, password: PASSWORD }
    })
  );
  expect(setup.status).toBe(201);
  const workspaceId = (await readJson(setup)).workspaceId as string;

  for (const who of Object.keys(people) as Who[]) {
    if (who !== 'owner') {
      const created = await app.auth.api.signUpEmail({ body: { ...people[who], password: PASSWORD } });
      await app.db.db.insert(workspaceMembers).values({
        workspaceId,
        userId: created.user.id,
        role: 'member',
        origin: 'local'
      });
    }
    cookies[who] = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: people[who].email, password: PASSWORD })
      )
    );
    const minted = await app.app.request(
      '/api/v1/api-keys',
      json(
        { name: `${who}-rw`, scopes: ['presentations:read', 'presentations:write'] },
        { cookie: cookies[who] }
      )
    );
    expect(minted.status).toBe(201);
    keys[who] = (await readJson(minted)).key as string;
    userIds[who] = (await ok(who, 'slideless_whoami')).user.id;
  }

  // The project and its roster, through the chassis' own tools.
  project = (await ok('manager', 'slideless_create_project', { name: PROJECT_NAME })).id;
  for (const [who, role] of [
    ['editor', 'editor'],
    ['viewer', 'viewer']
  ] as const) {
    await ok('manager', 'slideless_add_project_member', { projectId: project, userId: userIds[who], role });
  }
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('tools/list: the four deck-side project tools, and the project arguments on the existing ones', () => {
  interface ToolInfo {
    name: string;
    description: string;
    inputSchema?: { properties?: Record<string, unknown> };
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  }
  let byName: Map<string, ToolInfo>;

  beforeAll(async () => {
    const tools = (await rpc('viewer', 'tools/list')).tools as ToolInfo[];
    byName = new Map(tools.map((t) => [t.name, t]));
  });

  it('registers the four tools with the annotations of their kind', () => {
    expect(byName.get('slideless_get_project_brand')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('slideless_unlink_presentation_from_project')?.annotations?.destructiveHint).toBe(true);
    for (const name of [
      'slideless_link_presentation_to_project',
      'slideless_unlink_presentation_from_project',
      'slideless_set_project_brand'
    ]) {
      expect(byName.get(name)?.description, name).toContain('confirm with the user');
    }
  });

  it('the list tools take projectId, the upload tools projectIds, the default lookup projectId', () => {
    for (const name of [
      'slideless_list_presentations',
      'slideless_list_references',
      'slideless_get_default_reference'
    ]) {
      expect(byName.get(name)?.inputSchema?.properties?.projectId, name).toBeDefined();
    }
    for (const name of ['slideless_upload_html_presentation', 'slideless_upload_presentation_files']) {
      expect(byName.get(name)?.inputSchema?.properties?.projectIds, name).toBeDefined();
      // The descriptions send an agent to the project's brand before it authors.
      expect(byName.get(name)?.description, name).toContain('slideless_get_default_reference');
    }
  });
});

describe('projectIds on an upload: an editor lands a deck the project’s viewers list and read', () => {
  let deckId = '';

  it('the editor’s upload is linked in the same commit, and the payload names the project', async () => {
    const result = await uploadHtml('editor', 'Pushed into the project', { projectIds: [project] });
    expect(result.isError, result.text).toBe(false);
    expect(result.data.presentation.projects).toEqual([{ id: project, name: PROJECT_NAME, isBrand: false }]);
    deckId = result.data.presentation.id;
  });

  it('the viewer lists it with projectId, reads it, downloads it; the list without the filter carries it too', async () => {
    const filtered = await ok('viewer', 'slideless_list_presentations', { projectId: project });
    expect(idsOf(filtered)).toEqual([deckId]);
    const unfiltered = await ok('viewer', 'slideless_list_presentations');
    expect(idsOf(unfiltered)).toContain(deckId);

    const deck = await ok('viewer', 'slideless_get_presentation', { presentationId: deckId });
    expect(deck.projects).toEqual([{ id: project, name: PROJECT_NAME, isBrand: false }]);
    const download = await ok('viewer', 'slideless_download_version', { presentationId: deckId });
    expect(download.files[0].content).toContain('Pushed into the project');
  });

  it('a viewer’s upload with projectIds is refused with the sentence, and nothing is created', async () => {
    const before = idsOf(await ok('viewer', 'slideless_list_presentations', { limit: 100 }));
    const text = await expectRefusal(
      'viewer',
      'slideless_upload_html_presentation',
      { html: '<!doctype html><title>By a viewer</title>', projectIds: [project] },
      404,
      'project_not_found'
    );
    expect(text).toContain('List yours with slideless_list_projects');
    // The outsider, and a project that does not exist: the same answer.
    await expectRefusal(
      'outsider',
      'slideless_upload_html_presentation',
      { html: '<!doctype html><title>By an outsider</title>', projectIds: [project] },
      404,
      'project_not_found'
    );
    await expectRefusal(
      'editor',
      'slideless_upload_html_presentation',
      { html: '<!doctype html><title>Phantom</title>', projectIds: [PHANTOM_PROJECT] },
      404,
      'project_not_found'
    );
    expect(idsOf(await ok('viewer', 'slideless_list_presentations', { limit: 100 }))).toEqual(before);
  });

  it('projectIds with presentationId (a new version) is refused before any call', async () => {
    const result = await callTool('editor', 'slideless_upload_presentation_files', {
      presentationId: deckId,
      projectIds: [project],
      files: [{ path: 'index.html', contentText: '<!doctype html><title>v2</title>' }]
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('projectIds applies to a NEW deck only');
    expect(result.text).toContain('slideless_link_presentation_to_project');
    expect(
      (await ok('editor', 'slideless_get_presentation', { presentationId: deckId })).currentVersion
    ).toBe(1);
  });

  it('a project the caller cannot read answers not found on both list filters — never 403', async () => {
    for (const name of ['slideless_list_presentations', 'slideless_list_references']) {
      await expectRefusal('outsider', name, { projectId: project }, 404, 'project_not_found');
      await expectRefusal('viewer', name, { projectId: PHANTOM_PROJECT }, 404, 'project_not_found');
    }
  });
});

describe('link and unlink: the deck administrator with editor on the project; the manager takes a deck out', () => {
  let deckId = '';

  beforeAll(async () => {
    const result = await uploadHtml('author', 'The author’s deck');
    expect(result.isError, result.text).toBe(false);
    deckId = result.data.presentation.id;
  });

  it('before any link, the project’s viewer does not read the deck', async () => {
    await expectRefusal('viewer', 'slideless_get_presentation', { presentationId: deckId }, 404, 'not_found');
  });

  it('the author, not on the project, gets project not found; as an editor of it, the link lands', async () => {
    await expectRefusal(
      'author',
      'slideless_link_presentation_to_project',
      { presentationId: deckId, projectId: project },
      404,
      'project_not_found'
    );
    await ok('manager', 'slideless_add_project_member', {
      projectId: project,
      userId: userIds.author,
      role: 'editor'
    });
    const linked = await ok('author', 'slideless_link_presentation_to_project', {
      presentationId: deckId,
      projectId: project
    });
    expect(linked.projects).toEqual([{ id: project, name: PROJECT_NAME, isBrand: false }]);
    // Linking twice is the same answer.
    const again = await ok('author', 'slideless_link_presentation_to_project', {
      presentationId: deckId,
      projectId: project
    });
    expect(again.projects).toHaveLength(1);

    const deck = await ok('viewer', 'slideless_get_presentation', { presentationId: deckId });
    expect(deck.id).toBe(deckId);
  });

  it('a reader of the deck who administers neither cannot link it, nor a viewer unlink it (a proven reader’s 403)', async () => {
    await expectRefusal(
      'viewer',
      'slideless_unlink_presentation_from_project',
      { presentationId: deckId, projectId: project },
      403,
      'forbidden'
    );
    // The outsider cannot read the deck: 404, whatever the project.
    await expectRefusal(
      'outsider',
      'slideless_unlink_presentation_from_project',
      { presentationId: deckId, projectId: project },
      404,
      'not_found'
    );
  });

  it('the manager takes the deck out; the viewer loses it on the next call; unlinking again is not_linked', async () => {
    const unlinked = await ok('manager', 'slideless_unlink_presentation_from_project', {
      presentationId: deckId,
      projectId: project
    });
    expect(unlinked.projects).toEqual([]);
    await expectRefusal('viewer', 'slideless_get_presentation', { presentationId: deckId }, 404, 'not_found');
    expect(idsOf(await ok('viewer', 'slideless_list_presentations', { projectId: project }))).not.toContain(
      deckId
    );

    const text = await expectRefusal(
      'author',
      'slideless_unlink_presentation_from_project',
      { presentationId: deckId, projectId: project },
      404,
      'not_linked'
    );
    expect(text).toContain('nothing to unlink');
  });
});

describe('the project’s brand: set and cleared by a manager, read first by the default-reference lookup', () => {
  let brandId = '';
  let ordinaryId = '';
  let workspaceBrandId = '';

  beforeAll(async () => {
    // The author is an editor of the project by now: their brand lands linked.
    const brand = await uploadBrand('author', 'Project brand', { projectIds: [project] });
    expect(brand.isError, brand.text).toBe(false);
    brandId = brand.data.presentation.id;
    const ordinary = await uploadHtml('author', 'Ordinary, linked', { projectIds: [project] });
    expect(ordinary.isError, ordinary.text).toBe(false);
    ordinaryId = ordinary.data.presentation.id;
  });

  it('starts empty: get_project_brand answers null, and the default lookup falls back with a note', async () => {
    expect(await ok('viewer', 'slideless_get_project_brand', { projectId: project })).toEqual({
      brand: null
    });

    const fallback = await ok('viewer', 'slideless_get_default_reference', {
      type: 'brand',
      projectId: project
    });
    expect(fallback).toMatchObject({
      type: 'brand',
      source: 'workspace',
      projectId: project,
      presentation: null
    });
    expect(fallback.note).toContain('This project has no brand of its own');
    expect(fallback.note).toContain('No default brand is set in this workspace');
  });

  it('a project you cannot read answers not found on the brand read and the default lookup — no fall-through', async () => {
    await expectRefusal(
      'outsider',
      'slideless_get_project_brand',
      { projectId: project },
      404,
      'project_not_found'
    );
    await expectRefusal(
      'outsider',
      'slideless_get_default_reference',
      { type: 'brand', projectId: project },
      404,
      'project_not_found'
    );
  });

  it('projectId goes with type brand only; set_project_brand takes exactly one of presentationId and clear', async () => {
    const template = await callTool('viewer', 'slideless_get_default_reference', {
      type: 'template',
      projectId: project
    });
    expect(template.isError).toBe(true);
    expect(template.text).toContain('A project carries a brand, not a template');

    for (const args of [{}, { presentationId: brandId, clear: true }]) {
      const result = await callTool('manager', 'slideless_set_project_brand', {
        projectId: project,
        ...args
      });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.text).toContain('exactly one of presentationId');
    }
  });

  it('only a manager sets it, and only to a linked brand reference', async () => {
    const belowManager = await expectRefusal(
      'editor',
      'slideless_set_project_brand',
      { projectId: project, presentationId: brandId },
      403,
      'insufficient_project_role'
    );
    expect(belowManager).toContain('Ask a project manager');

    const notABrand = await expectRefusal(
      'manager',
      'slideless_set_project_brand',
      { projectId: project, presentationId: ordinaryId },
      400,
      'not_a_brand'
    );
    expect(notABrand).toContain('List the brands with slideless_list_references');

    const set = await ok('manager', 'slideless_set_project_brand', {
      projectId: project,
      presentationId: brandId
    });
    expect(set.brand).toMatchObject({ id: brandId, projects: [{ id: project, isBrand: true }] });
    expect((await ok('viewer', 'slideless_get_project_brand', { projectId: project })).brand.id).toBe(
      brandId
    );
    // The listing shows the flag too.
    const listed = await ok('viewer', 'slideless_list_references', { type: 'brand', projectId: project });
    expect(listed.presentations.find((p: { id: string }) => p.id === brandId).projects).toEqual([
      { id: project, name: PROJECT_NAME, isBrand: true }
    ]);
  });

  it('the default lookup answers the project’s brand first, and the workspace default without projectId', async () => {
    // A house default, published to the workspace by the owner.
    const house = await uploadBrand('owner', 'House brand');
    expect(house.isError, house.text).toBe(false);
    workspaceBrandId = house.data.presentation.id;
    for (const body of [{ audience: 'workspace' }, { defaultReference: true }]) {
      const res = await app.app.request(`/api/v1/presentations/${workspaceBrandId}`, {
        ...json(body, { cookie: cookies.owner }),
        method: 'PATCH'
      });
      expect(res.status).toBe(200);
    }

    const forProject = await ok('viewer', 'slideless_get_default_reference', {
      type: 'brand',
      projectId: project
    });
    expect(forProject).toMatchObject({ type: 'brand', source: 'project', projectId: project });
    expect(forProject.presentation.id).toBe(brandId);
    expect(forProject.note).toBeUndefined();
    // Its AGENT.md is what the agent reads next.
    const doc = await ok('viewer', 'slideless_get_agent_doc', { presentationId: brandId });
    expect(doc.content).toContain('type: Brand');

    const house2 = await ok('viewer', 'slideless_get_default_reference', { type: 'brand' });
    expect(house2).toMatchObject({ type: 'brand', source: 'workspace' });
    expect(house2.presentation.id).toBe(workspaceBrandId);
    expect(house2.projectId).toBeUndefined();
  });

  it('clear: true clears it; the lookup then falls back to the house brand and says so', async () => {
    expect(await ok('manager', 'slideless_set_project_brand', { projectId: project, clear: true })).toEqual({
      brand: null
    });
    const fallback = await ok('viewer', 'slideless_get_default_reference', {
      type: 'brand',
      projectId: project
    });
    expect(fallback).toMatchObject({ type: 'brand', source: 'workspace', projectId: project });
    expect(fallback.presentation.id).toBe(workspaceBrandId);
    expect(fallback.note).toBe('This project has no brand of its own, so this is the workspace default.');
    // The deck and its link stay.
    const brand = await ok('viewer', 'slideless_get_presentation', { presentationId: brandId });
    expect(brand.projects).toEqual([{ id: project, name: PROJECT_NAME, isBrand: false }]);
  });

  it('a brand that is not linked to the project answers not_linked on set', async () => {
    const unlinked = await uploadBrand('author', 'Unlinked brand');
    expect(unlinked.isError, unlinked.text).toBe(false);
    // The owner reads every deck of the workspace and manages every project.
    const text = await expectRefusal(
      'owner',
      'slideless_set_project_brand',
      { projectId: project, presentationId: unlinked.data.presentation.id },
      409,
      'not_linked'
    );
    expect(text).toContain('slideless_link_presentation_to_project');
  });
});
