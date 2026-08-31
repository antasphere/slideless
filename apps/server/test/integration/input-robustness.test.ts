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

/**
 * PRDCT-1358 — the input-validation 500 family, asserted over HTTP: every
 * enumerated input answers 4xx with a stable machine code, never 5xx. The
 * contract-level halves live in packages/contract/test/input-robustness
 * .test.ts; this file covers what only the running app can prove — the
 * Better Auth mount guard (AF-1 + update-user's NUL), the anonymous viewer
 * surfaces, the member PATCH, the version param, the metadata depth caps,
 * and the commit-time contentType gate.
 */

const OWNER = { email: 'owner@robust.test', name: 'Robust Owner', password: 'robust-owner-pass-1' };
const MEMBER = { email: 'member@robust.test', name: 'Robust Member', password: 'robust-member-pass-1' };

const HTML = Buffer.from('<!doctype html><html><body><h1>Robust</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;
let deckId: string;
let secret: string;

let ipCounter = 0;
const nextIp = () => `10.87.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = { k: value };
  return value;
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'input_robust'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Robust', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);

  // Invite + accept a plain member (the PATCH target).
  const inv = await readJson(
    await app.app.request('/api/v1/invitations', json({ email: MEMBER.email, role: 'member' }, { cookie }))
  );
  const token = (inv.acceptUrl as string).split('/invite/')[1]!;
  const accepted = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token, name: MEMBER.name, password: MEMBER.password })
  );
  expect(accepted.status).toBe(200);

  // One deck with one committed version, and one default share token
  // (annotations + form submissions both enabled).
  const form = new FormData();
  form.set('sha256', shaOf(HTML));
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const uploaded = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie },
    body: form
  });
  expect(uploaded.status).toBe(201);
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
  );
  deckId = reserve.uploadSession.presentationId;
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title: 'Robust Deck',
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', sha256: shaOf(HTML), sizeBytes: HTML.length, contentType: 'text/html' }
        ]
      },
      { cookie }
    )
  );
  expect(commit.status).toBe(201);
  const tokenRes = await readJson(
    await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'Robust reviewer', canAnnotate: true }, { cookie })
    )
  );
  secret = tokenRes.secret;
  expect(typeof secret).toBe('string');
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the Better Auth mount guard (AF-1)', () => {
  it('malformed JSON on an auth route answers 400 invalid_json, never a Better Auth 500', async () => {
    const res = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: '{broken'
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_json');
  });

  it('an empty body under a JSON content-type answers 400 invalid_json', async () => {
    const res = await app.app.request('/api/v1/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: ''
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('invalid_json');
  });

  it("a NUL in update-user's free-text name answers 400 invalid_characters (was a 22021 500)", async () => {
    const bad = await app.app.request(
      '/api/v1/auth/update-user',
      json({ name: 'Evil\u0000Name' }, { cookie })
    );
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.code).toBe('invalid_characters');
    // Negative control: the same request without the NUL succeeds.
    const ok = await app.app.request('/api/v1/auth/update-user', json({ name: 'Clean Name' }, { cookie }));
    expect(ok.status).toBe(200);
  });
});

describe('member PATCH (FUZZ-5)', () => {
  it('an empty patch answers 400 validation_error instead of an empty SQL SET 500', async () => {
    const members = await readJson(await app.app.request('/api/v1/members', { headers: { cookie } }));
    const member = members.members.find((m: { email: string }) => m.email === MEMBER.email);
    expect(member).toBeTruthy();
    const empty = await app.app.request(`/api/v1/members/${member.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({})
    });
    expect(empty.status).toBe(400);
    expect((await readJson(empty)).error.code).toBe('validation_error');
    // Negative control: a one-field patch still works.
    const ok = await app.app.request(`/api/v1/members/${member.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ role: 'admin' })
    });
    expect(ok.status).toBe(200);
  });
});

describe('version params (FUZZ-9)', () => {
  it('int4-overflowing and non-digit versions answer 400, a real one 200', async () => {
    for (const v of ['99999999999999999999', '1e5', 'abc', '2147483648']) {
      const res = await app.app.request(`/api/v1/presentations/${deckId}/versions/${v}`, {
        headers: { cookie }
      });
      expect(res.status, v).toBe(400);
      expect((await readJson(res)).error.code, v).toBe('validation_error');
    }
    const ok = await app.app.request(`/api/v1/presentations/${deckId}/versions/1`, {
      headers: { cookie }
    });
    expect(ok.status).toBe(200);
  });
});

describe('anonymous viewer surfaces (SL-B4)', () => {
  it('a NUL inside the annotation selection answers 400, a clean one 201', async () => {
    const post = (body: unknown) =>
      app.app.request(`/api/v1/viewer/${secret}/annotations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
        body: JSON.stringify(body)
      });
    const bad = await post({ body: 'note', selection: { anchor: 'x\u0000y' } });
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.code).toBe('validation_error');
    const ok = await post({ body: 'note', selection: { anchor: 'clean' } });
    expect(ok.status).toBe(201);
  });

  it('a deep annotation selection is refused at the schema even under text/plain (edge cap bypass)', async () => {
    // The route parses with c.req.json(), which ignores Content-Type, so the
    // JSON-typed edge depth cap does not see a text/plain body. The schema's
    // own depth cap must catch it, or the handler's JSON.stringify byte-cap
    // blows the stack on the shipped image (SL-B5, verifier V4).
    const post = (ct: string) =>
      app.app.request(`/api/v1/viewer/${secret}/annotations`, {
        method: 'POST',
        headers: { 'content-type': ct, origin: 'null', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({ body: 'note', selection: nested(60) })
      });
    for (const ct of ['application/json', 'text/plain', 'application/x-www-form-urlencoded']) {
      const res = await post(ct);
      expect(res.status, ct).toBe(400);
      expect((await readJson(res)).error.code, ct).toBe('validation_error');
    }
  });

  it('a NUL inside a form payload answers 400, a clean one 201', async () => {
    const post = (payload: unknown) =>
      app.app.request(`/api/v1/viewer/${secret}/forms/rsvp/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({ payload })
      });
    const badValue = await post({ field: 'x\u0000' });
    expect(badValue.status).toBe(400);
    expect((await readJson(badValue)).error.code).toBe('validation_error');
    const badKey = await post({ ['f\u0000']: 'x' });
    expect(badKey.status).toBe(400);
    const ok = await post({ field: 'clean' });
    expect(ok.status).toBe(201);
  });
});

describe('the responses placement read filter (SL-B4)', () => {
  it('a NUL in the placement query answers 400 validation_error, not a 22021 500', async () => {
    const res = await app.app.request(`/api/v1/presentations/${deckId}/responses?placement=%00x`, {
      headers: { cookie }
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('validation_error');
  });
});

describe('deck metadata depth (SL-B5)', () => {
  it('past the contract cap answers validation_error; past the edge cap, payload_too_deep', async () => {
    const overContract = await app.app.request(`/api/v1/presentations/${deckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ metadata: nested(40) })
    });
    expect(overContract.status).toBe(400);
    expect((await readJson(overContract)).error.code).toBe('validation_error');

    const overEdge = await app.app.request(`/api/v1/presentations/${deckId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ metadata: nested(150) })
    });
    expect(overEdge.status).toBe(400);
    expect((await readJson(overEdge)).error.code).toBe('payload_too_deep');
  });
});

describe('manifest contentType (PLT-5)', () => {
  it('a non-media-type contentType is refused at commit — versions are immutable, so the gate is the fix', async () => {
    const reserve = await readJson(
      await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
    );
    const res = await app.app.request(
      `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
      json(
        {
          title: 'Evil CT',
          entryPath: 'index.html',
          manifest: [
            {
              path: 'index.html',
              sha256: shaOf(HTML),
              sizeBytes: HTML.length,
              contentType: 'text/héml'
            }
          ]
        },
        { cookie }
      )
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('validation_error');
    expect(JSON.stringify(body.error.details)).toContain('contentType');
  });
});
