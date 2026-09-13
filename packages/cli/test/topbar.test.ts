import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { DECK, routedHarness, type Route } from './harness.js';

/**
 * PRDCT-2281, the CLI half of the recipient bar: `share --no-bar` (and
 * `share-email --no-bar`) mint a link with `showBar: false`, the default
 * stays on, the human line names a bare link, and `--json` carries the
 * field byte-exact.
 */

const TOKEN = {
  id: '66666666-6666-6666-6666-666666666666',
  presentationId: DECK.id,
  name: 'cli',
  purpose: 'share',
  versionMode: 'latest',
  pinnedVersion: null,
  canAnnotate: false,
  canSubmitForms: true,
  canDownload: true,
  showBar: true,
  badgePosition: null,
  expiresAt: null,
  hasPassword: false,
  revokedAt: null,
  accessCount: 0,
  lastAccessedAt: null,
  downloadCount: 0,
  createdAt: '2026-09-13T00:00:00.000Z'
};

const createRoute = (showBar: boolean): Route => ({
  method: 'POST',
  path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
  reply: () => ({
    status: 201,
    body: { shareToken: { ...TOKEN, showBar }, secret: 's3cret', url: 'http://x/v/s3cret/' }
  })
});

describe('share --no-bar', () => {
  it('mints with showBar true by default and false with --no-bar', async () => {
    const h = routedHarness([createRoute(true)]);
    expect(await run(['share', DECK.id, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    const body = h.calls.find((c) => c.path.endsWith('/tokens'))!.body as { showBar: boolean };
    expect(body.showBar).toBe(true);
    expect(h.out()).not.toContain('no bar');

    const h2 = routedHarness([createRoute(false)]);
    expect(
      await run(['share', DECK.id, '--no-bar', '--url', 'http://x', '--api-key', 'slk_k_s'], h2.io)
    ).toBe(0);
    const body2 = h2.calls.find((c) => c.path.endsWith('/tokens'))!.body as { showBar: boolean };
    expect(body2.showBar).toBe(false);
    expect(h2.out()).toContain(', no bar)');
  });

  it('--json carries showBar on the created token, byte-exact', async () => {
    const h = routedHarness([createRoute(false)]);
    expect(
      await run(['share', DECK.id, '--no-bar', '--json', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)
    ).toBe(0);
    expect((JSON.parse(h.out()) as { shareToken: { showBar: boolean } }).shareToken.showBar).toBe(false);
  });

  it('a server from before the switch (no showBar in its answer) is not called bare', async () => {
    const h = routedHarness([
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
        reply: () => {
          const { showBar: _dropped, ...older } = TOKEN;
          void _dropped;
          return { status: 201, body: { shareToken: older, secret: 's3cret', url: 'http://x/v/s3cret/' } };
        }
      }
    ]);
    expect(await run(['share', DECK.id, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    expect(h.out()).not.toContain('no bar');
  });

  it('share-email takes --no-bar too', async () => {
    const h = routedHarness([
      createRoute(false),
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/${TOKEN.id}/send$`),
        reply: () => ({ body: { emailSent: true, url: 'http://x/v/rotated/' } })
      }
    ]);
    expect(
      await run(
        ['share-email', DECK.id, '--to', 'a@x.co', '--no-bar', '--url', 'http://x', '--api-key', 'slk_k_s'],
        h.io
      )
    ).toBe(0);
    const body = h.calls.find((c) => c.path.endsWith('/tokens'))!.body as { showBar: boolean };
    expect(body.showBar).toBe(false);
  });
});
