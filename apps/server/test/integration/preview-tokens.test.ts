import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { PREVIEW_SHARE_TOKEN_NAME } from '@slideless/contract';
import { presentations, shareTokens } from '@slideless/db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/** An HTML Accept: the deck, not the agent index (PRDCT-2670). */
const DOC_NAV = { accept: 'text/html' };

/**
 * Release-gate regression — the reserved-name share-token concealment fix.
 *
 * BEFORE: "preview" was keyed on the client-controlled token NAME
 * ("Dashboard preview"): the dashboard hid such tokens from the sharing
 * panel and the viewer excluded them from view counts. Any deck WRITER — a
 * dev collaborator included — could therefore mint a fully working share
 * link that was invisible in the owner's dashboard and silent in stats: a
 * covert access channel surviving the collaborator's own revocation.
 *
 * NOW: 'preview' is a SERVER-SET `purpose` column. The public token-create
 * endpoint always mints visible, counted 'share' tokens whatever the name;
 * preview tokens exist only through the dedicated owner/admin-gated
 * endpoint, are 1 h-lived and immutable. This suite pins each property.
 */

const OWNER = { email: 'owner@preview.test', name: 'Preview Owner', password: 'preview-owner-pass-1' };
const DEV = { email: 'dev@preview.test', name: 'Dev Collaborator', password: 'preview-dev-pass-1' };
const MEMBER = { email: 'member@preview.test', name: 'Plain Member', password: 'preview-member-pass-1' };

const HTML_V1 = Buffer.from('<!doctype html><html><body><h1>Preview deck v1</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let container: StartedPostgreSqlContainer;
let app: TestApp;
let mail: RecordingEmailDriver;
let ownerCookie: string;
let devCookie: string;
let memberCookie: string;
let deckId: string;

// Public token-redemption routes ride tight per-IP walls; TRUST_PROXY=true
// in tests, so every request carries a fresh forwarded address.
let ipCounter = 0;
const nextIp = () => `10.98.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function totalViewsOf(id: string): Promise<number> {
  const [row] = await app.db.db
    .select({ totalViews: presentations.totalViews })
    .from(presentations)
    .where(eq(presentations.id, id));
  return row!.totalViews;
}

async function ownerTokenList() {
  const res = await app.app.request(`/api/v1/presentations/${deckId}/tokens?limit=100`, {
    headers: { cookie: ownerCookie }
  });
  expect(res.status).toBe(200);
  return readJson(res);
}

beforeAll(async () => {
  container = await startPostgres();
  mail = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'preview_tokens'), {}, { email: mail });
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Preview', owner: OWNER })
  );
  ownerCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );

  // Author a one-version deck.
  const form = new FormData();
  form.set('sha256', shaOf(HTML_V1));
  form.set('file', new Blob([new Uint8Array(HTML_V1)], { type: 'text/html' }), 'index.html');
  const upload = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie: ownerCookie },
    body: form
  });
  expect(upload.status).toBe(201);
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { cookie: ownerCookie }
    })
  );
  deckId = reserve.uploadSession.presentationId;
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title: 'Preview Deck',
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', sha256: shaOf(HTML_V1), sizeBytes: HTML_V1.length, contentType: 'text/html' }
        ]
      },
      { cookie: ownerCookie }
    )
  );
  expect(commit.status).toBe(201);

  // A dev collaborator on the deck (invite → email-token claim → sign-in).
  const invite = await app.app.request(
    `/api/v1/presentations/${deckId}/collaborators`,
    json({ email: DEV.email }, { cookie: ownerCookie })
  );
  expect(invite.status).toBe(201);
  const inviteMail = mail.sent.find((m) => m.to === DEV.email);
  const emailToken = /\/collab\/([A-Za-z0-9_-]+)/.exec(inviteMail!.text ?? '')![1]!;
  const claim = await app.app.request(
    '/api/v1/collaborators/claim',
    json({ token: emailToken, name: DEV.name, password: DEV.password })
  );
  expect(claim.status).toBe(200);
  devCookie = extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', json({ email: DEV.email, password: DEV.password }))
  );

  // A plain workspace member with NO grant on the deck.
  const memberInvite = await app.app.request(
    '/api/v1/invitations',
    json({ email: MEMBER.email, role: 'member' }, { cookie: ownerCookie })
  );
  expect(memberInvite.status).toBe(201);
  const acceptToken = ((await readJson(memberInvite)).acceptUrl as string).split('/invite/')[1]!;
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: acceptToken, name: MEMBER.name, password: MEMBER.password })
  );
  expect(accept.status).toBe(200);
  memberCookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: MEMBER.email, password: MEMBER.password })
    )
  );
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the covert channel is closed', () => {
  it('a dev collaborator naming a token "Dashboard preview" gets a NORMAL token: visible to the owner AND counted', async () => {
    const create = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: PREVIEW_SHARE_TOKEN_NAME }, { cookie: devCookie })
    );
    expect(create.status).toBe(201);
    const created = await readJson(create);
    // The server refuses to derive anything from the name: purpose 'share'.
    expect(created.shareToken.purpose).toBe('share');
    expect(created.shareToken.name).toBe(PREVIEW_SHARE_TOKEN_NAME);

    // VISIBLE: the owner's token list carries it, purpose 'share' — the
    // dashboard's panel filter (keyed on purpose) will show it.
    const listed = await ownerTokenList();
    const row = listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id);
    expect(row).toBeDefined();
    expect(row.purpose).toBe('share');

    // COUNTED: opening the viewer entry bumps the token AND deck counters.
    const before = await totalViewsOf(deckId);
    expect((await app.app.request(`/v/${created.secret}/`, { headers: DOC_NAV })).status).toBe(200);
    expect(await totalViewsOf(deckId)).toBe(before + 1);
    const after = await ownerTokenList();
    expect(after.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id).accessCount).toBe(1);
  });

  it('a dev collaborator CANNOT mint a preview-marked token (403, nothing persisted)', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/preview-token`,
      json({}, { cookie: devCookie })
    );
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('forbidden');
    const previews = await app.db.db.select().from(shareTokens).where(eq(shareTokens.purpose, 'preview'));
    expect(previews).toHaveLength(0);
  });

  it('a plain member cannot mint one either (404 — the deck is not even confirmed)', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/preview-token`,
      json({}, { cookie: memberCookie })
    );
    // The member holds no grant on the deck, so unlike the dev above they
    // get the AUTH-5 404 (PRDCT-1393), not a 403 that proves the deck id.
    expect(res.status).toBe(404);
  });

  it('the public create endpoint strips a smuggled purpose field', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'Sneaky', purpose: 'preview' }, { cookie: devCookie })
    );
    expect(res.status).toBe(201);
    expect((await readJson(res)).shareToken.purpose).toBe('share');
  });
});

describe('the owner preview path still works', () => {
  it('owner mints a preview token: purpose preview, ~1 h expiry, renders WITHOUT counting', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/preview-token`,
      json({}, { cookie: ownerCookie })
    );
    expect(res.status).toBe(201);
    const created = await readJson(res);
    expect(created.shareToken).toMatchObject({
      purpose: 'preview',
      name: PREVIEW_SHARE_TOKEN_NAME,
      versionMode: 'latest',
      canAnnotate: false,
      hasPassword: false
    });
    // Server-fixed 1 h TTL (give the assertion a minute of slack).
    const ttl = new Date(created.shareToken.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(55 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000);

    const before = await totalViewsOf(deckId);
    const served = await app.app.request(`/v/${created.secret}/`, { headers: DOC_NAV });
    expect(served.status).toBe(200); // the iframe still renders…
    expect(await served.text()).toContain('Preview deck v1');
    expect(await totalViewsOf(deckId)).toBe(before); // …and never counts

    // The wire exposes purpose so the dashboard panel can hide it.
    const listed = await ownerTokenList();
    const row = listed.shareTokens.find((t: { id: string }) => t.id === created.shareToken.id);
    expect(row.purpose).toBe('preview');
    expect(row.accessCount).toBe(0);
  });

  it('pins a version when asked; a missing version 400s', async () => {
    const pinned = await app.app.request(
      `/api/v1/presentations/${deckId}/preview-token`,
      json({ version: 1 }, { cookie: ownerCookie })
    );
    expect(pinned.status).toBe(201);
    expect((await readJson(pinned)).shareToken).toMatchObject({ versionMode: 'pinned', pinnedVersion: 1 });

    const missing = await app.app.request(
      `/api/v1/presentations/${deckId}/preview-token`,
      json({ version: 99 }, { cookie: ownerCookie })
    );
    expect(missing.status).toBe(400);
    expect((await readJson(missing)).error.code).toBe('invalid_version');
  });

  it('preview tokens are IMMUTABLE: no patch, no send; revoke is owner/admin only', async () => {
    const created = await readJson(
      await app.app.request(
        `/api/v1/presentations/${deckId}/preview-token`,
        json({}, { cookie: ownerCookie })
      )
    );
    const tokenPath = `/api/v1/presentations/${deckId}/tokens/${created.shareToken.id}`;

    // No patch — above all no expiry extension (that would stretch a hidden,
    // stat-excluded token beyond its 1 h life). Even the owner is refused.
    const patch = await app.app.request(tokenPath, {
      ...json({ expiresAt: null }, { cookie: ownerCookie }),
      method: 'PATCH'
    });
    expect(patch.status).toBe(400);
    expect((await readJson(patch)).error.code).toBe('preview_token_immutable');

    // No send — a send rotates the secret and mails it out: a working
    // concealed link in the recipient's inbox.
    const send = await app.app.request(
      `${tokenPath}/send`,
      json({ email: 'accomplice@preview.test' }, { cookie: ownerCookie })
    );
    expect(send.status).toBe(400);
    expect((await readJson(send)).error.code).toBe('preview_token_immutable');

    // A dev collaborator cannot revoke the owner's preview plumbing…
    const devRevoke = await app.app.request(tokenPath, {
      method: 'DELETE',
      headers: { cookie: devCookie, 'x-forwarded-for': nextIp() }
    });
    expect(devRevoke.status).toBe(403);

    // …the owner can (the dashboard revokes on page exit).
    const ownerRevoke = await app.app.request(tokenPath, {
      method: 'DELETE',
      headers: { cookie: ownerCookie, 'x-forwarded-for': nextIp() }
    });
    expect(ownerRevoke.status).toBe(200);
    expect((await readJson(ownerRevoke)).revokedAt).not.toBeNull();
    expect((await app.app.request(`/v/${created.secret}/`, { headers: DOC_NAV })).status).toBe(403);
  });
});
