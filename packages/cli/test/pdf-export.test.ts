import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { DECK, routedHarness, type Route } from './harness.js';

/**
 * PRDCT-2668 at the terminal: the per-link PDF export switch
 * (`share --no-pdf`, `share-email --no-pdf`, `pdf --on|--off`) and what
 * `tokens` shows of it, beside the agent-read counter (PRDCT-2670).
 * Mirrors the upload switch's tests in form-files.test.ts.
 */

const AUTH = ['--url', 'http://x', '--api-key', 'slk_k_s'];

const TOKEN = {
  id: '44444444-4444-4444-4444-444444444444',
  presentationId: DECK.id,
  name: 'cli',
  purpose: 'share',
  versionMode: 'latest',
  pinnedVersion: null,
  canAnnotate: false,
  canSubmitForms: true,
  canDownload: true,
  showBar: true,
  remembersResponses: false,
  canUploadFiles: true,
  canExportPdf: true,
  badgePosition: null,
  expiresAt: null,
  hasPassword: false,
  revokedAt: null,
  accessCount: 2,
  lastAccessedAt: null,
  downloadCount: 0,
  agentReadCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const createRoute: Route = {
  method: 'POST',
  path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
  reply: ({ body }) => {
    const b = body as { name: string; canExportPdf?: boolean };
    return {
      status: 201,
      body: {
        shareToken: { ...TOKEN, name: b.name, canExportPdf: b.canExportPdf ?? true },
        secret: 's3cret',
        url: 'http://x/v/s3cret/'
      }
    };
  }
};

describe('share --no-pdf: the per-link PDF export switch', () => {
  it('sends canExportPdf true by default and false with --no-pdf, and says so', async () => {
    const on = routedHarness([createRoute]);
    expect(await run(['share', DECK.id, ...AUTH], on.io)).toBe(0);
    expect(on.calls[0]?.body).toMatchObject({ canExportPdf: true });
    expect(on.out()).not.toContain('no pdf');

    const off = routedHarness([createRoute]);
    expect(await run(['share', DECK.id, '--no-pdf', ...AUTH], off.io)).toBe(0);
    expect(off.calls[0]?.body).toMatchObject({ canExportPdf: false, canUploadFiles: true });
    expect(off.out()).toContain(', no pdf');
  });

  it('share-email carries the switch on every link it mints', async () => {
    const h = routedHarness([
      createRoute,
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/[^/]+/send$`),
        reply: () => ({ body: { shareToken: TOKEN, emailSent: true } })
      }
    ]);
    expect(await run(['share-email', DECK.id, '--to', 'a@x.io', 'b@x.io', '--no-pdf', ...AUTH], h.io)).toBe(
      0
    );
    const mints = h.calls.filter((c) => /\/tokens$/.test(c.path));
    expect(mints).toHaveLength(2);
    for (const c of mints) expect(c.body).toMatchObject({ canExportPdf: false });
  });

  it('tokens shows "no pdf" and the agent reads, nothing of either on an older server', async () => {
    const { canExportPdf: _pdf, agentReadCount: _reads, ...legacy } = TOKEN;
    const shareTokens = [
      TOKEN,
      { ...TOKEN, name: 'old', canExportPdf: false, agentReadCount: 1 },
      { ...legacy, name: 'legacy' }
    ];
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens`),
        reply: () => ({ body: { shareTokens, nextCursor: null } })
      }
    ]);
    expect(await run(['tokens', DECK.id, ...AUTH], h.io)).toBe(0);
    const lines = h.out().split('\n');
    expect(lines[0]).not.toContain('no pdf');
    expect(lines[0]).toMatch(/0 downloads\s+3 agent reads\s/);
    expect(lines[1]).toMatch(/old\s.*1 agent read\s.*no pdf/);
    expect(lines[2]).not.toContain('no pdf');
    expect(lines[2]).not.toContain('agent read');

    // --json passes the wire through untouched.
    const json = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens`),
        reply: () => ({ body: { shareTokens, nextCursor: null } })
      }
    ]);
    expect(await run(['tokens', DECK.id, '--json', ...AUTH], json.io)).toBe(0);
    expect(JSON.parse(json.out())).toEqual({ shareTokens, nextCursor: null });
  });
});

describe('pdf <id> <tokenId>: the switch on an existing link', () => {
  const routes: Route[] = [
    {
      method: 'PATCH',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/${TOKEN.id}$`),
      reply: ({ body }) => ({
        body: { ...TOKEN, canExportPdf: (body as { canExportPdf: boolean }).canExportPdf }
      })
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
      reply: () => ({ body: { shareTokens: [{ ...TOKEN, canExportPdf: false }], nextCursor: null } })
    }
  ];

  it('reads the state without a flag, flips it with --on and --off', async () => {
    const h = routedHarness(routes);
    expect(await run(['pdf', DECK.id, TOKEN.id, ...AUTH], h.io)).toBe(0);
    expect(h.calls[0]?.method).toBe('GET');
    expect(h.out()).toContain('PDF export is OFF');

    expect(await run(['pdf', DECK.id, TOKEN.id, '--on', ...AUTH], h.io)).toBe(0);
    expect(h.calls[1]).toMatchObject({ method: 'PATCH', body: { canExportPdf: true } });
    expect(h.calls[1]?.body).toEqual({ canExportPdf: true });
    expect(h.out()).toContain('PDF export is ON');

    expect(await run(['pdf', DECK.id, TOKEN.id, '--off', '--json', ...AUTH], h.io)).toBe(0);
    expect(h.calls[2]).toMatchObject({ method: 'PATCH', body: { canExportPdf: false } });
    expect(h.out()).toContain('"canExportPdf": false');
  });

  it('refuses --on with --off, and a token the deck does not have', async () => {
    const both = routedHarness(routes);
    expect(await run(['pdf', DECK.id, TOKEN.id, '--on', '--off', ...AUTH], both.io)).toBe(1);
    expect(both.err()).toContain('either --on or --off');
    expect(both.calls).toHaveLength(0);

    const unknown = routedHarness(routes);
    expect(await run(['pdf', DECK.id, '99999999-9999-9999-9999-999999999999', ...AUTH], unknown.io)).toBe(1);
    expect(unknown.err()).toContain('No share token');
  });
});
