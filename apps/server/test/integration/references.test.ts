import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * REFERENCES (ADR 025, PRDCT-2418) — a deck whose root `AGENT.md` opens with
 * a YAML frontmatter naming `type: Brand | Template`.
 *
 * The suite pins, through the HTTP API (the database is read only to count
 * rows and to find blob ids):
 *
 *   1. classification never refuses a push;
 *   2. the READ rule — the ADR 013 amendment: a `workspace` reference is every
 *      NON-GUEST member's to read, and nobody's to write but its writers';
 *   3. the files follow the reference (the SL-B1 surface carries the same rule);
 *   4. who may change the audience;
 *   5. the workspace default: one per type, admins only, race-safe;
 *   6. the list's `type` scope;
 *   7. the mirror moves with the version, and FAILS CLOSED;
 *   8. a duplicate of a reference is a private reference of the caller's;
 *   9. nothing crosses a workspace boundary;
 *  10. the existence-oracle posture on the two new PATCH fields.
 *
 * The cast, all in workspace 1 unless said otherwise:
 *   OWNER — the workspace owner;  ADMIN — a workspace admin;
 *   MIA   — a PLAIN member who owns most of the brands below;
 *   NOA   — a PLAIN member, the reader: she owns none of Mia's decks;
 *   GUEST — an `origin='guest'` principal minted by the collaborator claim path;
 *   DAN   — a plain member of 1 who founds workspace 2;  CY — a member of 2 ONLY.
 */

const OWNER = { email: 'owner@references.test', name: 'Ref Owner', password: 'ref-owner-password-1' };
const ADMIN = { email: 'admin@references.test', name: 'Ref Admin', password: 'ref-admin-password-11' };
const MIA = { email: 'mia@references.test', name: 'Mia Brandowner', password: 'ref-mia-password-111' };
const NOA = { email: 'noa@references.test', name: 'Noa Reader', password: 'ref-noa-password-1111' };
const GUEST = { email: 'guest@references.test', name: 'Gus Guest', password: 'ref-guest-password-11' };
const DAN = { email: 'dan@references.test', name: 'Dan Founder', password: 'ref-dan-password-1111' };
const CY = { email: 'cy@references.test', name: 'Cy Elsewhere', password: 'ref-cy-password-11111' };

const WS = 'x-workspace-id';

type Auth = Record<string, string>;
interface BundleFile {
  path: string;
  bytes: Buffer;
  contentType: string;
}
interface Wire {
  id: string;
  reference: { type: string } | null;
}

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileOf = (path: string, text: string, contentType: string): BundleFile => ({
  path,
  bytes: Buffer.from(text),
  contentType
});
const entryOf = (f: BundleFile) => ({
  path: f.path,
  sha256: shaOf(f.bytes),
  sizeBytes: f.bytes.length,
  contentType: f.contentType
});

/** The frontmatter every brand of this suite carries; `label` keeps each blob unique. */
const brandMd = (label: string, color = '#ff0000') =>
  `---\ntype: Brand\ntitle: ${label}\ncolors:\n  primary: "${color}"\n---\n# ${label}\n\nUse the logo on every slide.\n`;
const templateMd = (label: string) =>
  `---\ntype: Template\ntitle: ${label}\nslides: 12\n---\n# ${label}\n\nA template briefing.\n`;
const brandReference = (label: string, color = '#ff0000') => ({
  type: 'brand',
  title: label,
  colors: { primary: color }
});

const indexOf = (label: string) =>
  fileOf('index.html', `<!doctype html><html><body><h1>${label}</h1></body></html>`, 'text/html');
const logoOf = (label: string) =>
  fileOf(
    'logo.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><title>${label}</title><rect width="8" height="8"/></svg>`,
    'image/svg+xml'
  );
const agentOf = (text: string) => fileOf('AGENT.md', text, 'text/markdown');

/** index.html + logo.svg (+ AGENT.md when `agentMd` is given). Every byte carries the label. */
const bundleOf = (label: string, agentMd?: string): BundleFile[] => [
  indexOf(label),
  logoOf(label),
  ...(agentMd !== undefined ? [agentOf(agentMd)] : [])
];
const brandBundle = (label: string) => bundleOf(label, brandMd(label));
const templateBundle = (label: string) => bundleOf(label, templateMd(label));

let container: StartedPostgreSqlContainer;
let app: TestApp;
let w1 = '';
let ownerCookie = '';
let adminCookie = '';
let miaCookie = '';
let noaCookie = '';
let guestCookie = '';
let danCookie = '';
let noaReadKey = '';
let noaUserId = '';

// The invitation-accept and claim routes share a tight per-IP wall;
// TRUST_PROXY=true in tests, so every request brings its own address.
let ipCounter = 0;
const nextIp = () => `10.44.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Auth = {}, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});
const get = (path: string, auth: Auth) => app.app.request(`/api/v1${path}`, { headers: auth });
const patch = (id: string, body: unknown, auth: Auth) =>
  app.app.request(`/api/v1/presentations/${id}`, json(body, auth, 'PATCH'));
const del = (id: string, auth: Auth) =>
  app.app.request(`/api/v1/presentations/${id}`, { method: 'DELETE', headers: auth });

async function signIn(who: { email: string; password: string }): Promise<string> {
  const res = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: who.email, password: who.password })
  );
  expect(res.status).toBe(200);
  return extractCookie(res);
}

/** Join through an ordinary invitation (origin != guest). `inviter` decides the workspace. */
async function joinWorkspace(who: typeof MIA, role: 'member' | 'admin', inviter: Auth): Promise<string> {
  const invited = await app.app.request('/api/v1/invitations', json({ email: who.email, role }, inviter));
  expect(invited.status).toBe(201);
  const token = ((await readJson(invited)).acceptUrl as string).split('/invite/')[1];
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token, name: who.name, password: who.password })
  );
  expect(accept.status).toBe(200);
  return signIn(who);
}

async function uploadAsset(f: BundleFile, auth: Auth): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(f.bytes));
  form.set('file', new Blob([new Uint8Array(f.bytes)], { type: f.contentType }), f.path);
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: auth,
    body: form
  });
  expect(res.status).toBe(201);
}

/**
 * The deck-creation push protocol: upload, reserve, commit. `skipUpload`
 * names the paths whose bytes are deliberately NOT uploaded by the caller
 * (the commit then binds them only if the blob scope lets it).
 */
async function commitNewDeck(
  auth: Auth,
  title: string,
  files: BundleFile[],
  skipUpload: string[] = []
): Promise<{ res: Response; deckId: string }> {
  for (const f of files) if (!skipUpload.includes(f.path)) await uploadAsset(f, auth);
  const reserve = await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: auth });
  expect(reserve.status).toBe(201);
  const session = (await readJson(reserve)).uploadSession;
  const res = await app.app.request(
    `/api/v1/presentations/uploads/${session.id}/commit`,
    json({ title, entryPath: 'index.html', manifest: files.map(entryOf) }, auth)
  );
  return { res, deckId: session.presentationId as string };
}

/** A new deck that MUST commit: returns the 201 body. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function newDeck(auth: Auth, title: string, files: BundleFile[]): Promise<any> {
  const { res } = await commitNewDeck(auth, title, files);
  expect(res.status).toBe(201);
  return readJson(res);
}

/** A brand that MUST commit, returns its id. */
async function newBrand(auth: Auth, label: string): Promise<string> {
  const body = await newDeck(auth, label, brandBundle(label));
  expect(body.presentation.reference?.type).toBe('brand');
  return body.presentation.id as string;
}

async function commitVersion(
  auth: Auth,
  deckId: string,
  expectedBaseVersion: number,
  files: BundleFile[],
  upload = true
): Promise<Response> {
  if (upload) for (const f of files) await uploadAsset(f, auth);
  return app.app.request(
    `/api/v1/presentations/${deckId}/versions`,
    json({ expectedBaseVersion, entryPath: 'index.html', manifest: files.map(entryOf) }, auth)
  );
}

/** PATCH that MUST succeed; returns the updated presentation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function patchOk(id: string, body: unknown, auth: Auth): Promise<any> {
  const res = await patch(id, body, auth);
  expect(res.status).toBe(200);
  return readJson(res);
}
const publish = (id: string, auth: Auth) => patchOk(id, { audience: 'workspace' }, auth);

/** The whole listing, walked page by page. */
async function listAll(auth: Auth, query = '', limit = 100): Promise<Wire[]> {
  const out: Wire[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 500; page++) {
    const qs = [query, `limit=${limit}`, ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])]
      .filter(Boolean)
      .join('&');
    const res = await get(`/presentations?${qs}`, auth);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    out.push(...(body.presentations as Wire[]));
    cursor = body.nextCursor as string | null;
    if (!cursor) return out;
  }
  throw new Error('the cursor walk never ended');
}
const listIds = async (auth: Auth, query = '') => (await listAll(auth, query)).map((p) => p.id);

/** Every READ surface of one deck, as one snapshot of statuses. */
async function readStatuses(id: string, logoSha: string, auth: Auth) {
  const [deck, versions, version, asset, agentDoc] = await Promise.all([
    get(`/presentations/${id}`, auth),
    get(`/presentations/${id}/versions`, auth),
    get(`/presentations/${id}/versions/1`, auth),
    get(`/presentations/${id}/assets/${logoSha}`, auth),
    get(`/presentations/${id}/agent-doc`, auth)
  ]);
  return {
    deck: deck.status,
    versions: versions.status,
    version: version.status,
    asset: asset.status,
    agentDoc: agentDoc.status
  };
}
const ALL_200 = { deck: 200, versions: 200, version: 200, asset: 200, agentDoc: 200 };
const ALL_404 = { deck: 404, versions: 404, version: 404, asset: 404, agentDoc: 404 };

const fileIdOf = async (sha: string): Promise<string> => {
  const { rows } = await app.db.pool.query<{ id: string }>(
    'SELECT id FROM files WHERE sha256 = $1 AND workspace_id = $2',
    [sha, w1]
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
};

async function blobStatuses(fileId: string, auth: Auth) {
  const [meta, content, head] = await Promise.all([
    get(`/files/${fileId}`, auth),
    get(`/files/${fileId}/content`, auth),
    app.app.request(`/api/v1/files/${fileId}/content`, { method: 'HEAD', headers: auth })
  ]);
  return { meta: meta.status, content: content.status, head: head.status };
}
const BLOB_200 = { meta: 200, content: 200, head: 200 };
const BLOB_404 = { meta: 404, content: 404, head: 404 };

const listFileIds = async (auth: Auth): Promise<string[]> => {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const res = await get(`/files?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, auth);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    out.push(...(body.files as Array<{ id: string }>).map((f) => f.id));
    cursor = body.nextCursor as string | null;
    if (!cursor) return out;
  }
  throw new Error('the files cursor walk never ended');
};

const precheck = async (shas: string[], auth: Auth): Promise<string[]> => {
  const res = await app.app.request('/api/v1/presentations/precheck', json({ sha256: shas }, auth));
  expect(res.status).toBe(200);
  return (await readJson(res)).missing as string[];
};

/** Grant `who` an ACTIVE dev collaboration on a deck: the owner invites, the invitee claims with their session. */
async function grantDev(deckId: string, email: string, inviteeCookie: string): Promise<string> {
  const invited = await app.app.request(
    `/api/v1/presentations/${deckId}/collaborators`,
    json({ email }, { cookie: ownerCookie })
  );
  expect(invited.status).toBe(201);
  const body = await readJson(invited);
  const token = (body.claimUrl as string).split('/collab/')[1];
  const claim = await app.app.request(
    '/api/v1/collaborators/claim',
    json({ token }, { cookie: inviteeCookie })
  );
  expect(claim.status).toBe(200);
  return body.collaborator.id as string;
}

const defaultCount = async (type: string): Promise<number> => {
  const { rows } = await app.db.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM presentations
      WHERE workspace_id = $1 AND reference_type = $2 AND is_default_reference AND deleted_at IS NULL`,
    [w1, type]
  );
  return Number(rows[0]!.n);
};

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'refs'));
  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'References', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  w1 = (await readJson(setup)).workspaceId;
  ownerCookie = await signIn(OWNER);
  adminCookie = await joinWorkspace(ADMIN, 'admin', { cookie: ownerCookie });
  miaCookie = await joinWorkspace(MIA, 'member', { cookie: ownerCookie });
  noaCookie = await joinWorkspace(NOA, 'member', { cookie: ownerCookie });
  danCookie = await joinWorkspace(DAN, 'member', { cookie: ownerCookie });
  noaUserId = (await readJson(await get('/me', { cookie: noaCookie }))).user.id;

  const key = await app.app.request(
    '/api/v1/api-keys',
    json({ name: 'noa-ro', scopes: ['presentations:read'] }, { cookie: noaCookie })
  );
  expect(key.status).toBe(201);
  noaReadKey = (await readJson(key)).key;

  // The guest: invited to ONE ordinary deck of the owner, claimed through
  // the shipped oss journey (a local-password account, origin='guest').
  const host = await newDeck({ cookie: ownerCookie }, 'Guest host deck', bundleOf('guest-host'));
  const invited = await app.app.request(
    `/api/v1/presentations/${host.presentation.id}/collaborators`,
    json({ email: GUEST.email }, { cookie: ownerCookie })
  );
  expect(invited.status).toBe(201);
  const claimed = await app.app.request(
    '/api/v1/collaborators/claim',
    json({
      token: ((await readJson(invited)).claimUrl as string).split('/collab/')[1],
      name: GUEST.name,
      password: GUEST.password
    })
  );
  expect(claimed.status).toBe(200);
  guestCookie = await signIn(GUEST);
  expect((await readJson(await get('/me', { cookie: guestCookie }))).origin).toBe('guest');
}, 300_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ── 1 ────────────────────────────────────────────────────────────────────────

describe('1. classification never refuses a push', () => {
  const owner = () => ({ cookie: ownerCookie });

  /** The version detail must say later what the push answer said on the day. */
  async function expectDetailMatches(deckId: string, n: number, version: Record<string, unknown>) {
    const res = await get(`/presentations/${deckId}/versions/${n}`, owner());
    expect(res.status).toBe(200);
    const detail = await readJson(res);
    expect(detail.reference).toEqual(version.reference);
    expect(detail.referenceWarning).toEqual(version.referenceWarning);
  }

  it('a Brand frontmatter makes a private, non-default brand: the parsed object with a lowercase type, on the deck and on the version', async () => {
    const { res, deckId } = await commitNewDeck(owner(), 'C1 brand', brandBundle('c1-brand'));
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.presentation.reference).toEqual(brandReference('c1-brand'));
    expect(body.presentation.audience).toBe('private');
    expect(body.presentation.defaultReference).toBe(false);
    expect(body.version.reference).toEqual(brandReference('c1-brand'));
    expect(body.version.referenceWarning).toBeNull();
    await expectDetailMatches(deckId, 1, body.version);

    const read = await readJson(await get(`/presentations/${deckId}`, owner()));
    expect(read.reference).toEqual(brandReference('c1-brand'));
    expect(read.audience).toBe('private');
    expect(read.defaultReference).toBe(false);
  });

  it('the type is matched case-insensitively and stored lowercase (TEMPLATE → template)', async () => {
    const md = '---\ntype: TEMPLATE\ntitle: c1-upper\n---\n# briefing\n';
    const body = await newDeck(owner(), 'C1 upper', bundleOf('c1-upper', md));
    expect(body.presentation.reference).toEqual({ type: 'template', title: 'c1-upper' });
    expect(body.version.reference).toEqual({ type: 'template', title: 'c1-upper' });
    expect(body.version.referenceWarning).toBeNull();
  });

  it('the audience is an ACT, never a file: a frontmatter that names audience or a default publishes nothing', async () => {
    const md =
      '---\ntype: Brand\ntitle: c1-selfpublish\naudience: workspace\ndefaultReference: true\nisDefaultReference: true\n---\n# briefing\n';
    const body = await newDeck({ cookie: miaCookie }, 'C1 selfpublish', bundleOf('c1-selfpublish', md));
    expect(body.presentation.reference.type).toBe('brand');
    expect(body.presentation.audience).toBe('private');
    expect(body.presentation.defaultReference).toBe(false);
    const id = body.presentation.id as string;
    expect((await get(`/presentations/${id}`, { cookie: noaCookie })).status).toBe(404);
    expect(await listIds({ cookie: noaCookie }, 'type=brand')).not.toContain(id);
    expect(await listIds({ cookie: adminCookie }, 'type=brand&default=true')).not.toContain(id);
  });

  // A frontmatter the author visibly TRIED and the server could not use.
  const bigValue = 'x'.repeat(5000);
  const unusable: Array<[string, string]> = [
    ['an unknown type (Poster)', '---\ntype: Poster\ntitle: c1-poster\n---\n# briefing\n'],
    ['malformed YAML', '---\ntype: [Brand\ntitle: "c1-malformed\n---\n# briefing\n'],
    [
      'a frontmatter longer than 16 KB',
      `---\ntype: Brand\ntitle: c1-long\nnotes: "${'y'.repeat(20 * 1024)}"\n---\n# briefing\n`
    ],
    [
      'a short frontmatter whose aliases serialize over 16 KB',
      `---\ntype: Brand\ntitle: c1-alias\na: &big "${bigValue}"\nb: *big\nc: *big\nd: *big\n---\n# briefing\n`
    ]
  ];
  it.each(unusable)(
    '%s: the deck is committed as an ordinary deck, with a warning sentence',
    async (name, md) => {
      const label = `c1-unusable-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
      const { res, deckId } = await commitNewDeck(owner(), label, bundleOf(label, md));
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.presentation.reference).toBeNull();
      expect(body.presentation.audience).toBe('private');
      expect(body.presentation.defaultReference).toBe(false);
      expect(body.version.reference).toBeNull();
      expect(typeof body.version.referenceWarning).toBe('string');
      expect((body.version.referenceWarning as string).length).toBeGreaterThan(10);
      await expectDetailMatches(deckId, 1, body.version);
      // It is an ordinary deck for the list too.
      expect(await listIds(owner())).toContain(deckId);
      expect(await listIds(owner(), 'type=reference')).not.toContain(deckId);
    }
  );

  it('the alias-expanded frontmatter is refused for its SERIALIZED size, and says so', async () => {
    const md = `---\ntype: Brand\ntitle: c1-alias-2\na: &big "${bigValue}z"\nb: *big\nc: *big\nd: *big\n---\n# briefing\n`;
    expect(Buffer.byteLength(md)).toBeLessThan(16 * 1024);
    const body = await newDeck(owner(), 'C1 alias 2', bundleOf('c1-alias-2', md));
    expect(body.presentation.reference).toBeNull();
    expect(body.version.referenceWarning).toMatch(/too large/i);
  });

  const silent: Array<[string, string | undefined]> = [
    ['no AGENT.md at all', undefined],
    ['an AGENT.md with no frontmatter', '# Plain briefing\n\nRender page 1 first.\n'],
    ['a frontmatter with no type', '---\ntitle: just metadata\n---\n# briefing\n']
  ];
  it.each(silent)('%s: an ordinary deck and NO warning', async (name, md) => {
    const label = `c1-silent-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
    const { res, deckId } = await commitNewDeck(owner(), label, bundleOf(label, md));
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.presentation.reference).toBeNull();
    expect(body.version.reference).toBeNull();
    expect(body.version.referenceWarning).toBeNull();
    await expectDetailMatches(deckId, 1, body.version);
  });

  it('a NEW VERSION is classified the same way: an ordinary deck becomes a brand, and an unusable one never refuses the commit', async () => {
    const created = await newDeck(owner(), 'C1 versions', bundleOf('c1-versions'));
    const id = created.presentation.id as string;

    const v2 = await commitVersion(owner(), id, 1, brandBundle('c1-versions-v2'));
    expect(v2.status).toBe(201);
    const b2 = await readJson(v2);
    expect(b2.presentation.reference).toEqual(brandReference('c1-versions-v2'));
    expect(b2.presentation.audience).toBe('private');
    expect(b2.presentation.defaultReference).toBe(false);
    expect(b2.version.reference).toEqual(brandReference('c1-versions-v2'));
    expect(b2.version.referenceWarning).toBeNull();
    await expectDetailMatches(id, 2, b2.version);

    const poster = bundleOf('c1-versions-v3', '---\ntype: Poster\n---\n# briefing\n');
    const v3 = await commitVersion(owner(), id, 2, poster);
    expect(v3.status).toBe(201);
    const b3 = await readJson(v3);
    expect(b3.presentation.reference).toBeNull();
    expect(b3.version.reference).toBeNull();
    expect(typeof b3.version.referenceWarning).toBe('string');
    await expectDetailMatches(id, 3, b3.version);
  });
});

// ── 2 ────────────────────────────────────────────────────────────────────────

describe('2. the read rule (the ADR 013 amendment)', () => {
  let wsBrand = '';
  let privateBrand = '';
  let ordinaryDeck = '';
  const wsLogo = shaOf(logoOf('r2-ws-brand').bytes);
  const privateLogo = shaOf(logoOf('r2-private-brand').bytes);
  const ordinaryLogo = shaOf(logoOf('r2-ordinary').bytes);

  beforeAll(async () => {
    wsBrand = await newBrand({ cookie: miaCookie }, 'r2-ws-brand');
    await publish(wsBrand, { cookie: miaCookie });
    privateBrand = await newBrand({ cookie: miaCookie }, 'r2-private-brand');
    ordinaryDeck = (
      await newDeck({ cookie: miaCookie }, 'r2-ordinary', bundleOf('r2-ordinary', '# no frontmatter\n'))
    ).presentation.id;
  }, 120_000);

  it('a plain member reads a workspace brand of someone else on every read surface', async () => {
    expect(await readStatuses(wsBrand, wsLogo, { cookie: noaCookie })).toEqual(ALL_200);

    const deck = await readJson(await get(`/presentations/${wsBrand}`, { cookie: noaCookie }));
    expect(deck.reference).toEqual(brandReference('r2-ws-brand'));
    expect(deck.audience).toBe('workspace');
    expect(deck.ownerUserId).not.toBe(noaUserId);

    const logo = await get(`/presentations/${wsBrand}/assets/${wsLogo}`, { cookie: noaCookie });
    expect(Buffer.from(await logo.arrayBuffer()).equals(logoOf('r2-ws-brand').bytes)).toBe(true);
    const doc = await get(`/presentations/${wsBrand}/agent-doc`, { cookie: noaCookie });
    expect(await doc.text()).toBe(brandMd('r2-ws-brand'));
  });

  it('that member cannot WRITE it: a version commit answers 404, PATCH title 403, DELETE 403, and nothing moved', async () => {
    const commit = await commitVersion({ cookie: noaCookie }, wsBrand, 1, bundleOf('r2-noa-intrusion'));
    expect(commit.status).toBe(404);

    const retitle = await patch(wsBrand, { title: 'Noa was here' }, { cookie: noaCookie });
    expect(retitle.status).toBe(403);
    const meta = await patch(wsBrand, { metadata: { noa: true } }, { cookie: noaCookie });
    expect(meta.status).toBe(403);

    const remove = await del(wsBrand, { cookie: noaCookie });
    expect(remove.status).toBe(403);

    const after = await readJson(await get(`/presentations/${wsBrand}`, { cookie: miaCookie }));
    expect(after.title).toBe('r2-ws-brand');
    expect(after.currentVersion).toBe(1);
    expect(after.metadata?.noa).toBeUndefined();
  });

  it('that member cannot mint a share link on it (not 2xx), and reads none of its sharing surface', async () => {
    const token = await app.app.request(
      `/api/v1/presentations/${wsBrand}/tokens`,
      json({ name: 'Noa link' }, { cookie: noaCookie })
    );
    expect([403, 404]).toContain(token.status);
    const preview = await app.app.request(
      `/api/v1/presentations/${wsBrand}/preview-token`,
      json({}, { cookie: noaCookie })
    );
    expect([403, 404]).toContain(preview.status);
    const listed = await get(`/presentations/${wsBrand}/tokens`, { cookie: noaCookie });
    expect([403, 404]).toContain(listed.status);

    const { rows } = await app.db.pool.query('SELECT 1 FROM share_tokens WHERE presentation_id = $1', [
      wsBrand
    ]);
    expect(rows).toHaveLength(0);
  });

  it('reading the brand opens none of its WRITER surfaces: roster, annotations and responses stay 404, inviting answers 403', async () => {
    const noa = { cookie: noaCookie };
    for (const path of ['collaborators', 'annotations', 'responses']) {
      expect((await get(`/presentations/${wsBrand}/${path}`, noa)).status, path).toBe(404);
    }
    const invite = await app.app.request(
      `/api/v1/presentations/${wsBrand}/collaborators`,
      json({ email: DAN.email }, noa)
    );
    expect(invite.status).toBe(403);
    const note = await app.app.request(
      `/api/v1/presentations/${wsBrand}/annotations`,
      json({ version: 1, selection: { page: 1 }, body: 'a reader note' }, noa)
    );
    expect(note.status).toBe(404);
  });

  it('the same member gets 404 — never 403 — on a PRIVATE brand and on an ORDINARY deck of another member', async () => {
    expect(await readStatuses(privateBrand, privateLogo, { cookie: noaCookie })).toEqual(ALL_404);
    // The ordinary deck carries an AGENT.md too, so agent-doc would be 200 for a reader.
    expect(await readStatuses(ordinaryDeck, ordinaryLogo, { cookie: noaCookie })).toEqual(ALL_404);
    expect(await readStatuses(ordinaryDeck, ordinaryLogo, { cookie: miaCookie })).toEqual(ALL_200);
  });

  it('an ordinary deck can never be opened: PATCH audience answers 422 not_a_reference for its owner and for an admin', async () => {
    for (const cookie of [miaCookie, adminCookie, ownerCookie]) {
      const res = await patch(ordinaryDeck, { audience: 'workspace' }, { cookie });
      expect(res.status).toBe(422);
      expect((await readJson(res)).error.code).toBe('not_a_reference');
    }
    const asDefault = await patch(ordinaryDeck, { defaultReference: true }, { cookie: adminCookie });
    expect(asDefault.status).toBe(422);
    expect((await readJson(asDefault)).error.code).toBe('not_a_reference');

    const { rows } = await app.db.pool.query<{ audience: string }>(
      'SELECT audience FROM presentations WHERE id = $1',
      [ordinaryDeck]
    );
    expect(rows[0]!.audience).toBe('private');
    expect((await get(`/presentations/${ordinaryDeck}`, { cookie: noaCookie })).status).toBe(404);
  });

  it('the TYPE clause is load-bearing: an ordinary deck whose audience column were forced to workspace stays closed', async () => {
    const forced = await newDeck({ cookie: miaCookie }, 'r2-forced', bundleOf('r2-forced', '# plain\n'));
    const id = forced.presentation.id as string;
    await app.db.pool.query(`UPDATE presentations SET audience = 'workspace' WHERE id = $1`, [id]);
    try {
      const logo = shaOf(logoOf('r2-forced').bytes);
      expect(await readStatuses(id, logo, { cookie: noaCookie })).toEqual(ALL_404);
      expect(await listIds({ cookie: noaCookie })).not.toContain(id);
      expect(await listIds({ cookie: noaCookie }, 'type=reference')).not.toContain(id);
      expect(await blobStatuses(await fileIdOf(logo), { cookie: noaCookie })).toEqual(BLOB_404);
      expect(await precheck([logo], { cookie: noaCookie })).toEqual([logo]);
    } finally {
      await app.db.pool.query(`UPDATE presentations SET audience = 'private' WHERE id = $1`, [id]);
    }
  });

  it("a read-scoped API key of the plain member follows the member's rule: the workspace brand reads, the private one is 404", async () => {
    const key = { authorization: `Bearer ${noaReadKey}` };
    expect(await readStatuses(wsBrand, wsLogo, key)).toEqual(ALL_200);
    expect(await readStatuses(privateBrand, privateLogo, key)).toEqual(ALL_404);
    const ids = await listIds(key, 'type=brand');
    expect(ids).toContain(wsBrand);
    expect(ids).not.toContain(privateBrand);
    // Read scope is not a write scope, and the key is no wider than the session.
    const retitle = await patch(wsBrand, { title: 'via key' }, key);
    expect([403, 404]).toContain(retitle.status);
  });

  it('a GUEST gets 404 on the workspace brand, and it is absent from every list the guest can ask for', async () => {
    const guest = { cookie: guestCookie };
    expect(await readStatuses(wsBrand, wsLogo, guest)).toEqual(ALL_404);
    for (const query of ['', 'type=brand', 'type=reference', 'type=brand&default=true', 'default=true']) {
      expect(await listIds(guest, query)).not.toContain(wsBrand);
    }
    const dup = await app.app.request(`/api/v1/presentations/${wsBrand}/duplicate`, json({}, guest));
    expect(dup.status).toBe(403);
  });

  it('a guest who holds an ACTIVE grant on the brand itself still reads it (the per-deck grant is untouched)', async () => {
    const guest = { cookie: guestCookie };
    const grantId = await grantDev(wsBrand, GUEST.email, guestCookie);
    expect(await readStatuses(wsBrand, wsLogo, guest)).toEqual(ALL_200);
    expect(await listIds(guest, 'type=brand')).toContain(wsBrand);
    // …and only that one: another published brand stays invisible to the guest.
    const other = await newBrand({ cookie: miaCookie }, 'r2-other-ws-brand');
    await publish(other, { cookie: miaCookie });
    expect((await get(`/presentations/${other}`, guest)).status).toBe(404);
    expect(await listIds(guest, 'type=brand')).not.toContain(other);
    expect((await get(`/presentations/${other}`, { cookie: noaCookie })).status).toBe(200);

    // Revoking the grant cuts the guest off at once: the workspace audience
    // never stands in for it (a revoked grant on a PUBLISHED brand is the
    // case where a fallback to the workspace rule would hide a leak).
    const revoke = await app.app.request(`/api/v1/presentations/${wsBrand}/collaborators/${grantId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie }
    });
    expect(revoke.status).toBe(200);
    expect(await readStatuses(wsBrand, wsLogo, guest)).toEqual(ALL_404);
    expect(await listIds(guest, 'type=brand')).not.toContain(wsBrand);
    expect(await precheck([wsLogo], guest)).toEqual([wsLogo]);
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────

describe('3. the files follow the reference', () => {
  let wsBrand = '';
  const ws = brandBundle('f3-ws-brand');
  const priv = brandBundle('f3-private-brand');
  const ordinary = bundleOf('f3-ordinary');
  const shas = (files: BundleFile[]) => files.map((f) => shaOf(f.bytes));
  const [wsIndexSha, wsLogoSha] = shas(ws) as [string, string, string];
  const privLogoSha = shas(priv)[1]!;
  const noa = () => ({ cookie: noaCookie });

  beforeAll(async () => {
    wsBrand = (await newDeck({ cookie: ownerCookie }, 'f3-ws-brand', ws)).presentation.id;
    await publish(wsBrand, { cookie: ownerCookie });
    await newDeck({ cookie: ownerCookie }, 'f3-private-brand', priv);
    await newDeck({ cookie: ownerCookie }, 'f3-ordinary', ordinary);
  }, 120_000);

  it('the plain member lists and reads the blobs of the workspace brand on /files, bytes included', async () => {
    const listed = await listFileIds(noa());
    for (const f of ws) {
      const id = await fileIdOf(shaOf(f.bytes));
      expect(listed).toContain(id);
      expect(await blobStatuses(id, noa())).toEqual(BLOB_200);
      const content = await get(`/files/${id}/content`, noa());
      expect(Buffer.from(await content.arrayBuffer()).equals(f.bytes)).toBe(true);
    }
    // The member's read-scoped key is exactly as wide.
    const key = { authorization: `Bearer ${noaReadKey}` };
    expect(await blobStatuses(await fileIdOf(wsLogoSha), key)).toEqual(BLOB_200);
  });

  it('the blobs of a PRIVATE brand and of an ordinary deck stay 404 and out of the listing', async () => {
    const listed = await listFileIds(noa());
    for (const f of [...priv, ...ordinary]) {
      const id = await fileIdOf(shaOf(f.bytes));
      expect(listed).not.toContain(id);
      expect(await blobStatuses(id, noa())).toEqual(BLOB_404);
      expect(await blobStatuses(id, { authorization: `Bearer ${noaReadKey}` })).toEqual(BLOB_404);
    }
  });

  it("a guest reads none of it: /files stays refused, and precheck answers the brand's logo as missing", async () => {
    const guest = { cookie: guestCookie };
    expect((await get('/files', guest)).status).toBe(403);
    expect((await get(`/files/${await fileIdOf(wsLogoSha)}/content`, guest)).status).toBe(403);
    expect(await precheck([wsLogoSha], guest)).toEqual([wsLogoSha]);
  });

  it("precheck answers the workspace brand's logo as present and a private brand's as missing", async () => {
    expect(await precheck([wsLogoSha, privLogoSha], noa())).toEqual([privLogoSha]);
    expect(await precheck([wsIndexSha], noa())).toEqual([]);
  });

  it("the member commits a deck of their own naming the workspace brand's logo WITHOUT uploading it: 201", async () => {
    const mine = [indexOf('f3-noa-own-deck'), ws[1]!];
    const { res, deckId } = await commitNewDeck(noa(), 'f3-noa-own-deck', mine, ['logo.svg']);
    expect(res.status).toBe(201);
    const asset = await get(`/presentations/${deckId}/assets/${wsLogoSha}`, noa());
    expect(asset.status).toBe(200);
    expect(Buffer.from(await asset.arrayBuffer()).equals(ws[1]!.bytes)).toBe(true);
  });

  it("the same commit naming a PRIVATE brand's logo is refused 400 missing_blobs and creates nothing", async () => {
    const stolen = [indexOf('f3-noa-stolen-deck'), priv[1]!];
    const { res, deckId } = await commitNewDeck(noa(), 'f3-noa-stolen-deck', stolen, ['logo.svg']);
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('missing_blobs');
    expect(body.error.details.missing).toEqual([privLogoSha]);
    const { rowCount } = await app.db.pool.query('SELECT 1 FROM presentations WHERE id = $1', [deckId]);
    expect(rowCount).toBe(0);
  });

  it("reading a brand's blob is not deleting it: DELETE /files answers 409 file_in_use and the bytes stay", async () => {
    const logoId = await fileIdOf(wsLogoSha);
    const res = await app.app.request(`/api/v1/files/${logoId}`, { method: 'DELETE', headers: noa() });
    expect(res.status).toBe(409);
    expect((await readJson(res)).error.code).toBe('file_in_use');
    const { rows } = await app.db.pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM files WHERE id = $1',
      [logoId]
    );
    expect(rows[0]!.deleted_at).toBeNull();
    const still = await get(`/presentations/${wsBrand}/assets/${wsLogoSha}`, { cookie: ownerCookie });
    expect(still.status).toBe(200);
  });

  it('a soft-deleted workspace brand stops conferring its bytes, like it stops resolving', async () => {
    const files = brandBundle('f3-deleted-brand');
    const id = (await newDeck({ cookie: miaCookie }, 'f3-deleted-brand', files)).presentation.id as string;
    await publish(id, { cookie: miaCookie });
    const logo = shaOf(files[1]!.bytes);
    const logoId = await fileIdOf(logo);
    expect(await blobStatuses(logoId, noa())).toEqual(BLOB_200);

    expect((await del(id, { cookie: miaCookie })).status).toBeLessThan(300);
    expect(await readStatuses(id, logo, noa())).toEqual(ALL_404);
    expect(await blobStatuses(logoId, noa())).toEqual(BLOB_404);
    expect(await precheck([logo], noa())).toEqual([logo]);
    expect(await listIds(noa(), 'type=brand')).not.toContain(id);
  });

  it('revocation is immediate: back to private, the brand is 404 and a sha only the brand holds is missing again', async () => {
    const indexId = await fileIdOf(wsIndexSha);
    expect(await precheck([wsIndexSha], noa())).toEqual([]);
    expect(await blobStatuses(indexId, noa())).toEqual(BLOB_200);

    await patchOk(wsBrand, { audience: 'private' }, { cookie: ownerCookie });

    expect(await readStatuses(wsBrand, wsLogoSha, noa())).toEqual(ALL_404);
    expect(await precheck([wsIndexSha], noa())).toEqual([wsIndexSha]);
    expect(await blobStatuses(indexId, noa())).toEqual(BLOB_404);
    expect(await listFileIds(noa())).not.toContain(indexId);
    expect(await listIds(noa(), 'type=brand')).not.toContain(wsBrand);

    // A new commit can no longer bind the brand's own bytes…
    const late = [indexOf('f3-noa-late-deck'), ws[2]!];
    const { res } = await commitNewDeck(noa(), 'f3-noa-late-deck', late, ['AGENT.md']);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('missing_blobs');
    // …while the logo the member bound into a deck of THEIR OWN beforehand
    // stays theirs to read: it is now content of a deck they own.
    expect(await precheck([wsLogoSha], noa())).toEqual([]);
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────

describe('4. who may change the audience', () => {
  it('the deck owner — a PLAIN member — publishes and unpublishes their own brand', async () => {
    const id = await newBrand({ cookie: miaCookie }, 'a4-mia-own');
    expect((await publish(id, { cookie: miaCookie })).audience).toBe('workspace');
    expect((await get(`/presentations/${id}`, { cookie: noaCookie })).status).toBe(200);
    expect((await patchOk(id, { audience: 'private' }, { cookie: miaCookie })).audience).toBe('private');
    expect((await get(`/presentations/${id}`, { cookie: noaCookie })).status).toBe(404);
  });

  it("a workspace admin and the workspace owner publish a member's brand", async () => {
    const id = await newBrand({ cookie: miaCookie }, 'a4-by-admins');
    expect((await publish(id, { cookie: adminCookie })).audience).toBe('workspace');
    expect((await patchOk(id, { audience: 'private' }, { cookie: ownerCookie })).audience).toBe('private');
    expect((await publish(id, { cookie: ownerCookie })).audience).toBe('workspace');
  });

  it('a member who merely READS the published brand gets 403, and the audience did not move', async () => {
    const id = await newBrand({ cookie: miaCookie }, 'a4-reader');
    await publish(id, { cookie: miaCookie });
    for (const body of [{ audience: 'private' }, { audience: 'workspace' }]) {
      const res = await patch(id, body, { cookie: noaCookie });
      expect(res.status).toBe(403);
    }
    expect((await readJson(await get(`/presentations/${id}`, { cookie: miaCookie }))).audience).toBe(
      'workspace'
    );
  });

  it('someone who cannot read the brand gets 404; once granted as a DEV collaborator they get 403 — and still write the title', async () => {
    const id = await newBrand({ cookie: miaCookie }, 'a4-dev');
    const blind = await patch(id, { audience: 'workspace' }, { cookie: noaCookie });
    expect(blind.status).toBe(404);

    await grantDev(id, NOA.email, noaCookie);
    const dev = await patch(id, { audience: 'workspace' }, { cookie: noaCookie });
    expect(dev.status).toBe(403);
    // A mixed body is refused as a whole: the title must not move either.
    const mixed = await patch(id, { title: 'smuggled', audience: 'workspace' }, { cookie: noaCookie });
    expect(mixed.status).toBe(403);
    const after = await readJson(await get(`/presentations/${id}`, { cookie: miaCookie }));
    expect(after.audience).toBe('private');
    expect(after.title).toBe('a4-dev');
    // The collaborator IS a writer of the plain properties.
    expect((await patchOk(id, { title: 'a4-dev retitled' }, { cookie: noaCookie })).title).toBe(
      'a4-dev retitled'
    );
  });

  it('a GUEST dev collaborator on a private brand cannot publish it to the workspace either', async () => {
    const id = await newBrand({ cookie: miaCookie }, 'a4-guest-dev');
    await grantDev(id, GUEST.email, guestCookie);
    expect((await get(`/presentations/${id}`, { cookie: guestCookie })).status).toBe(200);
    const res = await patch(id, { audience: 'workspace' }, { cookie: guestCookie });
    expect(res.status).toBe(403);
    expect((await readJson(await get(`/presentations/${id}`, { cookie: miaCookie }))).audience).toBe(
      'private'
    );
  });

  it('on an ordinary deck the audience answers 422 not_a_reference, for its owner too', async () => {
    const id = (await newDeck({ cookie: miaCookie }, 'a4-ordinary', bundleOf('a4-ordinary'))).presentation
      .id as string;
    const res = await patch(id, { audience: 'workspace' }, { cookie: miaCookie });
    expect(res.status).toBe(422);
    expect((await readJson(res)).error.code).toBe('not_a_reference');
  });

  it('an unknown audience value is a 400', async () => {
    const id = await newBrand({ cookie: miaCookie }, 'a4-bad-value');
    const res = await patch(id, { audience: 'everyone' }, { cookie: miaCookie });
    expect(res.status).toBe(400);
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────

describe('5. the workspace default: one per type, admins only', () => {
  let first = '';
  let second = '';
  let template = '';
  const admin = () => ({ cookie: adminCookie });
  const defaults = (type: string) => listIds(admin(), `type=${type}&default=true`);

  beforeAll(async () => {
    first = await newBrand({ cookie: miaCookie }, 'd5-first');
    second = await newBrand({ cookie: miaCookie }, 'd5-second');
    template = (await newDeck({ cookie: miaCookie }, 'd5-template', templateBundle('d5-template')))
      .presentation.id;
    await publish(first, { cookie: miaCookie });
  }, 120_000);

  it("the brand's own plain-member owner gets 403: the default is a WORKSPACE decision", async () => {
    for (const body of [{ defaultReference: true }, { defaultReference: false }]) {
      const res = await patch(first, body, { cookie: miaCookie });
      expect(res.status).toBe(403);
    }
    expect(await defaults('brand')).not.toContain(first);
  });

  it('on a PRIVATE reference the default answers 409 audience_private', async () => {
    const res = await patch(second, { defaultReference: true }, admin());
    expect(res.status).toBe(409);
    expect((await readJson(res)).error.code).toBe('audience_private');
    expect((await readJson(await get(`/presentations/${second}`, admin()))).defaultReference).toBe(false);
  });

  it('{audience: workspace, defaultReference: true} in ONE call by an admin succeeds', async () => {
    const updated = await patchOk(second, { audience: 'workspace', defaultReference: true }, admin());
    expect(updated.audience).toBe('workspace');
    expect(updated.defaultReference).toBe(true);
    expect(await defaults('brand')).toEqual([second]);
  });

  it('setting a second brand as default clears the first in the same call', async () => {
    const updated = await patchOk(first, { defaultReference: true }, { cookie: ownerCookie });
    expect(updated.defaultReference).toBe(true);
    expect(await defaults('brand')).toEqual([first]);
    expect((await readJson(await get(`/presentations/${second}`, admin()))).defaultReference).toBe(false);
    // The cleared one keeps its audience: it is still a workspace brand.
    expect((await readJson(await get(`/presentations/${second}`, admin()))).audience).toBe('workspace');
    expect(await defaultCount('brand')).toBe(1);
  });

  it('a default template and a default brand coexist: one per TYPE', async () => {
    await patchOk(template, { audience: 'workspace', defaultReference: true }, admin());
    expect(await defaults('template')).toEqual([template]);
    expect(await defaults('brand')).toEqual([first]);
    // `default=true` without a type implies every reference.
    expect((await listIds(admin(), 'default=true')).sort()).toEqual([first, template].sort());
    // A plain member asks the same question and gets the same answer.
    expect(await listIds({ cookie: noaCookie }, 'type=brand&default=true')).toEqual([first]);
  });

  it('switching the default back to private answers 409 default_reference; clearing both in one call succeeds', async () => {
    for (const cookie of [miaCookie, adminCookie]) {
      const res = await patch(first, { audience: 'private' }, { cookie });
      expect(res.status).toBe(409);
      expect((await readJson(res)).error.code).toBe('default_reference');
    }
    // A refusal applies NOTHING of the body: the title rides along and must not move.
    const mixed = await patch(first, { title: 'renamed by a refused call', audience: 'private' }, admin());
    expect(mixed.status).toBe(409);
    const still = await readJson(await get(`/presentations/${first}`, admin()));
    expect(still.audience).toBe('workspace');
    expect(still.defaultReference).toBe(true);
    expect(still.title).toBe('d5-first');

    const cleared = await patchOk(first, { audience: 'private', defaultReference: false }, admin());
    expect(cleared.audience).toBe('private');
    expect(cleared.defaultReference).toBe(false);
    expect(await defaults('brand')).toEqual([]);
    expect((await get(`/presentations/${first}`, { cookie: noaCookie })).status).toBe(404);
  });

  it('soft-deleting the default brand frees the slot: the list is empty and another brand becomes the default', async () => {
    await patchOk(second, { defaultReference: true }, admin());
    expect(await defaults('brand')).toEqual([second]);

    const removed = await del(second, admin());
    expect(removed.status).toBeGreaterThanOrEqual(200);
    expect(removed.status).toBeLessThan(300);
    // The delete DROPS the default on the row itself (verifier round 1,
    // finding 1): the answer says so, and the deleted row does not keep a
    // stale flag for a restore path to resurrect one day.
    expect((await readJson(removed)).defaultReference).toBe(false);
    const { rows: deletedRow } = await app.db.pool.query<{ is_default_reference: boolean }>(
      'SELECT is_default_reference FROM presentations WHERE id = $1',
      [second]
    );
    expect(deletedRow[0]?.is_default_reference).toBe(false);
    expect(await defaults('brand')).toEqual([]);
    expect(await defaultCount('brand')).toBe(0);

    await patchOk(first, { audience: 'workspace', defaultReference: true }, admin());
    expect(await defaults('brand')).toEqual([first]);
    expect(await defaultCount('brand')).toBe(1);
  });

  it('the one-default index is the backstop, and it ignores deleted rows (verifier round 1, finding 2)', async () => {
    // The index as migration 0044 created it, read back from the catalogue.
    const { rows: index } = await app.db.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'presentations_default_reference_uniq'`
    );
    expect(index).toHaveLength(1);
    expect(index[0]!.indexdef).toMatch(/UNIQUE/);
    expect(index[0]!.indexdef).toMatch(/WHERE \(is_default_reference AND \(deleted_at IS NULL\)\)/);

    // Two live defaults of one type in one workspace are refused by Postgres
    // itself, whatever path tried to write them...
    const other = await newBrand({ cookie: miaCookie }, 'd5-index-other');
    await publish(other, { cookie: miaCookie });
    expect(await defaults('brand')).toEqual([first]);
    await expect(
      app.db.pool.query('UPDATE presentations SET is_default_reference = true WHERE id = $1', [other])
    ).rejects.toMatchObject({ code: '23505' });
    // ...while a deleted row never holds the slot: flag the deleted brand by
    // hand, and the live default still stands beside it.
    await app.db.pool.query('UPDATE presentations SET is_default_reference = true WHERE id = $1', [second]);
    expect(await defaults('brand')).toEqual([first]);
    await app.db.pool.query('UPDATE presentations SET is_default_reference = false WHERE id = $1', [second]);
  });

  it('two concurrent sets on two different brands never leave two defaults, and never a 500', async () => {
    const left = await newBrand({ cookie: miaCookie }, 'd5-race-left');
    const right = await newBrand({ cookie: miaCookie }, 'd5-race-right');
    await publish(left, { cookie: miaCookie });
    await publish(right, { cookie: miaCookie });

    for (let round = 0; round < 10; round++) {
      const pair = round % 2 === 0 ? [left, right] : [right, left];
      // Every third round starts from NO default at all, the other shape of the race.
      if (round % 3 === 0) {
        for (const id of pair) await patchOk(id, { defaultReference: false }, admin());
      }
      const answers = await Promise.all([
        patch(pair[0]!, { defaultReference: true }, { cookie: adminCookie }),
        patch(pair[1]!, { defaultReference: true }, { cookie: ownerCookie })
      ]);
      const statuses = answers.map((r) => r.status);
      const context = `round ${round}: ${JSON.stringify(statuses)}`;
      for (const status of statuses) expect(status, context).toBeLessThan(500);
      expect(statuses.filter((s) => s === 200).length, context).toBeGreaterThanOrEqual(1);

      const listed = await defaults('brand');
      expect(listed, context).toHaveLength(1);
      expect(pair, context).toContain(listed[0]);
      expect(await defaultCount('brand'), context).toBe(1);
      // The two deck reads agree with the list: exactly one says true.
      const flags = await Promise.all(
        pair.map(async (id) => (await readJson(await get(`/presentations/${id}`, admin()))).defaultReference)
      );
      expect(flags.filter(Boolean), context).toHaveLength(1);
    }
  }, 120_000);

  it('the same holds with three brands set at once while a fourth is the standing default', async () => {
    const mia = { cookie: miaCookie };
    const brands: string[] = [];
    for (const label of ['d5-race3-a', 'd5-race3-b', 'd5-race3-c', 'd5-race3-standing']) {
      const id = await newBrand(mia, label);
      await publish(id, mia);
      brands.push(id);
    }
    const standing = brands[3]!;
    for (let round = 0; round < 5; round++) {
      await patchOk(standing, { defaultReference: true }, admin());
      const answers = await Promise.all(
        brands
          .slice(0, 3)
          .map((id, i) =>
            patch(id, { defaultReference: true }, { cookie: i % 2 === 0 ? adminCookie : ownerCookie })
          )
      );
      const statuses = answers.map((r) => r.status);
      const context = `round ${round}: ${JSON.stringify(statuses)}`;
      for (const status of statuses) expect(status, context).toBeLessThan(500);
      const listed = await defaults('brand');
      expect(listed, context).toHaveLength(1);
      expect(brands.slice(0, 3), context).toContain(listed[0]);
      expect(await defaultCount('brand'), context).toBe(1);
    }
  }, 120_000);
});

// ── 6 ────────────────────────────────────────────────────────────────────────

describe('6. the list', () => {
  const ids = {
    miaPrivBrand: '',
    miaPubBrand: '',
    miaPrivTemplate: '',
    miaOrdinary: '',
    ownPrivBrand: '',
    ownPubBrand: '',
    ownPubTemplate: '',
    ownOrdinary: '',
    noaPrivBrand: '',
    noaOrdinary: ''
  };
  const noa = () => ({ cookie: noaCookie });

  beforeAll(async () => {
    const mia = { cookie: miaCookie };
    const own = { cookie: ownerCookie };
    ids.miaPrivBrand = await newBrand(mia, 'l6-mia-priv-brand');
    ids.miaPubBrand = await newBrand(mia, 'l6-mia-pub-brand');
    await publish(ids.miaPubBrand, mia);
    ids.miaPrivTemplate = (
      await newDeck(mia, 'l6-mia-priv-tpl', templateBundle('l6-mia-priv-tpl'))
    ).presentation.id;
    ids.miaOrdinary = (await newDeck(mia, 'l6-mia-ordinary', bundleOf('l6-mia-ordinary'))).presentation.id;
    ids.ownPrivBrand = await newBrand(own, 'l6-own-priv-brand');
    ids.ownPubBrand = await newBrand(own, 'l6-own-pub-brand');
    await publish(ids.ownPubBrand, own);
    ids.ownPubTemplate = (
      await newDeck(own, 'l6-own-pub-tpl', templateBundle('l6-own-pub-tpl'))
    ).presentation.id;
    await publish(ids.ownPubTemplate, own);
    ids.ownOrdinary = (await newDeck(own, 'l6-own-ordinary', bundleOf('l6-own-ordinary'))).presentation.id;
    ids.noaPrivBrand = await newBrand(noa(), 'l6-noa-priv-brand');
    ids.noaOrdinary = (await newDeck(noa(), 'l6-noa-ordinary', bundleOf('l6-noa-ordinary'))).presentation.id;
  }, 180_000);

  it('with no type, ordinary decks only — for the owner, an admin and a member alike', async () => {
    for (const cookie of [ownerCookie, adminCookie, miaCookie, noaCookie]) {
      const listed = await listAll({ cookie });
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.filter((p) => p.reference !== null)).toEqual([]);
    }
    const admins = await listIds({ cookie: adminCookie });
    expect(admins).toEqual(expect.arrayContaining([ids.miaOrdinary, ids.ownOrdinary, ids.noaOrdinary]));
    const members = await listIds(noa());
    expect(members).toContain(ids.noaOrdinary);
    expect(members).not.toContain(ids.miaOrdinary);
    expect(members).not.toContain(ids.ownOrdinary);
    // A published reference does not leak into the ordinary listing either.
    expect(members).not.toContain(ids.miaPubBrand);
  });

  it('type=brand lists brands only; type=template templates only; type=reference both', async () => {
    const admin = { cookie: adminCookie };
    const brands = await listAll(admin, 'type=brand');
    expect(brands.every((p) => p.reference?.type === 'brand')).toBe(true);
    expect(brands.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        ids.miaPrivBrand,
        ids.miaPubBrand,
        ids.ownPrivBrand,
        ids.ownPubBrand,
        ids.noaPrivBrand
      ])
    );

    const templates = await listAll(admin, 'type=template');
    expect(templates.every((p) => p.reference?.type === 'template')).toBe(true);
    expect(templates.map((p) => p.id)).toEqual(
      expect.arrayContaining([ids.miaPrivTemplate, ids.ownPubTemplate])
    );

    const references = await listAll(admin, 'type=reference');
    expect(references.every((p) => p.reference !== null)).toBe(true);
    expect(references.map((p) => p.id).sort()).toEqual([...brands, ...templates].map((p) => p.id).sort());
    expect(references.map((p) => p.id)).not.toContain(ids.miaOrdinary);
  });

  it("a plain member's type=brand holds their own brands (private included) and the published brands of others — never the private brands of others", async () => {
    const brands = await listAll(noa(), 'type=brand');
    const brandIds = brands.map((p) => p.id);
    expect(brands.every((p) => p.reference?.type === 'brand')).toBe(true);
    expect(brandIds).toEqual(expect.arrayContaining([ids.noaPrivBrand, ids.miaPubBrand, ids.ownPubBrand]));
    expect(brandIds).not.toContain(ids.miaPrivBrand);
    expect(brandIds).not.toContain(ids.ownPrivBrand);
    expect(brandIds).not.toContain(ids.ownPubTemplate);

    const templates = await listIds(noa(), 'type=template');
    expect(templates).toContain(ids.ownPubTemplate);
    expect(templates).not.toContain(ids.miaPrivTemplate);

    const references = await listIds(noa(), 'type=reference');
    expect(references).toEqual(
      expect.arrayContaining([ids.noaPrivBrand, ids.miaPubBrand, ids.ownPubBrand, ids.ownPubTemplate])
    );
    for (const hidden of [ids.miaPrivBrand, ids.ownPrivBrand, ids.miaPrivTemplate]) {
      expect(references).not.toContain(hidden);
    }
    // Everything a member is listed, the member can open.
    for (const id of references) expect((await get(`/presentations/${id}`, noa())).status).toBe(200);
  });

  it('the member’s read-scoped key lists exactly what the session lists', async () => {
    const key = { authorization: `Bearer ${noaReadKey}` };
    for (const query of ['', 'type=brand', 'type=template', 'type=reference']) {
      expect(await listIds(key, query)).toEqual(await listIds(noa(), query));
    }
  });

  it('an unknown type answers 400', async () => {
    for (const query of ['type=poster', 'type=Brand', 'type=', 'default=false']) {
      expect((await get(`/presentations?${query}`, noa())).status, query).toBe(400);
    }
  });

  it('pagination keeps working with type: limit=1 and the cursor walk returns every brand exactly once', async () => {
    for (const auth of [noa(), { cookie: adminCookie }]) {
      const whole = (await listAll(auth, 'type=brand', 100)).map((p) => p.id);
      const walked = (await listAll(auth, 'type=brand', 1)).map((p) => p.id);
      expect(new Set(walked).size).toBe(walked.length);
      expect(walked).toEqual(whole);
      expect(walked.length).toBeGreaterThanOrEqual(3);
    }
    const noaWalk = (await listAll(noa(), 'type=brand', 1)).map((p) => p.id);
    expect(noaWalk).toEqual(expect.arrayContaining([ids.noaPrivBrand, ids.miaPubBrand, ids.ownPubBrand]));
    expect(noaWalk).not.toContain(ids.miaPrivBrand);
  }, 120_000);
});

// ── 7 ────────────────────────────────────────────────────────────────────────

describe('7. the mirror moves with the version, and fails closed', () => {
  const mia = () => ({ cookie: miaCookie });
  const noa = () => ({ cookie: noaCookie });
  const admin = () => ({ cookie: adminCookie });

  it('a re-push that changes title and colors moves the deck mirror; the older version keeps its own', async () => {
    const id = await newBrand(mia(), 'm7-moving');
    const next = bundleOf('m7-moving-v2', brandMd('m7-moving renamed', '#00ff00'));
    const res = await commitVersion(mia(), id, 1, next);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.presentation.reference).toEqual(brandReference('m7-moving renamed', '#00ff00'));
    expect(body.version.reference).toEqual(brandReference('m7-moving renamed', '#00ff00'));
    expect(body.version.referenceWarning).toBeNull();

    const v1 = await readJson(await get(`/presentations/${id}/versions/1`, mia()));
    expect(v1.reference).toEqual(brandReference('m7-moving'));
    const v2 = await readJson(await get(`/presentations/${id}/versions/2`, mia()));
    expect(v2.reference).toEqual(brandReference('m7-moving renamed', '#00ff00'));
    const deck = await readJson(await get(`/presentations/${id}`, mia()));
    expect(deck.reference).toEqual(brandReference('m7-moving renamed', '#00ff00'));

    const versions = await readJson(await get(`/presentations/${id}/versions`, mia()));
    const byNumber = new Map(
      (versions.versions as Array<{ version: number; reference: unknown }>).map((v) => [
        v.version,
        v.reference
      ])
    );
    expect(byNumber.get(1)).toEqual(brandReference('m7-moving'));
    expect(byNumber.get(2)).toEqual(brandReference('m7-moving renamed', '#00ff00'));
  });

  it('a re-push that keeps the frontmatter keeps the audience and the default', async () => {
    const id = await newBrand(mia(), 'm7-steady');
    await patchOk(id, { audience: 'workspace', defaultReference: true }, admin());
    const res = await commitVersion(mia(), id, 1, brandBundle('m7-steady-v2'));
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.presentation.audience).toBe('workspace');
    expect(body.presentation.defaultReference).toBe(true);
    expect(body.version.referenceWarning).toBeNull();
    expect((await get(`/presentations/${id}`, noa())).status).toBe(200);
  });

  it('a re-push that REMOVES the frontmatter from a workspace, default brand closes it: ordinary, private, not default, a warning — and restoring it later makes a PRIVATE brand', async () => {
    const id = await newBrand(mia(), 'm7-closing');
    await patchOk(id, { audience: 'workspace', defaultReference: true }, admin());
    expect((await get(`/presentations/${id}`, noa())).status).toBe(200);
    expect(await listIds(noa(), 'type=brand&default=true')).toEqual([id]);

    const bare = bundleOf('m7-closing-v2', '# The briefing, without its frontmatter\n');
    const removed = await commitVersion(mia(), id, 1, bare);
    expect(removed.status).toBe(201);
    const body = await readJson(removed);
    expect(body.presentation.reference).toBeNull();
    expect(body.presentation.audience).toBe('private');
    expect(body.presentation.defaultReference).toBe(false);
    expect(body.version.reference).toBeNull();
    expect(typeof body.version.referenceWarning).toBe('string');
    expect(body.version.referenceWarning).toMatch(/ordinary deck/i);
    expect(body.version.referenceWarning).toMatch(/private/i);
    expect(body.version.referenceWarning).toMatch(/default/i);
    const detail = await readJson(await get(`/presentations/${id}/versions/2`, mia()));
    expect(detail.referenceWarning).toBe(body.version.referenceWarning);

    // The plain member who could read it is cut off, on the deck and on its bytes.
    const v1Logo = shaOf(logoOf('m7-closing').bytes);
    expect(await readStatuses(id, v1Logo, noa())).toEqual(ALL_404);
    expect(await precheck([v1Logo], noa())).toEqual([v1Logo]);
    expect(await listIds(noa(), 'type=brand&default=true')).toEqual([]);
    expect(await listIds(noa(), 'type=reference')).not.toContain(id);
    expect(await listIds(mia())).toContain(id);
    expect(await defaultCount('brand')).toBe(0);

    // Months later the frontmatter comes back: a brand again, and NOBODY chose to reopen it.
    const restored = await commitVersion(mia(), id, 2, brandBundle('m7-closing-v3'));
    expect(restored.status).toBe(201);
    const back = await readJson(restored);
    expect(back.presentation.reference).toEqual(brandReference('m7-closing-v3'));
    expect(back.presentation.audience).toBe('private');
    expect(back.presentation.defaultReference).toBe(false);
    expect((await get(`/presentations/${id}`, noa())).status).toBe(404);
    expect(await listIds(noa(), 'type=brand')).not.toContain(id);
  });

  it('an UNUSABLE frontmatter closes a workspace brand exactly like a removed one', async () => {
    const id = await newBrand(mia(), 'm7-unusable');
    await publish(id, mia());
    expect((await get(`/presentations/${id}`, noa())).status).toBe(200);
    const broken = bundleOf('m7-unusable-v2', '---\ntype: Poster\ntitle: m7-unusable\n---\n# briefing\n');
    const res = await commitVersion(mia(), id, 1, broken);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.presentation.reference).toBeNull();
    expect(body.presentation.audience).toBe('private');
    expect(typeof body.version.referenceWarning).toBe('string');
    expect((await get(`/presentations/${id}`, noa())).status).toBe(404);
  });

  it('a re-push that changes the type of the default brand to Template: still a workspace reference, no longer a default, a warning', async () => {
    const id = await newBrand(mia(), 'm7-retyped');
    await patchOk(id, { audience: 'workspace', defaultReference: true }, admin());
    expect(await listIds(admin(), 'type=brand&default=true')).toEqual([id]);

    const res = await commitVersion(mia(), id, 1, templateBundle('m7-retyped-v2'));
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.presentation.reference.type).toBe('template');
    expect(body.version.reference.type).toBe('template');
    expect(body.presentation.audience).toBe('workspace');
    expect(body.presentation.defaultReference).toBe(false);
    expect(typeof body.version.referenceWarning).toBe('string');
    expect(body.version.referenceWarning).toMatch(/default/i);

    expect((await get(`/presentations/${id}`, noa())).status).toBe(200);
    expect(await listIds(admin(), 'type=brand&default=true')).toEqual([]);
    expect(await listIds(noa(), 'type=template')).toContain(id);
    expect(await listIds(noa(), 'type=brand')).not.toContain(id);
    expect(await listIds(admin(), 'type=template&default=true')).not.toContain(id);
  });
});

// ── 8 ────────────────────────────────────────────────────────────────────────

describe('8. duplicate', () => {
  it("a plain member duplicates someone else's workspace brand: a PRIVATE, non-default brand of their own", async () => {
    const source = await newBrand({ cookie: miaCookie }, 'u8-source');
    await patchOk(source, { audience: 'workspace', defaultReference: true }, { cookie: adminCookie });

    const res = await app.app.request(
      `/api/v1/presentations/${source}/duplicate`,
      json({}, { cookie: noaCookie })
    );
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.presentation.id).not.toBe(source);
    expect(body.presentation.reference).toEqual(brandReference('u8-source'));
    expect(body.presentation.reference.type).toBe('brand');
    expect(body.version.reference).toEqual(brandReference('u8-source'));
    expect(body.presentation.audience).toBe('private');
    expect(body.presentation.defaultReference).toBe(false);
    expect(body.presentation.ownerUserId).toBe(noaUserId);
    expect(body.presentation.remixedFrom).toBe(source);

    // The copy is the member's own deck: theirs to push, and nobody else's to read.
    const copy = body.presentation.id as string;
    expect((await get(`/presentations/${copy}`, { cookie: miaCookie })).status).toBe(404);
    expect(await listIds({ cookie: noaCookie }, 'type=brand')).toContain(copy);
    expect(await listIds({ cookie: adminCookie }, 'type=brand&default=true')).toEqual([source]);
    expect((await publish(copy, { cookie: noaCookie })).audience).toBe('workspace');
  });

  it('a private brand of someone else answers 404 to the duplicate, like every other read', async () => {
    const source = await newBrand({ cookie: miaCookie }, 'u8-private');
    const res = await app.app.request(
      `/api/v1/presentations/${source}/duplicate`,
      json({}, { cookie: noaCookie })
    );
    expect(res.status).toBe(404);
  });
});

// ── 9 ────────────────────────────────────────────────────────────────────────

describe('9. nothing crosses a workspace boundary', () => {
  let w2 = '';
  let cyCookie = '';
  let brand = '';
  const logo = shaOf(logoOf('x9-brand').bytes);

  beforeAll(async () => {
    brand = await newBrand({ cookie: miaCookie }, 'x9-brand');
    await patchOk(brand, { audience: 'workspace', defaultReference: true }, { cookie: adminCookie });

    const created = await app.app.request(
      '/api/v1/workspaces',
      json({ name: 'Workspace Two' }, { cookie: danCookie, [WS]: w1 })
    );
    expect(created.status).toBe(201);
    w2 = (await readJson(created)).workspace.id;
    cyCookie = await joinWorkspace(CY, 'member', { cookie: danCookie, [WS]: w2 });
  }, 120_000);

  it('a member of ANOTHER workspace gets 404 on the workspace brand, on every read surface', async () => {
    expect(await readStatuses(brand, logo, { cookie: cyCookie })).toEqual(ALL_404);
    expect(await readStatuses(brand, logo, { cookie: cyCookie, [WS]: w2 })).toEqual(ALL_404);
    // Dan belongs to both: the brand is his to read in 1, and does not exist in 2.
    expect(await readStatuses(brand, logo, { cookie: danCookie, [WS]: w1 })).toEqual(ALL_200);
    expect(await readStatuses(brand, logo, { cookie: danCookie, [WS]: w2 })).toEqual(ALL_404);
  });

  it('it never appears in their lists, and its bytes are not theirs to bind', async () => {
    for (const auth of [{ cookie: cyCookie }, { cookie: danCookie, [WS]: w2 }]) {
      for (const query of ['', 'type=brand', 'type=reference', 'type=brand&default=true', 'default=true']) {
        expect(await listAll(auth, query)).toEqual([]);
      }
      expect(await precheck([logo], auth)).toEqual([logo]);
      const dup = await app.app.request(`/api/v1/presentations/${brand}/duplicate`, json({}, auth));
      expect(dup.status).toBe(404);
    }
  });

  it('addressing workspace 1 explicitly does not help a non-member', async () => {
    const res = await get(`/presentations/${brand}`, { cookie: cyCookie, [WS]: w1 });
    expect([401, 403, 404]).toContain(res.status);
    const list = await get('/presentations?type=brand', { cookie: cyCookie, [WS]: w1 });
    expect([401, 403, 404]).toContain(list.status);
  });

  it('each workspace keeps its own default brand', async () => {
    const dan2 = { cookie: danCookie, [WS]: w2 };
    const theirs = await newBrand(dan2, 'x9-w2-brand');
    await patchOk(theirs, { audience: 'workspace', defaultReference: true }, dan2);
    expect(await listIds(dan2, 'type=brand&default=true')).toEqual([theirs]);
    expect(await listIds({ cookie: adminCookie }, 'type=brand&default=true')).toEqual([brand]);
    expect((await get(`/presentations/${theirs}`, { cookie: cyCookie })).status).toBe(200);
    expect((await get(`/presentations/${theirs}`, { cookie: noaCookie })).status).toBe(404);
  });
});

// ── 10 ───────────────────────────────────────────────────────────────────────

describe('10. the existence-oracle posture on audience and defaultReference', () => {
  const BODIES = [
    { audience: 'workspace' },
    { audience: 'private' },
    { defaultReference: true },
    { defaultReference: false },
    { audience: 'workspace', defaultReference: true },
    { title: 'probe', audience: 'workspace' }
  ];

  /** A deck the caller cannot read must answer byte-for-byte like a random uuid. */
  async function expectSameAsUnknown(deckId: string, auth: Auth): Promise<void> {
    for (const body of BODIES) {
      const real = await patch(deckId, body, auth);
      const ghost = await patch(randomUUID(), body, auth);
      const context = JSON.stringify(body);
      expect(real.status, context).toBe(404);
      expect(ghost.status, context).toBe(404);
      expect(await readJson(real), context).toEqual(await readJson(ghost));
    }
  }

  it("a plain member probing another member's PRIVATE brand and ORDINARY deck learns nothing", async () => {
    const privateBrand = await newBrand({ cookie: miaCookie }, 'o10-private');
    const ordinary = (await newDeck({ cookie: miaCookie }, 'o10-ordinary', bundleOf('o10-ordinary')))
      .presentation.id as string;
    await expectSameAsUnknown(privateBrand, { cookie: noaCookie });
    // An ordinary deck must NOT answer 422 not_a_reference to a non-reader: that would confirm it exists.
    await expectSameAsUnknown(ordinary, { cookie: noaCookie });

    const after = await readJson(await get(`/presentations/${privateBrand}`, { cookie: miaCookie }));
    expect(after.audience).toBe('private');
    expect(after.defaultReference).toBe(false);
    expect(after.title).toBe('o10-private');
  });

  it('an ADMIN-role check never runs before the read check: a plain member gets 404, not 403, for defaultReference on an unreadable deck', async () => {
    const privateBrand = await newBrand({ cookie: ownerCookie }, 'o10-owner-private');
    const res = await patch(privateBrand, { defaultReference: true }, { cookie: miaCookie });
    expect(res.status).toBe(404);
  });

  it('a guest probing a PUBLISHED brand, and a member of another workspace, get the same 404 as a random uuid', async () => {
    const published = await newBrand({ cookie: miaCookie }, 'o10-published');
    await publish(published, { cookie: miaCookie });
    await expectSameAsUnknown(published, { cookie: guestCookie });

    // Dan addressing workspace 2 (created in area 9, or here when run alone).
    const mine = await readJson(await get('/me', { cookie: danCookie, [WS]: w1 }));
    let other = (mine.workspaces as Array<{ id: string }>).find((w) => w.id !== w1)?.id;
    if (!other) {
      const created = await app.app.request(
        '/api/v1/workspaces',
        json({ name: 'Workspace Two (oracle)' }, { cookie: danCookie, [WS]: w1 })
      );
      expect(created.status).toBe(201);
      other = (await readJson(created)).workspace.id as string;
    }
    await expectSameAsUnknown(published, { cookie: danCookie, [WS]: other });
  });

  it('a soft-deleted brand answers like a random uuid too, to its own owner', async () => {
    const gone = await newBrand({ cookie: miaCookie }, 'o10-deleted');
    const removed = await del(gone, { cookie: miaCookie });
    expect(removed.status).toBeLessThan(300);
    await expectSameAsUnknown(gone, { cookie: miaCookie });
  });
});

// ── 11 ───────────────────────────────────────────────────────────────────────

describe('11. the audit log records what a reference LOST and which default was displaced', () => {
  const mia = () => ({ cookie: miaCookie });
  const admin = () => ({ cookie: adminCookie });

  /** The newest audit row of an action on one deck (the write is awaited before the response). */
  async function lastAudit(
    action: string,
    deckId: string
  ): Promise<{ metadata: Record<string, unknown>; actor_user_id: string | null }> {
    const { rows } = await app.db.pool.query<{
      metadata: Record<string, unknown>;
      actor_user_id: string | null;
    }>(
      `SELECT metadata, actor_user_id FROM audit_log
        WHERE action = $1 AND resource_id = $2 AND workspace_id = $3
        ORDER BY id DESC LIMIT 1`,
      [action, deckId, w1]
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it('a DEV COLLABORATOR whose re-push removes the frontmatter from the workspace default brand leaves referenceLoss {audienceReset, defaultDropped} on the version_commit row', async () => {
    const id = await newBrand(mia(), 'au11-dev-loss');
    await patchOk(id, { audience: 'workspace', defaultReference: true }, admin());
    await grantDev(id, NOA.email, noaCookie);

    const bare = bundleOf('au11-dev-loss-v2', '# The briefing, without its frontmatter\n');
    const res = await commitVersion({ cookie: noaCookie }, id, 1, bare);
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.version.createdByRole).toBe('dev');
    expect(body.presentation.audience).toBe('private');
    expect(body.presentation.defaultReference).toBe(false);

    const row = await lastAudit('presentation.version_commit', id);
    expect(row.actor_user_id).toBe(noaUserId);
    expect(row.metadata.version).toBe(2);
    expect(row.metadata.referenceType).toBeNull();
    expect(row.metadata.referenceLoss).toEqual({ audienceReset: true, defaultDropped: true });
  });

  it('a re-push that changes nothing about the reference carries no referenceLoss key', async () => {
    const id = await newBrand(mia(), 'au11-steady');
    await patchOk(id, { audience: 'workspace', defaultReference: true }, admin());
    const res = await commitVersion(mia(), id, 1, brandBundle('au11-steady-v2'));
    expect(res.status).toBe(201);

    const row = await lastAudit('presentation.version_commit', id);
    expect(row.metadata.version).toBe(2);
    expect(row.metadata.referenceType).toBe('brand');
    expect(row.metadata).not.toHaveProperty('referenceLoss');
  });

  it('a type change on the default brand records {audienceReset: false, defaultDropped: true}', async () => {
    const id = await newBrand(mia(), 'au11-retyped');
    await patchOk(id, { audience: 'workspace', defaultReference: true }, admin());
    const res = await commitVersion(mia(), id, 1, templateBundle('au11-retyped-v2'));
    expect(res.status).toBe(201);
    const body = await readJson(res);
    expect(body.presentation.audience).toBe('workspace');
    expect(body.presentation.defaultReference).toBe(false);

    const row = await lastAudit('presentation.version_commit', id);
    expect(row.metadata.referenceType).toBe('template');
    expect(row.metadata.referenceLoss).toEqual({ audienceReset: false, defaultDropped: true });
  });

  it('setting a second brand as default names the displaced one on the presentation.update row; a set with no previous default carries no such key', async () => {
    // Start from NO default brand, whatever the areas above left behind.
    for (const standing of await listIds(admin(), 'type=brand&default=true')) {
      await patchOk(standing, { defaultReference: false }, admin());
    }
    const first = await newBrand(mia(), 'au11-first');
    const second = await newBrand(mia(), 'au11-second');
    await publish(second, mia());

    await patchOk(first, { audience: 'workspace', defaultReference: true }, admin());
    const opening = await lastAudit('presentation.update', first);
    expect(opening.metadata.fields).toEqual(['audience', 'defaultReference']);
    expect(opening.metadata.audience).toBe('workspace');
    expect(opening.metadata.defaultReference).toBe(true);
    expect(opening.metadata).not.toHaveProperty('displacedDefaultIds');

    await patchOk(second, { defaultReference: true }, admin());
    const displacing = await lastAudit('presentation.update', second);
    expect(displacing.metadata.fields).toEqual(['defaultReference']);
    expect(displacing.metadata.defaultReference).toBe(true);
    expect(displacing.metadata).not.toHaveProperty('audience');
    expect(displacing.metadata.displacedDefaultIds).toEqual([first]);

    // Re-asserting the standing default displaces nobody.
    await patchOk(second, { defaultReference: true }, admin());
    expect((await lastAudit('presentation.update', second)).metadata).not.toHaveProperty(
      'displacedDefaultIds'
    );
    // A plain PATCH carries neither reference key.
    await patchOk(second, { title: 'au11-second retitled' }, mia());
    const plain = (await lastAudit('presentation.update', second)).metadata;
    expect(plain.fields).toEqual(['title']);
    for (const key of ['audience', 'defaultReference', 'displacedDefaultIds']) {
      expect(plain).not.toHaveProperty(key);
    }
  });
});
