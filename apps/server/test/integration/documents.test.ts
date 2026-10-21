import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { workspaceMembers } from '@antasphere/chassis-db';
import { presentations } from '@slideless/db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * DATA-BOUND TEMPLATES (PRDCT-3641), end to end through the product's own API:
 *
 *  - a TEMPLATE push reads its contract (schema.json, data.json, the pages'
 *    bindings) and refuses what nobody could instantiate, naming the file and
 *    the line; a schema that changed must bump its `version`;
 *  - a DOCUMENT is made from the template with data, pinned to the template
 *    version, its pages rendered with the data (escaped, repeated, the data
 *    block in the entry), `schema.json` dropped and `data.json` the data;
 *  - every write (replace, merge patch, upgrade, a form answer through a share
 *    link) validates against the pinned schema and mints the next version,
 *    with its source and what changed; the answers branch is the server's;
 *  - the read rule (404 for a non-reader, 403 for a reader who may not write),
 *    the guest wall, the not-a-document / not-a-template refusals;
 *  - the two document events, the audit rows, the duplicate and the
 *    Idempotency-Key replay.
 *
 * One app, one container, one webhook receiver.
 */

const PASSWORD = 'documents-pass-00001';
const people = {
  owner: { email: 'owner@documents.test', name: 'Doc Owner' },
  viewer: { email: 'viewer@documents.test', name: 'Project Viewer' },
  outsider: { email: 'outsider@documents.test', name: 'Plain Member' },
  guest: { email: 'guest@outside.test', name: 'Outside Guest' }
} as const;
type Who = keyof typeof people;

// ── The fixture template ─────────────────────────────────────────────────────

type BundleFile = { path: string; bytes: Buffer; contentType: string };
const file = (path: string, content: string | object, contentType: string): BundleFile => ({
  path,
  bytes: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n'),
  contentType
});
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (f: BundleFile) => ({
  path: f.path,
  sha256: shaOf(f.bytes),
  sizeBytes: f.bytes.length,
  contentType: f.contentType
});

const AGENT_MD =
  '---\ntype: Template\ntitle: Lane report\n---\n# Lane report\n\nThe report a lane hands over.\n';
const AGENT = file('AGENT.md', AGENT_MD, 'text/markdown');

const SCHEMA_V1 = {
  $id: 'https://example.test/lane-report',
  version: '1',
  type: 'object',
  properties: {
    title: { type: 'string' },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, headline: { type: 'string' } },
        required: ['id']
      }
    },
    // Beside the brief's schema: one nested object, so a merge patch has something to merge into.
    meta: { type: 'object', properties: { sprint: { type: 'string' }, team: { type: 'string' } } }
  },
  required: ['title'],
  additionalProperties: false
};
const SAMPLE = { title: 'Sample lane', tickets: [{ id: 'PRDCT-1', headline: 'One' }] };

// Line 4: the title, line 5: the list, line 6: the form, line 7: the answer.
const INDEX_HTML =
  '<!doctype html>\n' +
  '<html><head><title>Lane report</title></head>\n' +
  '<body>\n' +
  '<h1>{{title}}</h1>\n' +
  '<ul>{{#tickets}}<li>{{id}}: {{headline}}</li>{{/tickets}}</ul>\n' +
  '<form data-slideless-form="merge_gate"><select name="decision"><option>yes</option><option>no</option></select><textarea name="comment"></textarea></form>\n' +
  '<p>{{answers.merge_gate.decision}}</p>\n' +
  '<a href="pages/two.html">two</a>\n' +
  '</body></html>\n';
const TWO_HTML = '<!doctype html>\n<html><body>\n<h2>{{title}}</h2>\n</body></html>\n';

const INDEX = file('index.html', INDEX_HTML, 'text/html');
const TWO = file('pages/two.html', TWO_HTML, 'text/html');
const schemaFile = (schema: object) => file('schema.json', schema, 'application/json');
const sampleFile = (sample: object) => file('data.json', sample, 'application/json');

const TEMPLATE_FILES: BundleFile[] = [AGENT, schemaFile(SCHEMA_V1), sampleFile(SAMPLE), INDEX, TWO];

/** A schema accepting any extra key: the upgrade's template (a closed schema could never take the new field first). */
const OPEN_SCHEMA_V1 = {
  $id: 'https://example.test/upgradable',
  version: '1',
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title']
};
const OPEN_SCHEMA_V2 = {
  $id: 'https://example.test/upgradable',
  version: '2',
  type: 'object',
  properties: { title: { type: 'string' }, owner: { type: 'string' } },
  required: ['title', 'owner']
};
const UP_INDEX = file(
  'index.html',
  '<!doctype html>\n<html><head></head><body><h1>{{title}}</h1></body></html>\n',
  'text/html'
);

const DATA1 = {
  title: 'Report <b>bold</b>',
  tickets: [
    { id: 'PRDCT-1', headline: 'First' },
    { id: 'PRDCT-2', headline: 'Second' }
  ],
  meta: { sprint: 'S1', team: 'core' }
};

// ── The receiver ─────────────────────────────────────────────────────────────

type Envelope = {
  id: string;
  type: string;
  workspaceId: string;
  subjects: Record<string, unknown>;
  data: Record<string, unknown>;
};
let server: http.Server;
let base = '';
const received: { url: string; body: Envelope }[] = [];

// ── State ────────────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer;
let app: TestApp;
let workspaceId = '';
let projectId = '';
const cookies: Record<Who, string> = { owner: '', viewer: '', outsider: '', guest: '' };
const userIds: Record<Who, string> = { owner: '', viewer: '', outsider: '', guest: '' };
/** The main template, Lane report, at version 1 for the whole file. */
let templateId = '';
/** An ordinary deck (no AGENT.md). */
let ordinaryId = '';

let ipCounter = 0;
const nextIp = () => `10.83.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (
  method: string,
  path: string,
  who: Who | null,
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      ...(who ? { cookie: cookies[who] } : {}),
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

async function expectStatus(res: Response, status: number) {
  const body = await readJson(res);
  expect({ status: res.status, body }).toMatchObject({ status });
  return body;
}

async function expectError(res: Response, status: number, code: string) {
  const body = await readJson(res);
  expect({ status: res.status, code: body?.error?.code }).toEqual({ status, code });
  return body.error as { code: string; message: string; details?: Record<string, unknown> };
}

async function upload(who: Who, f: BundleFile): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(f.bytes));
  form.set('file', new Blob([new Uint8Array(f.bytes)], { type: f.contentType }), f.path.split('/').pop()!);
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie: cookies[who], 'x-forwarded-for': nextIp() },
    body: form
  });
  expect(res.status).toBe(201);
}

/** A first push of a bundle: uploads, a reserved session, the commit's Response. */
async function commitNew(title: string, files: BundleFile[], who: Who = 'owner'): Promise<Response> {
  for (const f of files) await upload(who, f);
  const reserved = await expectStatus(await send('POST', '/presentations/uploads', who), 201);
  return send('POST', `/presentations/uploads/${reserved.uploadSession.id}/commit`, who, {
    title,
    entryPath: 'index.html',
    manifest: files.map(entryOf)
  });
}

async function newDeck(title: string, files: BundleFile[]): Promise<string> {
  const body = await expectStatus(await commitNew(title, files), 201);
  return body.presentation.id as string;
}

async function pushVersion(deckId: string, baseVersion: number, files: BundleFile[]): Promise<Response> {
  for (const f of files) await upload('owner', f);
  return send('POST', `/presentations/${deckId}/versions`, 'owner', {
    expectedBaseVersion: baseVersion,
    entryPath: 'index.html',
    manifest: files.map(entryOf)
  });
}

async function instantiate(
  template: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<{ id: string; body: Awaited<ReturnType<typeof readJson>> }> {
  const body = await expectStatus(
    await send('POST', `/presentations/${template}/instances`, 'owner', { data, ...extra }),
    201
  );
  return { id: body.presentation.id as string, body };
}

async function mintLink(
  deckId: string,
  body: Record<string, unknown>
): Promise<{ id: string; secret: string }> {
  const created = await expectStatus(
    await send('POST', `/presentations/${deckId}/tokens`, 'owner', body),
    201
  );
  return { id: created.shareToken.id, secret: created.secret };
}

const rawPage = async (secret: string, path = ''): Promise<string> => {
  const res = await app.app.request(`/v/${secret}/${path}?raw`, { headers: { accept: 'text/html' } });
  expect(res.status).toBe(200);
  return res.text();
};

const dataOf = async (deckId: string, who: Who = 'owner') =>
  expectStatus(await send('GET', `/presentations/${deckId}/data`, who), 200);

const submitAnswer = (secret: string, form: string, body: unknown) =>
  app.app.request(`/api/v1/viewer/${secret}/forms/${form}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
    body: JSON.stringify(body)
  });

/** The JSON inside the entry's data block, or null. */
function dataBlockOf(html: string): unknown {
  const m = /<script type="application\/json" id="slideless-data">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]!) : null;
}

async function waitFor<T>(
  label: string,
  probe: () => T | undefined | null | false,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function documentsOfTemplate(id: string): Promise<number> {
  const [row] = await app.db.db
    .select({ n: sql<number>`count(*)::int` })
    .from(presentations)
    .where(and(eq(presentations.templateId, id), isNull(presentations.deletedAt)));
  return row!.n;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      try {
        received.push({ url: req.url ?? '', body: JSON.parse(raw) as Envelope });
      } catch {
        // not an envelope
      }
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  container = await startPostgres();
  app = await createTestApp(
    await createDatabase(container, 'documents'),
    { WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true' },
    { webhookDials: { listenerTtlMs: 0, retryLimit: 1, retryDelaySeconds: 1 } }
  );
  const setup = await app.app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({
      setupToken: 'integration-test-setup-token',
      instanceName: 'Documents',
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
    userIds[who] = (await readJson(await send('GET', '/me', who))).user.id;
  }

  projectId = (await expectStatus(await send('POST', '/projects', 'owner', { name: 'Lanes' }), 201)).id;
  await expectStatus(
    await send('POST', `/projects/${projectId}/members`, 'owner', { userId: userIds.viewer, role: 'viewer' }),
    201
  );

  await expectStatus(
    await send('POST', '/webhooks', 'owner', { url: `${base}/documents`, events: ['document.*'] }),
    201
  );

  templateId = await newDeck('Lane report', TEMPLATE_FILES);
  ordinaryId = await newDeck('Plain deck', [
    file(
      'index.html',
      '<!doctype html><html><body><h1>{{not a binding here}}</h1></body></html>',
      'text/html'
    )
  ]);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

// ── 1. The template push reads its contract ──────────────────────────────────

describe('a template push reads its contract and refuses what nobody could instantiate', () => {
  it('a page binding a field the schema lacks is refused 400 binding_unknown, naming the file and the line', async () => {
    const bad = file(
      'index.html',
      '<!doctype html>\n<html><head></head>\n<body>\n<h1>{{title}}</h1>\n<p>{{nope}}</p>\n</body></html>\n',
      'text/html'
    );
    const e = await expectError(
      await commitNew('Unknown binding', [AGENT, schemaFile(SCHEMA_V1), sampleFile(SAMPLE), bad]),
      400,
      'binding_unknown'
    );
    expect(e.details!.unknown).toEqual([{ path: 'nope', file: 'index.html', line: 5 }]);
    expect(e.message).toContain('index.html line 5');
  });

  it('a section never closed is refused 400 binding_syntax with the file and the line', async () => {
    const bad = file(
      'index.html',
      '<!doctype html>\n<html><head></head>\n<body>\n<ul>{{#tickets}}<li>{{id}}</li></ul>\n</body></html>\n',
      'text/html'
    );
    const e = await expectError(
      await commitNew('Unclosed section', [AGENT, schemaFile(SCHEMA_V1), sampleFile(SAMPLE), bad]),
      400,
      'binding_syntax'
    );
    const errors = e.details!.errors as { file?: string; line: number; message: string }[];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.file).toBe('index.html');
    expect(errors[0]!.line).toBeGreaterThanOrEqual(1);
    expect(e.message).toContain('index.html line');
  });

  it('a sample the schema refuses is refused 400 sample_invalid with the JSON pointer', async () => {
    const e = await expectError(
      await commitNew('Bad sample', [AGENT, schemaFile(SCHEMA_V1), sampleFile({ title: 42 }), INDEX, TWO]),
      400,
      'sample_invalid'
    );
    const issues = e.details!.issues as { path: string }[];
    expect(issues.map((i) => i.path)).toContain('/title');
  });

  it('a schema.json without a version is refused 400 schema_invalid', async () => {
    const { version: _v, ...unversioned } = SCHEMA_V1;
    await expectError(
      await commitNew('Unversioned', [AGENT, schemaFile(unversioned), sampleFile(SAMPLE), INDEX, TWO]),
      400,
      'schema_invalid'
    );
  });

  it('a schema changed without bumping its version is refused schema_version_unchanged; bumped, it lands', async () => {
    const id = await newDeck('Versioned template', TEMPLATE_FILES);
    // Same schema, a page changed: not a schema change, lands.
    const retitled = file('pages/two.html', TWO_HTML.replace('<h2>', '<h2 class="x">'), 'text/html');
    await expectStatus(
      await pushVersion(id, 1, [AGENT, schemaFile(SCHEMA_V1), sampleFile(SAMPLE), INDEX, retitled]),
      201
    );

    const changed = { ...SCHEMA_V1, description: 'Now described' };
    const e = await expectError(
      await pushVersion(id, 2, [AGENT, schemaFile(changed), sampleFile(SAMPLE), INDEX, retitled]),
      400,
      'schema_version_unchanged'
    );
    expect(e.details).toEqual({ version: '1' });

    await expectStatus(
      await pushVersion(id, 2, [
        AGENT,
        schemaFile({ ...changed, version: '2' }),
        sampleFile(SAMPLE),
        INDEX,
        retitled
      ]),
      201
    );
    const contract = await expectStatus(await send('GET', `/presentations/${id}/schema`, 'owner'), 200);
    expect(contract.version).toBe(3);
    expect(contract.schemaVersion).toBe('2');
    expect(contract.schema.description).toBe('Now described');
  });
});

// ── 2. The contract read back ────────────────────────────────────────────────

describe('GET /presentations/{id}/schema', () => {
  it('answers the schema, the sample and the sorted bindings of the current template version', async () => {
    const contract = await expectStatus(
      await send('GET', `/presentations/${templateId}/schema`, 'owner'),
      200
    );
    expect(contract).toEqual({
      presentationId: templateId,
      version: 1,
      schemaVersion: '1',
      schema: SCHEMA_V1,
      sample: SAMPLE,
      bindings: ['answers.merge_gate.decision', 'tickets', 'tickets.headline', 'tickets.id', 'title']
    });
  });

  it('an ordinary deck answers 422 not_a_template; a template without schema.json 422 no_schema', async () => {
    await expectError(
      await send('GET', `/presentations/${ordinaryId}/schema`, 'owner'),
      422,
      'not_a_template'
    );
    const bare = await newDeck('Template without schema', [
      AGENT,
      file('index.html', '<h1>plain</h1>', 'text/html')
    ]);
    await expectError(await send('GET', `/presentations/${bare}/schema`, 'owner'), 422, 'no_schema');
  });
});

// ── 3. A document is made ────────────────────────────────────────────────────

describe('POST /presentations/{templateId}/instances', () => {
  let docId = '';
  let secret = '';

  it('creates a document pinned to the template’s current version', async () => {
    const { id, body } = await instantiate(templateId, DATA1, { title: 'Lane A report' });
    docId = id;
    expect(body.presentation.title).toBe('Lane A report');
    expect(body.presentation.currentVersion).toBe(1);
    expect(body.presentation.document).toMatchObject({ templateId, templateVersion: 1 });
    expect(body.version.version).toBe(1);
    expect(body.data).toEqual({
      presentationId: id,
      version: 1,
      template: { templateId, templateVersion: 1, schemaVersion: '1' },
      data: DATA1
    });
    // The read back says the same.
    expect((await dataOf(id)).data).toEqual(DATA1);
  });

  // DEFECT: presentationToWire (apps/server/src/api/presentations.ts:128) calls documentBindingOf(p)
  // without the schema version, so `presentation.document.schemaVersion` is always ''.
  it('presentation.document carries the pinned schema version string', async () => {
    const deck = await expectStatus(await send('GET', `/presentations/${docId}`, 'owner'), 200);
    expect(deck.document).toEqual({ templateId, templateVersion: 1, schemaVersion: '1' });
  });

  it('renders the entry: the title escaped, one <li> per ticket, the data block before </head>', async () => {
    secret = (await mintLink(docId, { name: 'reader' })).secret;
    const html = await rawPage(secret);
    expect(html).toContain('<h1>Report &lt;b&gt;bold&lt;/b&gt;</h1>');
    expect(html).not.toContain('<h1>Report <b>');
    expect(html).toContain('<ul><li>PRDCT-1: First</li><li>PRDCT-2: Second</li></ul>');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('<p></p>');
    expect(html).not.toContain('{{');
    const block = html.indexOf('<script type="application/json" id="slideless-data">');
    expect(block).toBeGreaterThan(-1);
    expect(block).toBeLessThan(html.indexOf('</head>'));
    expect(dataBlockOf(html)).toEqual(DATA1);
  });

  it('renders every bound page, the second page without the data block', async () => {
    const two = await rawPage(secret, 'pages/two.html');
    expect(two).toContain('<h2>Report &lt;b&gt;bold&lt;/b&gt;</h2>');
    expect(two).not.toContain('slideless-data');
  });

  it('serves data.json as the data, and drops schema.json from the manifest', async () => {
    const res = await app.app.request(`/v/${secret}/data.json`);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual(DATA1);
    const v1 = await expectStatus(await send('GET', `/presentations/${docId}/versions/1`, 'owner'), 200);
    const paths = (v1.manifest as { path: string }[]).map((e) => e.path).sort();
    expect(paths).toEqual(['AGENT.md', 'data.json', 'index.html', 'pages/two.html']);
  });
});

// ── 4. The data is judged by the pinned schema ───────────────────────────────

describe('a write the schema refuses is 400 data_invalid naming the field', () => {
  let docId = '';
  beforeAll(async () => {
    docId = (await instantiate(templateId, { title: 'Judged' })).id;
  });

  it('a number for the title names /title', async () => {
    const e = await expectError(
      await send('PUT', `/presentations/${docId}/data`, 'owner', { title: 42 }),
      400,
      'data_invalid'
    );
    const issues = e.details!.issues as { path: string; message: string }[];
    expect(issues.map((i) => i.path)).toContain('/title');
    expect(e.message).toContain('/title');
    expect((await dataOf(docId)).version).toBe(1);
  });

  // DEFECT: validateDataAgainstSchema (packages/contract/src/document-data.ts:47) reports the
  // @cfworker validator's errors innermost first, and under `additionalProperties: false` the
  // first one for a mistyped DECLARED property is "False boolean schema." — the headline the
  // caller reads (api/documents.ts `data_invalid` message) says nothing about the type.
  it('the headline of a type error is the type sentence, not the additionalProperties echo', async () => {
    const e = await expectError(
      await send('PUT', `/presentations/${docId}/data`, 'owner', { title: 42 }),
      400,
      'data_invalid'
    );
    expect(e.message).toMatch(/type/i);
    expect(e.message).not.toContain('False boolean schema');
  });

  it('an item without its id is refused, the pointer inside /tickets/0', async () => {
    const e = await expectError(
      await send('PATCH', `/presentations/${docId}/data`, 'owner', { tickets: [{ headline: 'no id' }] }),
      400,
      'data_invalid'
    );
    const issues = e.details!.issues as { path: string; message: string }[];
    expect(issues.some((i) => i.path.startsWith('/tickets/0'))).toBe(true);
  });

  // DEFECT: a missing required property is reported at the OBJECT's pointer (`/tickets/0`), the
  // validator's instanceLocation, never at the field's (`/tickets/0/id`): validateDataAgainstSchema
  // (packages/contract/src/document-data.ts:48) does not map `required` errors to the missing key.
  it('an item without its id names /tickets/0/id', async () => {
    const e = await expectError(
      await send('PATCH', `/presentations/${docId}/data`, 'owner', { tickets: [{ headline: 'no id' }] }),
      400,
      'data_invalid'
    );
    expect((e.details!.issues as { path: string }[]).map((i) => i.path)).toContain('/tickets/0/id');
  });

  it('a body carrying `answers` is refused 400 validation_error on PUT, PATCH and the instance', async () => {
    await expectError(
      await send('PUT', `/presentations/${docId}/data`, 'owner', { title: 'x', answers: {} }),
      400,
      'validation_error'
    );
    await expectError(
      await send('PATCH', `/presentations/${docId}/data`, 'owner', {
        answers: { merge_gate: { decision: 'yes' } }
      }),
      400,
      'validation_error'
    );
    await expectError(
      await send('POST', `/presentations/${templateId}/instances`, 'owner', {
        data: { title: 'x', answers: {} }
      }),
      400,
      'validation_error'
    );
    expect((await dataOf(docId)).version).toBe(1);
  });

  it('an instance whose data fails the schema is refused data_invalid and makes no deck', async () => {
    const before = await documentsOfTemplate(templateId);
    await expectError(
      await send('POST', `/presentations/${templateId}/instances`, 'owner', { data: { tickets: [] } }),
      400,
      'data_invalid'
    );
    expect(await documentsOfTemplate(templateId)).toBe(before);
  });
});

// ── 5. Replace, merge, the history ───────────────────────────────────────────

describe('PUT replaces, PATCH merges, each a new version with what changed', () => {
  let docId = '';
  beforeAll(async () => {
    docId = (await instantiate(templateId, DATA1)).id;
  });

  it('PUT replaces the whole data: a key dropped is gone', async () => {
    const body = await expectStatus(
      await send('PUT', `/presentations/${docId}/data`, 'owner', {
        title: 'Replaced',
        tickets: DATA1.tickets
      }),
      200
    );
    expect(body.version.version).toBe(2);
    expect(body.presentation.currentVersion).toBe(2);
    expect(body.data.data).toEqual({ title: 'Replaced', tickets: DATA1.tickets });
    expect((await dataOf(docId)).data).not.toHaveProperty('meta');
  });

  it('PATCH merges: a nested object merges, null deletes', async () => {
    await expectStatus(
      await send('PATCH', `/presentations/${docId}/data`, 'owner', { meta: { sprint: 'S2', team: 'core' } }),
      200
    );
    const body = await expectStatus(
      await send('PATCH', `/presentations/${docId}/data`, 'owner', { meta: { sprint: 'S3' }, tickets: null }),
      200
    );
    expect(body.version.version).toBe(4);
    expect(body.data.data).toEqual({ title: 'Replaced', meta: { sprint: 'S3', team: 'core' } });
  });

  it('the versions list is newest first, with the source and the keys that changed', async () => {
    const list = await expectStatus(await send('GET', `/presentations/${docId}/data/versions`, 'owner'), 200);
    expect(
      list.versions.map((v: { version: number; source: string; changed: string[] }) => [
        v.version,
        v.source,
        v.changed
      ])
    ).toEqual([
      [4, 'push', ['meta', 'tickets']],
      [3, 'push', ['meta']],
      [2, 'push', ['meta', 'title']],
      [1, 'create', ['meta', 'tickets', 'title']]
    ]);
    for (const v of list.versions) {
      expect(v.templateVersion).toBe(1);
      expect(v.answeredBy).toBeNull();
      expect(v.createdBy).toBe(userIds.owner);
    }
  });

  it('GET …/data/versions/{n} returns the data as it was', async () => {
    const v2 = await expectStatus(await send('GET', `/presentations/${docId}/data/versions/2`, 'owner'), 200);
    expect(v2.data).toEqual({ title: 'Replaced', tickets: DATA1.tickets });
    const v1 = await expectStatus(await send('GET', `/presentations/${docId}/data/versions/1`, 'owner'), 200);
    expect(v1.data).toEqual(DATA1);
    await expectError(
      await send('GET', `/presentations/${docId}/data/versions/99`, 'owner'),
      404,
      'not_found'
    );
  });
});

// ── 6. The answers ───────────────────────────────────────────────────────────

describe('a form answered through a share link lands in the data', () => {
  let docId = '';
  let link = { id: '', secret: '' };
  let responseId = '';

  beforeAll(async () => {
    docId = (await instantiate(templateId, { title: 'Merge gate' })).id;
    link = await mintLink(docId, { name: 'romain', remembersResponses: true, canSubmitForms: true });
  });

  it('the viewer answer is unchanged (201), and GET /answers shows the form, the fields and who', async () => {
    const res = await submitAnswer(link.secret, 'merge_gate', {
      payload: { decision: 'yes', comment: 'merge it' },
      source: 'link'
    });
    expect(res.status).toBe(201);
    responseId = (await readJson(res)).response.id;

    const answers = await expectStatus(await send('GET', `/presentations/${docId}/answers`, 'owner'), 200);
    expect(answers.presentationId).toBe(docId);
    expect(answers.version).toBe(2);
    expect(answers.answers).toHaveLength(1);
    expect(answers.answers[0]).toMatchObject({
      form: 'merge_gate',
      fields: { decision: 'yes', comment: 'merge it' },
      answeredBy: 'romain',
      linkId: link.id,
      responseId,
      revision: 1
    });
    expect(typeof answers.answers[0].answeredAt).toBe('string');
  });

  it('the document is at a new version, source answer, answered by the link’s name', async () => {
    const data = await dataOf(docId);
    expect(data.version).toBe(2);
    expect(data.data.answers.merge_gate).toMatchObject({
      decision: 'yes',
      comment: 'merge it',
      $answered: { by: 'romain', link: link.id, response: responseId, revision: 1 }
    });
    const list = await expectStatus(await send('GET', `/presentations/${docId}/data/versions`, 'owner'), 200);
    expect(list.versions[0]).toMatchObject({
      version: 2,
      source: 'answer',
      answeredBy: 'romain',
      changed: ['answers.merge_gate']
    });
  });

  it('the rendered entry now carries the answer', async () => {
    expect(await rawPage(link.secret)).toContain('<p>yes</p>');
  });

  it('a PUT of new data afterwards keeps the answer', async () => {
    const before = await expectStatus(await send('GET', `/presentations/${docId}/answers`, 'owner'), 200);
    const body = await expectStatus(
      await send('PUT', `/presentations/${docId}/data`, 'owner', { title: 'Merge gate, renamed' }),
      200
    );
    expect(body.data.data.title).toBe('Merge gate, renamed');
    expect(body.data.data.answers.merge_gate.decision).toBe('yes');
    const after = await expectStatus(await send('GET', `/presentations/${docId}/answers`, 'owner'), 200);
    expect(after.answers).toEqual(before.answers);
    expect(after.version).toBe(3);
    expect(await rawPage(link.secret)).toContain('<p>yes</p>');
  });

  it('a response under a wrong secret answers 404 and the version does not move', async () => {
    const wrong = link.secret.slice(0, -4) + (link.secret.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const res = await submitAnswer(wrong, 'merge_gate', { payload: { decision: 'no' }, source: 'link' });
    expect(res.status).toBe(404);
    const data = await dataOf(docId);
    expect(data.version).toBe(3);
    expect(data.data.answers.merge_gate.decision).toBe('yes');
  });

  it('a plain (non-remembering) link answers too: the create path mirrors, and the edit path mirrors again', async () => {
    const plain = await mintLink(docId, { name: 'plain', remembersResponses: false, canSubmitForms: true });
    const before = (await dataOf(docId)).version;
    const res = await submitAnswer(plain.secret, 'merge_gate', {
      payload: { decision: 'no', comment: 'from a plain link' },
      source: 'link'
    });
    expect(res.status).toBe(201);
    const created = await readJson(res);
    const afterCreate = await dataOf(docId);
    expect(afterCreate.version).toBe(before + 1);
    expect(afterCreate.data.answers.merge_gate).toMatchObject({
      decision: 'no',
      comment: 'from a plain link',
      $answered: { by: 'plain', link: plain.id, response: created.response.id, revision: 1 }
    });
    // The respondent edits through the edit secret: revision 2 lands in the data too.
    const edit = await app.app.request(`/api/v1/viewer/${plain.secret}/forms/merge_gate/responses/me`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        origin: 'null',
        'x-forwarded-for': nextIp(),
        'x-slideless-response': created.editSecret
      },
      body: JSON.stringify({ payload: { decision: 'yes', comment: 'edited' } })
    });
    expect(edit.status).toBe(200);
    const afterEdit = await dataOf(docId);
    expect(afterEdit.version).toBe(before + 2);
    expect(afterEdit.data.answers.merge_gate).toMatchObject({
      decision: 'yes',
      comment: 'edited',
      $answered: { by: 'plain', response: created.response.id, revision: 2 }
    });
  });
});

// ── 7. Who may, and on what ──────────────────────────────────────────────────

describe('the refusals: not a document, not a template, the guest, the reader, the outsider', () => {
  let docId = '';
  beforeAll(async () => {
    docId = (await instantiate(templateId, { title: 'Linked' }, { projectIds: [projectId] })).id;
  });

  it('an ordinary deck answers 422 not_a_document on every document route', async () => {
    const P = `/presentations/${ordinaryId}`;
    await expectError(await send('GET', `${P}/data`, 'owner'), 422, 'not_a_document');
    await expectError(await send('PUT', `${P}/data`, 'owner', { title: 'x' }), 422, 'not_a_document');
    await expectError(await send('PATCH', `${P}/data`, 'owner', { title: 'x' }), 422, 'not_a_document');
    await expectError(await send('GET', `${P}/data/versions`, 'owner'), 422, 'not_a_document');
    await expectError(await send('GET', `${P}/answers`, 'owner'), 422, 'not_a_document');
    await expectError(await send('POST', `${P}/upgrade`, 'owner', {}), 422, 'not_a_document');
  });

  it('a non-template, and a template without schema, answer 422 not_a_data_template on instances', async () => {
    await expectError(
      await send('POST', `/presentations/${ordinaryId}/instances`, 'owner', { data: { title: 'x' } }),
      422,
      'not_a_data_template'
    );
    const bare = await newDeck('Schema-less template', [
      AGENT,
      file('index.html', '<h1>bare</h1>', 'text/html')
    ]);
    await expectError(
      await send('POST', `/presentations/${bare}/instances`, 'owner', { data: { title: 'x' } }),
      422,
      'not_a_data_template'
    );
    // A document is not a template either.
    await expectError(
      await send('POST', `/presentations/${docId}/instances`, 'owner', { data: { title: 'x' } }),
      422,
      'not_a_data_template'
    );
  });

  it('a guest gets 403 guest_forbidden on instances, whatever the id', async () => {
    await expectError(
      await send('POST', `/presentations/${templateId}/instances`, 'guest', { data: { title: 'x' } }),
      403,
      'guest_forbidden'
    );
    await expectError(
      await send('POST', '/presentations/00000000-0000-4000-8000-0000000000ee/instances', 'guest', {
        data: { title: 'x' }
      }),
      403,
      'guest_forbidden'
    );
  });

  it('a project viewer reads the document and gets 403 forbidden on every write', async () => {
    expect((await dataOf(docId, 'viewer')).data).toEqual({ title: 'Linked' });
    await expectStatus(await send('GET', `/presentations/${docId}/answers`, 'viewer'), 200);
    await expectError(
      await send('PUT', `/presentations/${docId}/data`, 'viewer', { title: 'Mine' }),
      403,
      'forbidden'
    );
    await expectError(
      await send('PATCH', `/presentations/${docId}/data`, 'viewer', { title: 'Mine' }),
      403,
      'forbidden'
    );
    await expectError(await send('POST', `/presentations/${docId}/upgrade`, 'viewer', {}), 403, 'forbidden');
    expect((await dataOf(docId)).version).toBe(1);
  });

  it('a member who cannot read gets 404 on the reads and the writes', async () => {
    await expectError(await send('GET', `/presentations/${docId}/data`, 'outsider'), 404, 'not_found');
    await expectError(await send('GET', `/presentations/${docId}/answers`, 'outsider'), 404, 'not_found');
    await expectError(
      await send('PUT', `/presentations/${docId}/data`, 'outsider', { title: 'x' }),
      404,
      'not_found'
    );
    await expectError(
      await send('POST', `/presentations/${templateId}/instances`, 'outsider', { data: { title: 'x' } }),
      404,
      'not_found'
    );
    await expectError(await send('GET', `/presentations/${templateId}/schema`, 'outsider'), 404, 'not_found');
  });
});

// ── 8. The upgrade ───────────────────────────────────────────────────────────

describe('POST /presentations/{id}/upgrade', () => {
  let upId = '';
  let docId = '';

  beforeAll(async () => {
    upId = await newDeck('Upgradable', [AGENT, schemaFile(OPEN_SCHEMA_V1), UP_INDEX]);
    docId = (await instantiate(upId, { title: 'To upgrade' })).id;
    await expectStatus(await pushVersion(upId, 1, [AGENT, schemaFile(OPEN_SCHEMA_V2), UP_INDEX]), 201);
  });

  it('refused 400 data_invalid when the data fails the new schema, the pin unchanged', async () => {
    const e = await expectError(
      await send('POST', `/presentations/${docId}/upgrade`, 'owner', {}),
      400,
      'data_invalid'
    );
    const issues = e.details!.issues as { path: string; message: string }[];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.message.includes('owner'))).toBe(true);
    const data = await dataOf(docId);
    expect(data.template.templateVersion).toBe(1);
    expect(data.version).toBe(1);
  });

  // DEFECT: the missing required `owner` is reported at the root pointer ('') rather than at
  // '/owner' (packages/contract/src/document-data.ts:48, the `required` error's instanceLocation).
  it('the refusal names /owner', async () => {
    const e = await expectError(
      await send('POST', `/presentations/${docId}/upgrade`, 'owner', {}),
      400,
      'data_invalid'
    );
    expect((e.details!.issues as { path: string }[]).map((i) => i.path)).toContain('/owner');
  });

  it('with the field pushed first, the upgrade moves the pin to 2, source upgrade', async () => {
    await expectStatus(
      await send('PATCH', `/presentations/${docId}/data`, 'owner', { owner: 'romain' }),
      200
    );
    const body = await expectStatus(await send('POST', `/presentations/${docId}/upgrade`, 'owner', {}), 200);
    expect(body.version.version).toBe(3);
    expect(body.data.template).toEqual({ templateId: upId, templateVersion: 2, schemaVersion: '2' });
    expect(body.presentation.document).toMatchObject({ templateId: upId, templateVersion: 2 });
    const list = await expectStatus(await send('GET', `/presentations/${docId}/data/versions`, 'owner'), 200);
    expect(list.versions[0]).toMatchObject({ version: 3, source: 'upgrade', templateVersion: 2 });
  });

  it('again: 400 already_on_version; a version that does not exist: 400 template_version_invalid', async () => {
    const again = await expectError(
      await send('POST', `/presentations/${docId}/upgrade`, 'owner', {}),
      400,
      'already_on_version'
    );
    expect(again.details).toEqual({ version: 2 });
    const missing = await expectError(
      await send('POST', `/presentations/${docId}/upgrade`, 'owner', { toVersion: 99 }),
      400,
      'template_version_invalid'
    );
    expect(missing.details).toEqual({ version: 99 });
  });

  it('the template deleted: 422 template_gone, while GET data still answers', async () => {
    expect((await send('DELETE', `/presentations/${upId}`, 'owner')).status).toBe(200);
    await expectError(
      await send('POST', `/presentations/${docId}/upgrade`, 'owner', {}),
      422,
      'template_gone'
    );
    const data = await dataOf(docId);
    expect(data.data).toEqual({ title: 'To upgrade', owner: 'romain' });
    expect(data.template.templateVersion).toBe(2);
  });
});

// ── 11. The schema set through the API ───────────────────────────────────────

describe('PUT /presentations/{id}/schema', () => {
  let id = '';
  beforeAll(async () => {
    id = await newDeck('Schema by API', TEMPLATE_FILES);
  });

  it('a schema the pages do not satisfy is refused 400 binding_unknown', async () => {
    const narrow = {
      version: '2',
      type: 'object',
      properties: { title: { type: 'string' } },
      additionalProperties: false
    };
    const e = await expectError(
      await send('PUT', `/presentations/${id}/schema`, 'owner', { schema: narrow, sample: { title: 'x' } }),
      400,
      'binding_unknown'
    );
    const unknown = (e.details!.unknown as { path: string; file: string }[]).map(
      (u) => `${u.file}:${u.path}`
    );
    expect(unknown).toContain('index.html:tickets');
    const contract = await expectStatus(await send('GET', `/presentations/${id}/schema`, 'owner'), 200);
    expect(contract.version).toBe(1);
  });

  it('a changed schema under the same version is refused schema_version_unchanged', async () => {
    await expectError(
      await send('PUT', `/presentations/${id}/schema`, 'owner', {
        schema: { ...SCHEMA_V1, description: 'x' }
      }),
      400,
      'schema_version_unchanged'
    );
  });

  it('a good schema with its version bumped mints a new template version, and GET /schema reflects it', async () => {
    const next = {
      ...SCHEMA_V1,
      version: '2',
      properties: { ...SCHEMA_V1.properties, summary: { type: 'string' } }
    };
    const set = await expectStatus(
      await send('PUT', `/presentations/${id}/schema`, 'owner', { schema: next }),
      200
    );
    expect(set).toMatchObject({
      presentationId: id,
      version: 2,
      schemaVersion: '2',
      schema: next,
      sample: SAMPLE
    });
    const contract = await expectStatus(await send('GET', `/presentations/${id}/schema`, 'owner'), 200);
    expect(contract).toEqual(set);
    const deck = await expectStatus(await send('GET', `/presentations/${id}`, 'owner'), 200);
    expect(deck.currentVersion).toBe(2);
  });

  it('an ordinary deck answers 422 not_a_template; a member who cannot read gets 404', async () => {
    await expectError(
      await send('PUT', `/presentations/${ordinaryId}/schema`, 'owner', { schema: { version: '1' } }),
      422,
      'not_a_template'
    );
    await expectError(
      await send('PUT', `/presentations/${id}/schema`, 'outsider', { schema: { version: '9' } }),
      404,
      'not_found'
    );
  });
});

// ── 12. The duplicate, 13. the replay ────────────────────────────────────────

describe('a duplicate of a document, and one Idempotency-Key', () => {
  it('a duplicate of a document is a document on the same pin with the same data', async () => {
    const { id } = await instantiate(templateId, DATA1);
    await expectStatus(
      await send('PATCH', `/presentations/${id}/data`, 'owner', { title: 'Before the copy' }),
      200
    );
    const copy = await expectStatus(await send('POST', `/presentations/${id}/duplicate`, 'owner', {}), 201);
    expect(copy.presentation.id).not.toBe(id);
    expect(copy.presentation.document).toMatchObject({ templateId, templateVersion: 1 });
    const copied = await dataOf(copy.presentation.id);
    expect(copied.data).toEqual({ ...DATA1, title: 'Before the copy' });
    expect(copied.template).toEqual({ templateId, templateVersion: 1, schemaVersion: '1' });
    // And it is a document on its own: it takes a push.
    await expectStatus(
      await send('PATCH', `/presentations/${copy.presentation.id}/data`, 'owner', { title: 'The copy' }),
      200
    );
    expect((await dataOf(id)).data.title).toBe('Before the copy');
  });

  it('the same Idempotency-Key twice creates ONE document', async () => {
    const before = await documentsOfTemplate(templateId);
    const headers = { 'idempotency-key': 'documents-instance-1' };
    const body = { data: { title: 'Once' } };
    const first = await send('POST', `/presentations/${templateId}/instances`, 'owner', body, headers);
    expect(first.status).toBe(201);
    const second = await send('POST', `/presentations/${templateId}/instances`, 'owner', body, headers);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect((await readJson(second)).presentation.id).toBe((await readJson(first)).presentation.id);
    expect(await documentsOfTemplate(templateId)).toBe(before + 1);
  });
});

// ── The blob read scope holds at the contract read too ───────────────────────

describe('the contract read never opens a blob the pusher cannot read (SL-B1)', () => {
  // DEFECT: readTemplateContract (apps/server/src/presentations/data-contract.ts:200, called by
  // api/presentations.ts:314 and :407 BEFORE the commit's lockAndResolveBlobs) reads every
  // text/html sha of the manifest from workspace storage with no read scope. A member naming a
  // sha they cannot read gets `binding_unknown` with the other page's field paths and lines (its
  // content, and the proof the bytes exist) where the commit would have answered `missing_blobs`.
  it('a member naming another member’s page sha is answered missing_blobs, never binding_unknown', async () => {
    const theirs = schemaFile({
      version: 'probe-1',
      type: 'object',
      properties: {},
      additionalProperties: false
    });
    await upload('outsider', AGENT);
    await upload('outsider', theirs);
    const reserved = await expectStatus(await send('POST', '/presentations/uploads', 'outsider'), 201);
    const res = await send('POST', `/presentations/uploads/${reserved.uploadSession.id}/commit`, 'outsider', {
      title: 'Probe',
      entryPath: 'index.html',
      // INDEX is the owner's page: the outsider never uploaded it and reads no deck carrying it.
      manifest: [entryOf(AGENT), entryOf(theirs), entryOf(INDEX)]
    });
    const e = await expectError(res, 400, 'missing_blobs');
    expect(e.details).toEqual({ missing: [shaOf(INDEX.bytes)] });
  });

  it('the same on a version commit of a template the member owns: missing_blobs, nothing read', async () => {
    const theirs = schemaFile({
      version: 'own-1',
      type: 'object',
      properties: { title: { type: 'string' } }
    });
    const page = file(
      'index.html',
      '<!doctype html><html><head><title>{{title}}</title></head><body>{{title}}</body></html>',
      'text/html'
    );
    for (const f of [AGENT, theirs, page]) await upload('outsider', f);
    const reserved = await expectStatus(await send('POST', '/presentations/uploads', 'outsider'), 201);
    const own = await expectStatus(
      await send('POST', `/presentations/uploads/${reserved.uploadSession.id}/commit`, 'outsider', {
        title: 'Own template',
        entryPath: 'index.html',
        manifest: [AGENT, theirs, page].map(entryOf)
      }),
      201
    );
    const res = await send('POST', `/presentations/${own.presentation.id}/versions`, 'outsider', {
      expectedBaseVersion: 1,
      entryPath: 'index.html',
      manifest: [entryOf(AGENT), entryOf(theirs), entryOf(INDEX)]
    });
    const e = await expectError(res, 400, 'missing_blobs');
    expect(e.details).toEqual({ missing: [shaOf(INDEX.bytes)] });
  });
});

// ── The write lock: two concurrent writes on one document both land ──────────

describe('two concurrent writes on one document', () => {
  it('both PATCHes land, in two versions, neither key lost', async () => {
    const { id } = await instantiate(templateId, { title: 'Raced', meta: { k: 'v' } });
    const [a, b] = await Promise.all([
      send('PATCH', `/presentations/${id}/data`, 'owner', { title: 'Raced, renamed' }),
      send('PATCH', `/presentations/${id}/data`, 'owner', { meta: { sprint: 'S2' } })
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const now = await dataOf(id);
    expect(now.version).toBe(3);
    expect(now.data.title).toBe('Raced, renamed');
    expect(now.data.meta).toEqual({ k: 'v', sprint: 'S2' });
    const list = await expectStatus(await send('GET', `/presentations/${id}/data/versions`, 'owner'), 200);
    expect(list.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
  });
});

// ── 9. The events, 10. the audit (last: they read what the file did) ─────────

describe('the two document events', () => {
  const at = (type: string) => received.filter((r) => r.url === '/documents' && r.body.type === type);

  it('the endpoint subscribed to document.* receives document.pushed for the create and the push', async () => {
    const { id } = await instantiate(templateId, { title: 'Evented' });
    await expectStatus(
      await send('PATCH', `/presentations/${id}/data`, 'owner', { title: 'Evented, pushed' }),
      200
    );
    const created = await waitFor('document.pushed (create)', () =>
      at('document.pushed').find((r) => r.body.data.deckId === id && r.body.data.source === 'create')
    );
    expect(created.body.workspaceId).toBe(workspaceId);
    expect(created.body.data).toEqual({
      deckId: id,
      version: 1,
      templateId,
      templateVersion: 1,
      source: 'create',
      changed: ['title'],
      authorUserId: userIds.owner
    });
    expect(created.body.subjects).toMatchObject({ deckId: id, projectIds: [] });
    const pushed = await waitFor('document.pushed (push)', () =>
      at('document.pushed').find((r) => r.body.data.deckId === id && r.body.data.source === 'push')
    );
    expect(pushed.body.data).toEqual({
      deckId: id,
      version: 2,
      templateId,
      templateVersion: 1,
      source: 'push',
      changed: ['title'],
      authorUserId: userIds.owner
    });
    // Only the document family reaches this endpoint.
    expect(received.filter((r) => r.url === '/documents' && !r.body.type.startsWith('document.'))).toEqual(
      []
    );
  });

  it('document.answered carries the link and the name it answered under', async () => {
    const { id } = await instantiate(templateId, { title: 'Answered event' }, { projectIds: [projectId] });
    const link = await mintLink(id, { name: 'romain', remembersResponses: true, canSubmitForms: true });
    const res = await submitAnswer(link.secret, 'merge_gate', {
      payload: { decision: 'no' },
      source: 'link'
    });
    expect(res.status).toBe(201);
    const responseId = (await readJson(res)).response.id;
    const hit = await waitFor('document.answered', () =>
      at('document.answered').find((r) => r.body.data.deckId === id)
    );
    expect(hit.body.data).toEqual({
      deckId: id,
      version: 2,
      formName: 'merge_gate',
      responseId,
      revision: 1,
      linkId: link.id,
      answeredBy: 'romain',
      changed: ['answers.merge_gate']
    });
    expect(hit.body.subjects).toMatchObject({ deckId: id, projectIds: [projectId], shareLinkId: link.id });
  });
});

describe('the audit', () => {
  it('lists document.create, document.data_push with its mode, document.upgrade and template.schema_set', async () => {
    const res = await send('GET', '/audit?action=document.,template.schema_set&limit=100', 'owner');
    const audit = await expectStatus(res, 200);
    const entries = audit.entries as { action: string; metadata: Record<string, unknown> | null }[];
    const actions = new Set(entries.map((e) => e.action));
    for (const action of [
      'document.create',
      'document.data_push',
      'document.upgrade',
      'template.schema_set'
    ]) {
      expect(actions, action).toContain(action);
    }
    const modes = new Set(
      entries.filter((e) => e.action === 'document.data_push').map((e) => e.metadata?.mode)
    );
    expect([...modes].sort()).toEqual(['merge', 'replace']);
    const create = entries.find((e) => e.action === 'document.create')!;
    expect(create.metadata).toMatchObject({ templateId });
  });
});
