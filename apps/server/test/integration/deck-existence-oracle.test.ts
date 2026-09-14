/**
 * ADR 013 / AUTH-5 (PRDCT-1393) — the per-deck existence-oracle sweep.
 *
 * Enumerates EVERY per-deck route in api/presentations.ts +
 * api/collaborators.ts and asserts, for a plain workspace member holding no
 * grant, that a REAL deck they cannot read and a NONEXISTENT uuid are
 * indistinguishable: 404 `not_found`, both ways, on every route. Child ids
 * (token/annotation/response/collaborator) are REAL ids of the real deck, so
 * the sweep also proves the deck check runs BEFORE any child lookup.
 *
 * The probe table is pinned against the OpenAPI document: a NEW per-deck
 * route cannot ship without joining the table (the completeness test fails),
 * and once in the table it cannot ship with a 403 (the sweep fails). This is
 * the regression guard for the rule ADR 013 states: a per-deck surface
 * answers 404 whenever the caller fails the deck READ check; a 403 may only
 * follow a PASSED read check — asserted here too, via an active dev
 * collaborator refused the owner-level acts.
 */
import { createHash } from 'node:crypto';
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

const OWNER = { email: 'owner@oracle.test', name: 'Oracle Owner', password: 'oracle-owner-pass-11' };
const PLAIN = { email: 'plain@oracle.test', name: 'Oracle Plain', password: 'oracle-plain-pass-11' };
const DEVU = { email: 'dev@oracle.test', name: 'Oracle Dev', password: 'oracle-dev-pass-1111' };
const OTHER = { email: 'other@oracle.test', name: 'Oracle Other', password: 'oracle-other-pass-11' };

const HTML = Buffer.from(
  '<!doctype html><html><head><title>Oracle</title></head><body>' +
    '<form data-slideless-form="rsvp"><input name="who"></form></body></html>'
);
const SHA = createHash('sha256').update(HTML).digest('hex');
const MANIFEST = [{ path: 'index.html', sha256: SHA, sizeBytes: HTML.length, contentType: 'text/html' }];

const UNKNOWN_DECK = '00000000-0000-4000-8000-0000000000aa';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie = '';
let plainCookie = '';
let devCookie = '';

let ownerDeck = '';
let realTokenId = '';
let realTokenSecret = '';
let previewTokenId = '';
let realAnnotationId = '';
let realResponseId = '';
let realCollaboratorId = '';

// The public claim + invitation-accept routes ride a tight per-IP wall and
// TRUST_PROXY is on in tests — rotate the forwarded address every request.
let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function signIn(email: string, password: string): Promise<string> {
  const res = await app.app.request('/api/v1/auth/sign-in/email', json({ email, password }));
  expect(res.status).toBe(200);
  return extractCookie(res);
}

async function addMember(p: { email: string; name: string; password: string }): Promise<string> {
  const invited = await readJson(
    await app.app.request(
      '/api/v1/invitations',
      json({ email: p.email, role: 'member' }, { cookie: ownerCookie })
    )
  );
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: invited.acceptUrl.split('/invite/')[1], name: p.name, password: p.password })
  );
  expect(accept.status).toBe(200);
  return signIn(p.email, p.password);
}

async function uploadAsset(cookie: string): Promise<void> {
  const form = new FormData();
  form.set('sha256', SHA);
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const res = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie, 'x-forwarded-for': nextIp() },
    body: form
  });
  expect(res.status).toBe(201);
}

async function createDeck(cookie: string, title: string): Promise<string> {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie, 'x-forwarded-for': nextIp() }
    })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json({ title, entryPath: 'index.html', manifest: MANIFEST }, { cookie })
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId;
}

type Probe = { status: number; code: string | null };

async function shot(path: string, method: string, cookie: string, body?: unknown): Promise<Probe> {
  const init: RequestInit & { headers: Record<string, string> } = {
    method,
    headers: { cookie, 'x-forwarded-for': nextIp() }
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await app.app.request(path, init);
  let code: string | null = null;
  try {
    const parsed = (await res.clone().json()) as { error?: { code?: string } } | null;
    code = parsed?.error?.code ?? null;
  } catch {
    code = null;
  }
  return { status: res.status, code };
}

/**
 * Every per-deck route, keyed EXACTLY as `<method> <path>` appears in the
 * OpenAPI document — the completeness test below pins this table to the
 * published surface, so a new per-deck route must be added here (with a
 * contract-valid body: validation runs before the handler, and a 400 would
 * mask the deck check this sweep exists to probe).
 */
function routes(deck: string, cookie: string): Record<string, () => Promise<Probe>> {
  const P = `/api/v1/presentations/${deck}`;
  return {
    'get /presentations/{id}': () => shot(P, 'GET', cookie),
    'patch /presentations/{id}': () => shot(P, 'PATCH', cookie, { title: 'oracle-retitle' }),
    'delete /presentations/{id}': () => shot(P, 'DELETE', cookie),
    'post /presentations/{id}/versions': () =>
      shot(`${P}/versions`, 'POST', cookie, {
        expectedBaseVersion: 1,
        entryPath: 'index.html',
        manifest: MANIFEST
      }),
    'get /presentations/{id}/versions': () => shot(`${P}/versions`, 'GET', cookie),
    'get /presentations/{id}/versions/{version}': () => shot(`${P}/versions/1`, 'GET', cookie),
    // The owner-side attachment reads (PRDCT-2278): the same canReadDeck 404
    // as the version detail, never a 403, for a version that exists.
    'get /presentations/{id}/versions/{version}/downloads.zip': () =>
      shot(`${P}/versions/1/downloads.zip`, 'GET', cookie),
    'get /presentations/{id}/versions/{version}/downloads/{name}': () =>
      shot(`${P}/versions/1/downloads/figures.csv`, 'GET', cookie),
    // The duplicate (PRDCT-2279): the source is a READ, so a plain member
    // gets the same 404 on a real-unreadable deck and on a nonexistent one.
    'post /presentations/{id}/duplicate': () => shot(`${P}/duplicate`, 'POST', cookie, {}),
    'get /presentations/{id}/assets/{sha256}': () => shot(`${P}/assets/${SHA}`, 'GET', cookie),
    'get /presentations/{id}/agent-doc': () => shot(`${P}/agent-doc`, 'GET', cookie),
    'get /presentations/{id}/tokens': () => shot(`${P}/tokens`, 'GET', cookie),
    'post /presentations/{id}/tokens': () => shot(`${P}/tokens`, 'POST', cookie, { name: 'oracle link' }),
    'post /presentations/{id}/preview-token': () => shot(`${P}/preview-token`, 'POST', cookie, {}),
    'patch /presentations/{id}/tokens/{tokenId}': () =>
      shot(`${P}/tokens/${realTokenId}`, 'PATCH', cookie, { name: 'oracle rename' }),
    'delete /presentations/{id}/tokens/{tokenId}': () => shot(`${P}/tokens/${realTokenId}`, 'DELETE', cookie),
    'get /presentations/{id}/tokens/{tokenId}/views': () =>
      shot(`${P}/tokens/${realTokenId}/views`, 'GET', cookie),
    'post /presentations/{id}/tokens/{tokenId}/send': () =>
      shot(`${P}/tokens/${realTokenId}/send`, 'POST', cookie, { email: 'oracle-recipient@oracle.test' }),
    'get /presentations/{id}/collaborators': () => shot(`${P}/collaborators`, 'GET', cookie),
    'post /presentations/{id}/collaborators': () =>
      shot(`${P}/collaborators`, 'POST', cookie, { email: OTHER.email }),
    'delete /presentations/{id}/collaborators/{collaboratorId}': () =>
      shot(`${P}/collaborators/${realCollaboratorId}`, 'DELETE', cookie),
    'get /presentations/{id}/annotations': () => shot(`${P}/annotations`, 'GET', cookie),
    'post /presentations/{id}/annotations': () =>
      shot(`${P}/annotations`, 'POST', cookie, { version: 1, selection: { page: 1 }, body: 'oracle note' }),
    'patch /presentations/{id}/annotations/{annotationId}': () =>
      shot(`${P}/annotations/${realAnnotationId}`, 'PATCH', cookie, { status: 'resolved' }),
    'delete /presentations/{id}/annotations/{annotationId}': () =>
      shot(`${P}/annotations/${realAnnotationId}`, 'DELETE', cookie),
    'get /presentations/{id}/responses': () => shot(`${P}/responses`, 'GET', cookie),
    'get /presentations/{id}/responses/summary': () => shot(`${P}/responses/summary`, 'GET', cookie),
    // PRDCT-2329: the per-response history read, same 404 posture as the list.
    'get /presentations/{id}/responses/{responseId}': () =>
      shot(`${P}/responses/${realResponseId}`, 'GET', cookie),
    'delete /presentations/{id}/responses/{responseId}': () =>
      shot(`${P}/responses/${realResponseId}`, 'DELETE', cookie)
  };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'deck_oracle'));

  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Oracle WS', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  ownerCookie = await signIn(OWNER.email, OWNER.password);

  plainCookie = await addMember(PLAIN);
  devCookie = await addMember(DEVU);
  await addMember(OTHER);

  await uploadAsset(ownerCookie);
  ownerDeck = await createDeck(ownerCookie, 'Owner oracle deck');

  // A real share token (canSubmitForms so a real response can exist).
  const tok = await readJson(
    await app.app.request(
      `/api/v1/presentations/${ownerDeck}/tokens`,
      json({ name: 'oracle recipient', canAnnotate: true, canSubmitForms: true }, { cookie: ownerCookie })
    )
  );
  realTokenId = tok.shareToken.id;
  realTokenSecret = tok.secret;

  // A real preview token (for the dev-collaborator revoke 403 below).
  const prev = await readJson(
    await app.app.request(
      `/api/v1/presentations/${ownerDeck}/preview-token`,
      json({}, { cookie: ownerCookie })
    )
  );
  previewTokenId = prev.shareToken.id;

  // A real annotation.
  const ann = await readJson(
    await app.app.request(
      `/api/v1/presentations/${ownerDeck}/annotations`,
      json({ version: 1, selection: { page: 1 }, body: 'owner note' }, { cookie: ownerCookie })
    )
  );
  realAnnotationId = ann.id;

  // A real form response through the public viewer surface.
  const sub = await app.app.request(`/api/v1/viewer/${realTokenSecret}/forms/rsvp/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), origin: 'null' },
    body: JSON.stringify({ payload: { who: 'oracle' } })
  });
  expect([200, 201]).toContain(sub.status);
  const list = await readJson(
    await app.app.request(`/api/v1/presentations/${ownerDeck}/responses`, {
      headers: { cookie: ownerCookie }
    })
  );
  realResponseId = list.responses[0].id;

  // DEVU becomes an ACTIVE dev collaborator on ownerDeck (the proven reader
  // the tiered-rule assertions below need).
  const invite = await readJson(
    await app.app.request(
      `/api/v1/presentations/${ownerDeck}/collaborators`,
      json({ email: DEVU.email }, { cookie: ownerCookie })
    )
  );
  realCollaboratorId = invite.collaborator.id;
  const claim = await app.app.request(
    '/api/v1/collaborators/claim',
    json({ token: invite.claimUrl.split('/collab/')[1] }, { cookie: devCookie })
  );
  expect(claim.status).toBe(200);
  const devRead = await app.app.request(`/api/v1/presentations/${ownerDeck}`, {
    headers: { cookie: devCookie }
  });
  expect(devRead.status).toBe(200);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the per-deck surface never confirms a deck exists (plain member)', () => {
  it('the probe table covers EXACTLY the published per-deck routes — a new route must join it', async () => {
    const doc = await readJson(await app.app.request('/api/v1/openapi.json'));
    const HTTP = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    const published: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths as Record<string, Record<string, unknown>>)) {
      if (path !== '/presentations/{id}' && !path.startsWith('/presentations/{id}/')) continue;
      for (const method of Object.keys(ops)) {
        if (HTTP.includes(method)) published.push(`${method} ${path}`);
      }
    }
    expect(published.sort()).toEqual(Object.keys(routes(UNKNOWN_DECK, plainCookie)).sort());
  });

  it('every route answers 404 not_found for BOTH a real-unreadable deck and a nonexistent one', async () => {
    const real = routes(ownerDeck, plainCookie);
    const fake = routes(UNKNOWN_DECK, plainCookie);
    for (const label of Object.keys(real)) {
      const a = await real[label]!();
      const b = await fake[label]!();
      expect(a.status, `${label} (real deck)`).toBe(404);
      expect(a.code, `${label} (real deck)`).toBe('not_found');
      expect(b.status, `${label} (nonexistent)`).toBe(404);
      expect(b.code, `${label} (nonexistent)`).toBe('not_found');
    }
  });

  it('the refused probes wrote nothing: deck, token, annotation and response survive intact', async () => {
    const deck = await app.app.request(`/api/v1/presentations/${ownerDeck}`, {
      headers: { cookie: ownerCookie }
    });
    expect(deck.status).toBe(200);
    const ann = await readJson(
      await app.app.request(`/api/v1/presentations/${ownerDeck}/annotations`, {
        headers: { cookie: ownerCookie }
      })
    );
    expect(ann.annotations.map((a: { id: string }) => a.id)).toContain(realAnnotationId);
    const resp = await readJson(
      await app.app.request(`/api/v1/presentations/${ownerDeck}/responses`, {
        headers: { cookie: ownerCookie }
      })
    );
    expect(resp.responses.map((r: { id: string }) => r.id)).toContain(realResponseId);
    const toks = await readJson(
      await app.app.request(`/api/v1/presentations/${ownerDeck}/tokens`, {
        headers: { cookie: ownerCookie }
      })
    );
    const t = toks.shareTokens.find((s: { id: string }) => s.id === realTokenId);
    expect(t.revokedAt ?? null).toBeNull();
    expect(t.name).toBe('oracle recipient');
    // No collaborator grant for OTHER was minted by the refused invites.
    const { rows } = await app.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM collaborators WHERE email = $1`,
      [OTHER.email]
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe('the tiered rule: a PROVEN reader refused an owner-level act still gets 403', () => {
  it('active dev collaborator: owner-level refusals are 403 forbidden, never 404', async () => {
    const P = `/api/v1/presentations/${ownerDeck}`;
    const results: Record<string, Probe> = {
      'delete deck': await shot(P, 'DELETE', devCookie),
      'invite collaborator': await shot(`${P}/collaborators`, 'POST', devCookie, { email: OTHER.email }),
      'remove collaborator': await shot(`${P}/collaborators/${realCollaboratorId}`, 'DELETE', devCookie),
      'mint preview token': await shot(`${P}/preview-token`, 'POST', devCookie, {}),
      'revoke preview token': await shot(`${P}/tokens/${previewTokenId}`, 'DELETE', devCookie)
    };
    for (const [label, r] of Object.entries(results)) {
      expect(r.status, label).toBe(403);
      expect(r.code, label).toBe('forbidden');
    }
  });
});
