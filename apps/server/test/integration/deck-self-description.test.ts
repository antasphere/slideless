import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AGENT_DOC_PATH } from '@slideless/contract';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * Deck self-description (PRDCT-1311) — the two channels a deck describes
 * itself through:
 *
 *  - `metadata`: an owner-defined JSON object on the presentation, settable
 *    at create and via the new PATCH /presentations/{id} (full replace, the
 *    external-dashboard seam).
 *  - AGENT.md: the reserved bundle-root briefing. `has_agent_doc` is stamped
 *    at commit (exact, case-sensitive path) onto the version AND mirrored on
 *    the deck; GET /presentations/{id}/agent-doc streams it (markdown,
 *    attachment + nosniff — user content never renders on the app origin).
 */

const OWNER = { email: 'owner@selfdesc.test', name: 'SelfDesc Owner', password: 'selfdesc-owner-pass-1' };
const MEMBER = { email: 'member@selfdesc.test', name: 'Plain Member', password: 'selfdesc-member-pass-1' };

const HTML = Buffer.from('<!doctype html><html><body><h1>Self-described deck</h1></body></html>');
const HTML_V2 = Buffer.from('<!doctype html><html><body><h1>Self-described deck v2</h1></body></html>');
const AGENT_MD = Buffer.from('# Agent briefing\n\nRender page 1 first; data lives in data.json.\n');

const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const entryOf = (path: string, bytes: Buffer, contentType: string) => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType
});

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let memberCookie: string;
let readOnlyKey: string;

let ipCounter = 0;
const nextIp = () => `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function uploadBlob(bytes: Buffer, contentType: string, name: string): Promise<void> {
  const form = new FormData();
  form.set('sha256', shaOf(bytes));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: contentType }), name);
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie: ownerCookie },
    body: form
  });
  expect([200, 201]).toContain(res.status);
}

/** Reserve + commit a fresh deck; returns { presentation, version } wire shapes. */
async function createDeck(body: Record<string, unknown>) {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json({ title: 'Self-described deck', entryPath: 'index.html', ...body }, { cookie: ownerCookie })
  );
  expect(commit.status).toBe(201);
  return readJson(commit);
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'deck_self_desc'));
  await app.app.request('/api/v1/setup', json({ instanceName: 'SelfDesc', owner: OWNER }));
  ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );

  // A plain workspace member with no grant on any deck (ADR 013 probes).
  const invite = await app.app.request(
    '/api/v1/invitations',
    json({ email: MEMBER.email, role: 'member' }, { cookie: ownerCookie })
  );
  expect(invite.status).toBe(201);
  const acceptToken = ((await readJson(invite)).acceptUrl as string).split('/invite/')[1]!;
  expect(
    (
      await app.app.request(
        '/api/v1/invitations/accept',
        json({ token: acceptToken, name: MEMBER.name, password: MEMBER.password })
      )
    ).status
  ).toBe(200);
  memberCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: MEMBER.email, password: MEMBER.password })
    )
  );

  // A read-only machine credential (fail-closed scope allowlist probe).
  const keyRes = await app.app.request(
    '/api/v1/api-keys',
    json({ name: 'read-only', scopes: ['presentations:read'] }, { cookie: ownerCookie })
  );
  expect(keyRes.status).toBe(201);
  readOnlyKey = (await readJson(keyRes)).key;

  await uploadBlob(HTML, 'text/html', 'index.html');
  await uploadBlob(HTML_V2, 'text/html', 'index.html');
  await uploadBlob(AGENT_MD, 'text/markdown', AGENT_DOC_PATH);
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

// ── Metadata ────────────────────────────────────────────────────────────────

describe('presentation metadata', () => {
  it('a deck created with metadata carries it on get and list; omitted = {}', async () => {
    const metadata = { client: 'Acme', priority: 3, tags: ['q3', 'emea'] };
    const { presentation } = await createDeck({
      manifest: [entryOf('index.html', HTML, 'text/html')],
      metadata
    });
    expect(presentation.metadata).toEqual(metadata);

    const got = await readJson(
      await app.app.request(`/api/v1/presentations/${presentation.id}`, {
        headers: { cookie: ownerCookie }
      })
    );
    expect(got.metadata).toEqual(metadata);

    const list = await readJson(
      await app.app.request('/api/v1/presentations?limit=100', { headers: { cookie: ownerCookie } })
    );
    const row = list.presentations.find((p: { id: string }) => p.id === presentation.id);
    expect(row.metadata).toEqual(metadata);

    const bare = await createDeck({ manifest: [entryOf('index.html', HTML, 'text/html')] });
    expect(bare.presentation.metadata).toEqual({});
  });

  it('PATCH replaces metadata WHOLESALE and retitles without a version push', async () => {
    const { presentation } = await createDeck({
      manifest: [entryOf('index.html', HTML, 'text/html')],
      metadata: { keep: 'no', stage: 'draft' }
    });

    const patched = await readJson(
      await app.app.request(`/api/v1/presentations/${presentation.id}`, {
        ...json({ metadata: { stage: 'final' } }, { cookie: ownerCookie }),
        method: 'PATCH'
      })
    );
    // Full replace: the old `keep` key is GONE, not merged over.
    expect(patched.metadata).toEqual({ stage: 'final' });
    expect(patched.currentVersion).toBe(1);

    const retitled = await readJson(
      await app.app.request(`/api/v1/presentations/${presentation.id}`, {
        ...json({ title: 'Renamed without a push' }, { cookie: ownerCookie }),
        method: 'PATCH'
      })
    );
    expect(retitled.title).toBe('Renamed without a push');
    expect(retitled.metadata).toEqual({ stage: 'final' });
    expect(retitled.currentVersion).toBe(1);
  });

  it('PATCH validation: empty body, array metadata, and oversized metadata all 400', async () => {
    const { presentation } = await createDeck({ manifest: [entryOf('index.html', HTML, 'text/html')] });
    const patch = (body: unknown) =>
      app.app.request(`/api/v1/presentations/${presentation.id}`, {
        ...json(body, { cookie: ownerCookie }),
        method: 'PATCH'
      });

    expect((await patch({})).status).toBe(400);
    expect((await patch({ metadata: ['not', 'an', 'object'] })).status).toBe(400);
    expect((await patch({ metadata: { blob: 'x'.repeat(17 * 1024) } })).status).toBe(400);
  });

  it('a plain member PATCHing a foreign deck answers 404, never 403 (ADR 013)', async () => {
    const { presentation } = await createDeck({ manifest: [entryOf('index.html', HTML, 'text/html')] });
    const res = await app.app.request(`/api/v1/presentations/${presentation.id}`, {
      ...json({ title: 'hijack' }, { cookie: memberCookie }),
      method: 'PATCH'
    });
    expect(res.status).toBe(404);
  });

  it('a presentations:read key cannot PATCH (fail-closed scope allowlist)', async () => {
    const { presentation } = await createDeck({ manifest: [entryOf('index.html', HTML, 'text/html')] });
    const res = await app.app.request(`/api/v1/presentations/${presentation.id}`, {
      ...json({ title: 'nope' }, { authorization: `Bearer ${readOnlyKey}` }),
      method: 'PATCH'
    });
    expect(res.status).toBe(403);
  });
});

// ── AGENT.md detection ──────────────────────────────────────────────────────

describe('AGENT.md commit-time detection', () => {
  it('a bundle shipping AGENT.md at the root stamps hasAgentDoc on version AND deck', async () => {
    const { presentation, version } = await createDeck({
      manifest: [entryOf('index.html', HTML, 'text/html'), entryOf(AGENT_DOC_PATH, AGENT_MD, 'text/markdown')]
    });
    expect(version.hasAgentDoc).toBe(true);
    expect(presentation.hasAgentDoc).toBe(true);
  });

  it('the reserved name is exact and case-sensitive: agent.md does not count', async () => {
    const { presentation, version } = await createDeck({
      manifest: [entryOf('index.html', HTML, 'text/html'), entryOf('agent.md', AGENT_MD, 'text/markdown')]
    });
    expect(version.hasAgentDoc).toBe(false);
    expect(presentation.hasAgentDoc).toBe(false);
  });

  it('a nested AGENT.md is not the briefing (root only by convention path equality)', async () => {
    const { presentation } = await createDeck({
      manifest: [
        entryOf('index.html', HTML, 'text/html'),
        entryOf(`docs/${AGENT_DOC_PATH}`, AGENT_MD, 'text/markdown')
      ]
    });
    expect(presentation.hasAgentDoc).toBe(false);
  });

  it('a new version without AGENT.md flips the deck mirror; the old version keeps its stamp', async () => {
    const { presentation } = await createDeck({
      manifest: [entryOf('index.html', HTML, 'text/html'), entryOf(AGENT_DOC_PATH, AGENT_MD, 'text/markdown')]
    });
    const commit2 = await readJson(
      await app.app.request(
        `/api/v1/presentations/${presentation.id}/versions`,
        json(
          {
            expectedBaseVersion: 1,
            entryPath: 'index.html',
            manifest: [entryOf('index.html', HTML_V2, 'text/html')]
          },
          { cookie: ownerCookie }
        )
      )
    );
    expect(commit2.version.hasAgentDoc).toBe(false);
    expect(commit2.presentation.hasAgentDoc).toBe(false);

    const v1 = await readJson(
      await app.app.request(`/api/v1/presentations/${presentation.id}/versions/1`, {
        headers: { cookie: ownerCookie }
      })
    );
    expect(v1.hasAgentDoc).toBe(true);

    const listed = await readJson(
      await app.app.request(`/api/v1/presentations/${presentation.id}/versions?limit=10`, {
        headers: { cookie: ownerCookie }
      })
    );
    const byVersion = Object.fromEntries(
      listed.versions.map((v: { version: number; hasAgentDoc: boolean }) => [v.version, v.hasAgentDoc])
    );
    expect(byVersion).toEqual({ 1: true, 2: false });
  });
});

// ── The agent-doc read endpoint ─────────────────────────────────────────────

describe('GET /presentations/{id}/agent-doc', () => {
  it('streams the briefing as markdown, attachment + nosniff (app-origin safe-serving)', async () => {
    const { presentation } = await createDeck({
      manifest: [entryOf('index.html', HTML, 'text/html'), entryOf(AGENT_DOC_PATH, AGENT_MD, 'text/markdown')]
    });
    const res = await app.app.request(`/api/v1/presentations/${presentation.id}/agent-doc`, {
      headers: { cookie: ownerCookie }
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(AGENT_MD.toString('utf8'));
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition') ?? '').toMatch(/^attachment/);
  });

  it('?version pins an older briefing after a later version dropped it; absent = 404 agent_doc_not_found', async () => {
    const { presentation } = await createDeck({
      manifest: [entryOf('index.html', HTML, 'text/html'), entryOf(AGENT_DOC_PATH, AGENT_MD, 'text/markdown')]
    });
    await app.app.request(
      `/api/v1/presentations/${presentation.id}/versions`,
      json(
        {
          expectedBaseVersion: 1,
          entryPath: 'index.html',
          manifest: [entryOf('index.html', HTML_V2, 'text/html')]
        },
        { cookie: ownerCookie }
      )
    );

    const latest = await app.app.request(`/api/v1/presentations/${presentation.id}/agent-doc`, {
      headers: { cookie: ownerCookie }
    });
    expect(latest.status).toBe(404);
    expect((await readJson(latest)).error.code).toBe('agent_doc_not_found');

    const pinned = await app.app.request(`/api/v1/presentations/${presentation.id}/agent-doc?version=1`, {
      headers: { cookie: ownerCookie }
    });
    expect(pinned.status).toBe(200);
    expect(await pinned.text()).toBe(AGENT_MD.toString('utf8'));
  });

  it('a read-scoped API key reads it; a non-reader member answers 404 (existence not probeable)', async () => {
    const { presentation } = await createDeck({
      manifest: [entryOf('index.html', HTML, 'text/html'), entryOf(AGENT_DOC_PATH, AGENT_MD, 'text/markdown')]
    });
    const viaKey = await app.app.request(`/api/v1/presentations/${presentation.id}/agent-doc`, {
      headers: { authorization: `Bearer ${readOnlyKey}` }
    });
    expect(viaKey.status).toBe(200);

    const viaMember = await app.app.request(`/api/v1/presentations/${presentation.id}/agent-doc`, {
      headers: { cookie: memberCookie }
    });
    expect(viaMember.status).toBe(404);
    expect((await readJson(viaMember)).error.code).toBe('not_found');
  });
});

// ── Public viewer serving (documented behavior) ─────────────────────────────

describe('the public viewer serves AGENT.md like any manifest path', () => {
  it('/v/{secret}/AGENT.md answers the briefing under the sandbox regime', async () => {
    const { presentation } = await createDeck({
      manifest: [entryOf('index.html', HTML, 'text/html'), entryOf(AGENT_DOC_PATH, AGENT_MD, 'text/markdown')]
    });
    const created = await readJson(
      await app.app.request(
        `/api/v1/presentations/${presentation.id}/tokens`,
        json({ name: 'Agent reader' }, { cookie: ownerCookie })
      )
    );
    const res = await app.app.request(`/v/${created.secret}/${AGENT_DOC_PATH}`, {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(AGENT_MD.toString('utf8'));
    expect(res.headers.get('content-security-policy') ?? '').toContain('sandbox');
  });
});
