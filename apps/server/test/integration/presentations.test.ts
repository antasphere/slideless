import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import {
  annotations,
  collaborators,
  presentations,
  presentationVersions,
  shareTokens,
  uploadSessions
} from '@slideless/db';
import { createDatabase, createTestApp, extractCookie, readJson, startPostgres, type TestApp } from './helpers.js';

/**
 * Presentation domain, Phase 2 (ADR 011): the SCHEMA and the CONTRACT
 * SURFACE. This suite proves (1) migration 0013's tables round-trip through
 * drizzle with their constraints live, and (2) the fail-closed scope
 * allowlist consciously opened the /presentations tree to machine principals
 * (reachable — never 403) with reads and writes split across the two scopes.
 * Phase 3 made upload/versioning/pull LIVE (200/201 below); Phases 4–5
 * (sharing, collaboration) still answer their contract-declared 501s. The
 * upload pipeline itself is covered in presentations-upload.test.ts.
 */

const OWNER = { email: 'owner@decks.test', name: 'Deck Owner', password: 'deck-owner-password-1' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;
let workspaceId: string;
let ownerUserId: string;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'presentations_phase2'));
  const setup = await readJson(
    await app.app.request('/api/v1/setup', json({ instanceName: 'Decks', owner: OWNER }))
  );
  workspaceId = setup.workspaceId;
  ownerUserId = setup.ownerUserId;
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);
});

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('schema round-trip (migration 0013)', () => {
  let presentationId: string;

  it('inserts and reads back a presentation with its defaults', async () => {
    const [deck] = await app.db.db
      .insert(presentations)
      .values({ workspaceId, ownerUserId, title: 'Q3 Board Deck' })
      .returning();
    presentationId = deck!.id;

    const [read] = await app.db.db
      .select()
      .from(presentations)
      .where(eq(presentations.id, presentationId));
    expect(read).toMatchObject({
      title: 'Q3 Board Deck',
      kind: 'presentation',
      interactive: false,
      currentVersion: 0,
      entryPath: 'index.html',
      remixedFrom: null,
      deletedAt: null
    });
  });

  it('stores an immutable version with a jsonb manifest, unique per (deck, version)', async () => {
    const manifest = [
      { path: 'index.html', sha256: 'a'.repeat(64), sizeBytes: 120, contentType: 'text/html' }
    ];
    await app.db.db.insert(presentationVersions).values({
      workspaceId,
      presentationId,
      version: 1,
      entryPath: 'index.html',
      manifest,
      sizeBytes: 120,
      fileCount: 1,
      createdBy: ownerUserId
    });

    const [row] = await app.db.db
      .select()
      .from(presentationVersions)
      .where(eq(presentationVersions.presentationId, presentationId));
    expect(row!.manifest).toEqual(manifest);
    expect(row!.createdByRole).toBe('owner');

    // The append-only guarantee rides this constraint. Drizzle wraps the pg
    // error ("Failed query: ..."), so assert on the cause's constraint name.
    const dup: unknown = await app.db.db
      .insert(presentationVersions)
      .values({
        workspaceId,
        presentationId,
        version: 1,
        entryPath: 'index.html',
        manifest,
        sizeBytes: 120,
        fileCount: 1
      })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(dup).toBeInstanceOf(Error);
    const cause = (dup as Error).cause as { code?: string; constraint?: string };
    expect(cause.code).toBe('23505'); // unique_violation
    expect(cause.constraint).toBe('presentation_versions_presentation_version_uniq');
  });

  it('inserts and reads back a share token (hash only, new expiry/password columns)', async () => {
    const [token] = await app.db.db
      .insert(shareTokens)
      .values({
        workspaceId,
        presentationId,
        name: 'Alice — investor',
        tokenHash: 'b'.repeat(64),
        canAnnotate: true,
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        createdBy: ownerUserId
      })
      .returning();

    const [read] = await app.db.db.select().from(shareTokens).where(eq(shareTokens.id, token!.id));
    expect(read).toMatchObject({
      name: 'Alice — investor',
      pinnedVersion: null, // latest
      canAnnotate: true,
      passwordHash: null,
      revokedAt: null,
      accessCount: 0
    });
    expect(read!.expiresAt?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('round-trips the remaining domain tables (collaborator, annotation, upload session)', async () => {
    const [grant] = await app.db.db
      .insert(collaborators)
      .values({
        workspaceId,
        presentationId,
        email: 'dev@agency.test',
        invitedBy: ownerUserId,
        claimTokenHash: 'c'.repeat(64),
        claimExpiresAt: new Date(Date.now() + 86_400_000)
      })
      .returning();
    expect(grant).toMatchObject({ status: 'pending', role: 'dev', userId: null });

    const [note] = await app.db.db
      .insert(annotations)
      .values({
        workspaceId,
        presentationId,
        version: 1,
        authorName: 'Anonymous reviewer',
        selection: { slide: 2, rect: [0, 0, 1, 1] },
        body: 'Typo on the title slide'
      })
      .returning();
    expect(note).toMatchObject({ status: 'open', shareTokenId: null, authorUserId: null });
    expect(note!.selection).toEqual({ slide: 2, rect: [0, 0, 1, 1] });

    const [session] = await app.db.db
      .insert(uploadSessions)
      .values({
        workspaceId,
        presentationId: crypto.randomUUID(), // reservation — deliberately no FK
        createdBy: ownerUserId,
        expiresAt: new Date(Date.now() + 3_600_000)
      })
      .returning();
    expect(session!.consumedAt).toBeNull();
  });
});

describe('contract surface + fail-closed scope allowlist', () => {
  let readWriteKey: string;
  let readOnlyKey: string;

  beforeAll(async () => {
    const mint = async (name: string, scopes: string[]) =>
      (
        await readJson(
          await app.app.request(
            '/api/v1/api-keys',
            json({ name, scopes }, { cookie })
          )
        )
      ).key as string;
    readWriteKey = await mint('rw', ['presentations:read', 'presentations:write']);
    readOnlyKey = await mint('ro', ['presentations:read']);
  });

  it('sessions reach the live surface (200 — never 404)', async () => {
    const res = await app.app.request('/api/v1/presentations', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(Array.isArray(body.presentations)).toBe(true);
  });

  it('an API key with presentations:read reaches reads (never 403)', async () => {
    const live = await app.app.request('/api/v1/presentations', {
      headers: { authorization: `Bearer ${readOnlyKey}` }
    });
    expect(live.status).toBe(200);
    // Annotations arrive in Phase 5 — reachable, answering the contract 501.
    const stub = await app.app.request('/api/v1/annotations', {
      headers: { authorization: `Bearer ${readOnlyKey}` }
    });
    expect(stub.status).toBe(501);
    expect((await readJson(stub)).error.code).toBe('not_implemented');
  });

  it('mutations need presentations:write (read-only key 403s, write key reaches the handler)', async () => {
    const denied = await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { authorization: `Bearer ${readOnlyKey}` }
    });
    expect(denied.status).toBe(403);
    expect((await readJson(denied)).error.code).toBe('insufficient_scope');

    const allowed = await app.app.request('/api/v1/presentations/uploads', {
      method: 'POST',
      headers: { authorization: `Bearer ${readWriteKey}` }
    });
    expect(allowed.status).toBe(201);
    expect((await readJson(allowed)).uploadSession.presentationId).toBeDefined();
  });

  it('the annotation inbox stays fail-closed for mutations (unlisted method 403s)', async () => {
    const res = await app.app.request('/api/v1/annotations', {
      method: 'POST',
      headers: { authorization: `Bearer ${readWriteKey}`, 'content-type': 'application/json' },
      body: '{}'
    });
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('endpoint_not_allowed');
  });

  it('publishes every presentation-domain route in the OpenAPI document', async () => {
    const doc = await readJson(await app.app.request('/api/v1/openapi.json'));
    for (const path of [
      '/presentations',
      '/presentations/{id}',
      '/presentations/uploads',
      '/presentations/precheck',
      '/presentations/assets',
      '/presentations/uploads/{id}/commit',
      '/presentations/{id}/versions',
      '/presentations/{id}/versions/{version}',
      '/presentations/{id}/assets/{sha256}',
      '/presentations/{id}/tokens',
      '/presentations/{id}/tokens/{tokenId}',
      '/presentations/{id}/tokens/{tokenId}/send',
      '/presentations/{id}/collaborators',
      '/presentations/{id}/collaborators/{collaboratorId}',
      '/presentations/{id}/annotations',
      '/presentations/{id}/annotations/{annotationId}',
      '/annotations'
    ]) {
      expect(doc.paths[path], path).toBeDefined();
    }
  });
});
