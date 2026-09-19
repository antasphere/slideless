import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { auditLog } from '@antasphere/chassis-db';
import { formResponseFiles } from '@slideless/db';
import {
  SETUP_TOKEN,
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * PRDCT-2529 — the HAND-OVERS of the Slideless tool definition (`src/tool.ts`)
 * to the chassis composition (`createPlatform(tool)`), each pinned through the
 * REAL boot. Every behaviour below already has a test of its own body (the
 * audit predicate, `trustedOriginsFor`, the purge statement); what none of
 * them could see is `tool.ts` no longer handing the thing over, because they
 * pass it in by hand. These tests only ever reach it through `boot()`:
 *
 *  - `api.auditExempt`: a viewer write by a visitor who also holds a session
 *    lands no audit row, and no audit row carries the share secret;
 *  - `api.untrustedOrigins`: the viewer origin is refused EVEN AS THE SERVING
 *    ORIGIN by the identity layer the composition booted;
 *  - `api.rateLimits`: the invitation-accept wall stands on both public
 *    collaborator paths;
 *  - `jobs` + the lazy domain cell: the three deck queues exist, and a job
 *    SENT to the form-upload purge queue (what the nightly schedule does)
 *    purges through the booted service.
 */

const APP = 'http://localhost:3000';
const VIEWER = 'http://decks.test';
/** Any other hostname a proxy or a preview may serve the app on: trusted as the serving origin. */
const PREVIEW = 'http://preview.test';
const OWNER = { email: 'owner@slots.test', name: 'Slots Owner', password: 'slots-owner-password-123' };

const HTML = Buffer.from(
  '<!doctype html><html><head><title>Slots</title></head><body>' +
    '<form data-slideless-form="rsvp"><input name="name">' +
    '<input type="file" name="docs"></form></body></html>'
);
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface Fixture {
  app: TestApp;
  cookie: string;
  deckId: string;
  secret: string;
}

let container: StartedPostgreSqlContainer;
let plain: Fixture;
let split: Fixture;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

async function bootFixture(dbName: string, extraEnv: Record<string, string>): Promise<Fixture> {
  const app = await createTestApp(await createDatabase(container, dbName), extraEnv);
  const setup = await app.app.request(
    `${APP}/api/v1/setup`,
    json({ setupToken: SETUP_TOKEN, instanceName: 'Slots', owner: OWNER })
  );
  expect(setup.status).toBeLessThan(300);
  const signIn = await app.app.request(
    `${APP}/api/v1/auth/sign-in/email`,
    json({ email: OWNER.email, password: OWNER.password })
  );
  expect(signIn.status).toBe(200);
  const cookie = extractCookie(signIn);

  const form = new FormData();
  form.set('sha256', shaOf(HTML));
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const asset = await app.app.request(`${APP}/api/v1/presentations/assets`, {
    method: 'POST',
    headers: { cookie },
    body: form
  });
  expect(asset.status).toBe(201);
  const reserve = await readJson(
    await app.app.request(`${APP}/api/v1/presentations/uploads`, { method: 'POST', headers: { cookie } })
  );
  const deckId: string = reserve.uploadSession.presentationId;
  const commit = await app.app.request(
    `${APP}/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title: 'Slots Deck',
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', sha256: shaOf(HTML), sizeBytes: HTML.length, contentType: 'text/html' }
        ]
      },
      { cookie }
    )
  );
  expect(commit.status).toBe(201);
  const minted = await readJson(
    await app.app.request(
      `${APP}/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'Slots link', remembersResponses: false }, { cookie })
    )
  );
  expect(typeof minted.secret).toBe('string');
  return { app, cookie, deckId, secret: minted.secret };
}

beforeAll(async () => {
  container = await startPostgres();
  plain = await bootFixture('tool_slots_plain', {});
  split = await bootFixture('tool_slots_split', { VIEWER_BASE_URL: VIEWER });
}, 240_000);

afterAll(async () => {
  await plain?.app.stop();
  await split?.app.stop();
  await container?.stop();
});

// ── api.auditExempt (verifier F1 / M6) ──────────────────────────────────────

describe('tool.api.auditExempt reaches the booted audit middleware', () => {
  it('a viewer write by a visitor who ALSO holds a session lands no audit row, and no row carries the share secret', async () => {
    const { app, cookie, secret } = plain;
    const before = await app.db.db.select().from(auditLog);

    // The premise: on this very path the session cookie DOES resolve a
    // principal, so without the exemption the middleware would write its
    // fallback row, whose action is `method + path` (the secret included).
    const res = await app.app.request(`${APP}/api/v1/viewer/${secret}/forms/rsvp/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'null',
        cookie,
        'x-forwarded-for': '10.61.0.1'
      },
      body: JSON.stringify({ payload: { name: 'a signed-in visitor' } })
    });
    expect(res.status).toBe(201);

    const after = await app.db.db.select().from(auditLog);
    expect(after.length).toBe(before.length);
    expect(after.filter((row) => row.action.includes('/api/v1/viewer/'))).toHaveLength(0);
    expect(JSON.stringify(after)).not.toContain(secret);

    // The control: the same session's write on an audited path DOES land a
    // row, so the silence above is the exemption and not a dead middleware.
    const mint = await app.app.request(
      `${APP}/api/v1/presentations/${plain.deckId}/tokens`,
      json({ name: 'audited' }, { cookie })
    );
    expect(mint.status).toBe(201);
    expect((await app.db.db.select().from(auditLog)).length).toBeGreaterThan(after.length);
  });
});

// ── api.untrustedOrigins (verifier F2 / M7) ─────────────────────────────────

/**
 * The serving-origin case, and why it is pinned on `BootResult.auth`.
 *
 * Through the root app it cannot be reached: the host gate answers 404 on the
 * viewer hostname for everything but `/v/*`, `/api/v1/viewer/*` (exempt from
 * the cross-site guard by design) and the probes, and the gate and the guard
 * both derive the host from the same request URL, so no request is "served on
 * the viewer origin" for the guard without being the viewer host for the gate.
 * A request whose Origin is the viewer origin on ANY OTHER host is refused by
 * the generic different-origin rule, slot or no slot (which is why
 * `viewer-origin.test.ts` stays green with the slot emptied).
 *
 * So the second lock is pinned where the booted composition exposes it: the
 * Better Auth instance `boot()` built from `tool.api.untrustedOrigins`, driven
 * with requests ADDRESSED TO the viewer origin (what a proxy routing the
 * viewer hostname at the app, past a regressed gate, would deliver). On any
 * other hostname the serving origin is trusted; on the viewer origin it is
 * not.
 *
 * Two things are pinned: the sign-in (our own before-hook, which runs in
 * every environment), and the EFFECTIVE trusted-origins list of the booted
 * instance. The list stands in for the cookie-authenticated write: Better
 * Auth's own origin check is what reads it for a cookie-bearing unsafe
 * request, and Better Auth switches that check off when NODE_ENV is `test`
 * (`skipOriginCheck`, create-context), so its refusal cannot be observed
 * here; the list it would consult can. The API app's cross-site guard
 * receives the same `untrustedOrigins` constant of `boot.ts` as its
 * `deniedOrigins`; its serving-origin arm is pinned on the guard itself
 * (`cross-site.test.ts`) and is not reachable from the booted app.
 */
describe('tool.api.untrustedOrigins reaches the booted identity layer: the viewer origin is refused even as the serving origin', () => {
  const trustedOriginsOf = async (app: TestApp, servedOn: string): Promise<string[]> => {
    const configured = app.auth.options.trustedOrigins;
    expect(typeof configured).toBe('function');
    if (typeof configured !== 'function') throw new Error('trustedOrigins is not the per-request function');
    return configured(new Request(`${servedOn}/api/v1/auth/get-session`));
  };

  const signInServedOn = (app: TestApp, servedOn: string) =>
    app.auth.handler(
      new Request(`${servedOn}/api/v1/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: servedOn, 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
      })
    );

  it('the effective trusted origins never contain the viewer origin, served on it or not', async () => {
    expect(await trustedOriginsOf(split.app, VIEWER)).toEqual([APP]);
    expect(await trustedOriginsOf(split.app, APP)).not.toContain(VIEWER);
    // The serving-origin trust itself is alive: any other hostname is trusted as served.
    expect(await trustedOriginsOf(split.app, PREVIEW)).toContain(PREVIEW);
    // Unset, nothing is installed: that hostname is an ordinary serving origin.
    expect(await trustedOriginsOf(plain.app, VIEWER)).toContain(VIEWER);
  });

  it('a sign-in served on the viewer origin, carrying it as its same-origin Origin, mints no session', async () => {
    const refused = await signInServedOn(split.app, VIEWER);
    expect(refused.status).toBe(403);
    expect(refused.headers.get('set-cookie')).toBeNull();
    // The same request served on any other hostname signs in: only the explicit denial refused.
    const ok = await signInServedOn(split.app, PREVIEW);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).not.toBeNull();
  });
});

// ── api.rateLimits (verifier F3 / M12) ──────────────────────────────────────

describe('tool.api.rateLimits: the invitation-accept wall stands on the public collaborator paths', () => {
  /** Hammer one forwarded address past the 10/h bucket; the wall answers before the handler. */
  const hammer = async (address: string, request: () => RequestInit & { path: string }) => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const { path, ...init } = request();
      const res = await plain.app.app.request(`${APP}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), 'x-forwarded-for': address }
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' } });
        break;
      }
    }
    return statuses;
  };

  it('POST /api/v1/collaborators/claim answers 429 once one address has spent the bucket', async () => {
    const statuses = await hammer('10.62.0.1', () => ({
      path: '/api/v1/collaborators/claim',
      ...json({ token: 'x'.repeat(43), name: 'Nobody', password: 'x'.repeat(16) })
    }));
    expect(statuses.at(-1)).toBe(429);
    // Before the wall, the handler answered (an unknown token), never the wall.
    expect(statuses.slice(0, -1).every((s) => s === 404)).toBe(true);
    expect(statuses.length).toBeGreaterThan(5);
  });

  it('GET /api/v1/collaborators/lookup answers 429 once one address has spent the bucket', async () => {
    const statuses = await hammer('10.62.0.2', () => ({
      path: `/api/v1/collaborators/lookup?token=${'x'.repeat(43)}`,
      method: 'GET',
      headers: {}
    }));
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((s) => s === 404)).toBe(true);
    expect(statuses.length).toBeGreaterThan(5);
  });
});

// ── jobs + the lazy domain cell (verifier F4 / M13, M15) ────────────────────

describe('tool.jobs: the deck queues are declared, and the purge job runs through the booted domain', () => {
  it('the three deck queues exist after boot', async () => {
    const queues = (await plain.app.jobs.boss.getQueues()).map((q) => q.name);
    expect(queues).toEqual(
      expect.arrayContaining(['upload-session-purge', 'form-upload-purge', 'view-events-purge'])
    );
  });

  it('the two unconditional deck purges are scheduled nightly', async () => {
    const schedules = (await plain.app.jobs.boss.getSchedules()).map((s) => s.name);
    expect(schedules).toEqual(expect.arrayContaining(['upload-session-purge', 'form-upload-purge']));
  });

  it('a job sent to form-upload-purge (what the schedule does) removes an unattached upload through the lazy cell', async () => {
    const { app, secret } = plain;
    const bytes = new Uint8Array(16).fill(7);
    const qs = new URLSearchParams({ field: 'docs', name: 'stale.pdf', type: 'application/pdf' });
    const uploadOne = async (name: string) => {
      qs.set('name', name);
      const res = await app.app.request(
        `${APP}/api/v1/viewer/${secret}/forms/rsvp/uploads?${qs.toString()}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
            origin: 'null',
            'x-forwarded-for': '10.63.0.1'
          },
          body: bytes
        }
      );
      expect(res.status).toBe(201);
      return (await readJson(res)).file.id as string;
    };
    const stale = await uploadOne('stale.pdf');
    const fresh = await uploadOne('fresh.pdf');
    await app.db.db
      .update(formResponseFiles)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(formResponseFiles.id, stale));

    // No service is called here: the job goes on the queue the tool declared,
    // and the poller `createJobs` registered for it runs the tool's handler,
    // which reads `formUploads` through `getTool()` at run time.
    const jobId = await app.jobs.boss.send('form-upload-purge', {});
    expect(jobId).toBeTruthy();

    const rowsOf = (id: string) =>
      app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, id));
    const deadline = Date.now() + 25_000;
    while ((await rowsOf(stale)).length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(await rowsOf(stale)).toHaveLength(0);
    expect(await rowsOf(fresh)).toHaveLength(1);
  }, 40_000);
});
