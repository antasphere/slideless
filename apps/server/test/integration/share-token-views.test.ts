import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { shareTokens, shareTokenViews } from '@slideless/db';
import { purgeShareTokenViews } from '../../src/sharing/view-events.js';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/** An HTML Accept: the deck, not the agent index (PRDCT-2670). */
const DOC_NAV = { accept: 'text/html' };

/**
 * Per-view share-link analytics (PRDCT-1313).
 *
 * The invariant under test: ONE event row per COUNTED view — written under
 * exactly the gate that increments accessCount — carrying only the
 * privacy-vetted fields (referrer HOST, sanitized `?p=` placement, coarse
 * UA family; never an IP, never a full URL). Dedupe-cookie repeats, preview
 * tokens, asset fetches, and HEAD write nothing. History survives token
 * deletion (share_token_id nulled); retention is the batched nightly purge
 * (0 = keep forever). The read surface is the deck-writers' 404-posture
 * endpoint, cursor-paged newest first.
 */

const OWNER = { email: 'owner@views.test', name: 'Views Owner', password: 'views-owner-pass-1' };
const MEMBER = { email: 'member@views.test', name: 'Plain Member', password: 'views-member-pass-1' };

const HTML_V1 = Buffer.from('<!doctype html><html><body><h1>Views deck v1</h1></body></html>');
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

let container: StartedPostgreSqlContainer;
let app: TestApp;
let ownerCookie: string;
let memberCookie: string;
let deckId: string;

let ipCounter = 0;
const nextIp = () => `10.97.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

async function rowsOfToken(tokenId: string) {
  return app.db.db
    .select()
    .from(shareTokenViews)
    .where(eq(shareTokenViews.shareTokenId, tokenId))
    .orderBy(shareTokenViews.occurredAt);
}

async function mintToken(name: string): Promise<{ id: string; secret: string }> {
  const res = await app.app.request(
    `/api/v1/presentations/${deckId}/tokens`,
    json({ name }, { cookie: ownerCookie })
  );
  expect(res.status).toBe(201);
  const created = await readJson(res);
  return { id: created.shareToken.id, secret: created.secret };
}

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'share_token_views'));
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Views', owner: OWNER })
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
        title: 'Views Deck',
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', sha256: shaOf(HTML_V1), sizeBytes: HTML_V1.length, contentType: 'text/html' }
        ]
      },
      { cookie: ownerCookie }
    )
  );
  expect(commit.status).toBe(201);

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

describe('the counted gate writes exactly one event', () => {
  it('a counted view stores referrer host + placement + ua family (and nothing IP-shaped)', async () => {
    const token = await mintToken('Event fields');
    const res = await app.app.request(`/v/${token.secret}/?p=newsletter`, {
      headers: {
        ...DOC_NAV,
        referer: 'https://docs.example.com/some/page?q=secret-path-must-not-survive',
        'user-agent': CHROME_UA,
        'x-forwarded-for': nextIp()
      }
    });
    expect(res.status).toBe(200);

    const rows = await rowsOfToken(token.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.referrerHost).toBe('docs.example.com');
    expect(row.placement).toBe('newsletter');
    expect(row.uaFamily).toBe('chrome');
    expect(row.version).toBe(1);
    expect(row.presentationId).toBe(deckId);
    // The privacy posture is structural: the row has no column that COULD
    // hold an IP, a geo, or a full URL.
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'workspaceId',
        'presentationId',
        'shareTokenId',
        'version',
        'occurredAt',
        'referrerHost',
        'placement',
        'uaFamily'
      ].sort()
    );
    expect(row.referrerHost).not.toContain('/'); // host, never a URL
  });

  it('a dedupe-cookie repeat serves 200 but writes NO second row (counter also unchanged)', async () => {
    const token = await mintToken('Dedupe');
    const first = await app.app.request(`/v/${token.secret}/`, {
      headers: { ...DOC_NAV, 'user-agent': CHROME_UA, 'x-forwarded-for': nextIp() }
    });
    expect(first.status).toBe(200);
    const viewedCookie = extractCookie(first);
    expect(viewedCookie).toContain(`slvd_${token.id}`);

    const repeat = await app.app.request(`/v/${token.secret}/`, {
      headers: { ...DOC_NAV, cookie: viewedCookie, 'user-agent': CHROME_UA, 'x-forwarded-for': nextIp() }
    });
    expect(repeat.status).toBe(200);

    expect(await rowsOfToken(token.id)).toHaveLength(1);
    const [tokenRow] = await app.db.db.select().from(shareTokens).where(eq(shareTokens.id, token.id));
    expect(tokenRow!.accessCount).toBe(1);
  });

  it('a preview-token open writes nothing', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/preview-token`,
      json({}, { cookie: ownerCookie })
    );
    expect(res.status).toBe(201);
    const created = await readJson(res);
    const served = await app.app.request(`/v/${created.secret}/`, {
      headers: { ...DOC_NAV, 'user-agent': CHROME_UA, 'x-forwarded-for': nextIp() }
    });
    expect(served.status).toBe(200);
    expect(await rowsOfToken(created.shareToken.id)).toHaveLength(0);
  });

  it('asset fetches and HEAD write nothing', async () => {
    const token = await mintToken('Asset + HEAD');

    // index.html through the ASSET route (manifest path), not the entry.
    const asset = await app.app.request(`/v/${token.secret}/index.html`, {
      headers: { 'user-agent': CHROME_UA, 'x-forwarded-for': nextIp() }
    });
    expect(asset.status).toBe(200);
    expect(await rowsOfToken(token.id)).toHaveLength(0);

    const head = await app.app.request(`/v/${token.secret}/`, {
      method: 'HEAD',
      headers: { ...DOC_NAV, 'user-agent': CHROME_UA, 'x-forwarded-for': nextIp() }
    });
    expect(head.status).toBe(200);
    expect(await rowsOfToken(token.id)).toHaveLength(0);
  });

  it('garbage/absent Referer and an illegal `p` value store nulls (view still counted)', async () => {
    const token = await mintToken('Nulls');
    const res = await app.app.request(`/v/${token.secret}/?p=${encodeURIComponent('bad label!')}`, {
      headers: { ...DOC_NAV, referer: 'not a url at all', 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBe(200);
    const rows = await rowsOfToken(token.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.referrerHost).toBeNull();
    expect(rows[0]!.placement).toBeNull();
    expect(rows[0]!.uaFamily).toBeNull(); // no User-Agent header sent

    // Over-long placement (65 chars) is equally refused.
    const long = await app.app.request(`/v/${token.secret}/?p=${'a'.repeat(65)}`, {
      headers: { ...DOC_NAV, 'x-forwarded-for': nextIp() }
    });
    expect(long.status).toBe(200);
    const after = await rowsOfToken(token.id);
    expect(after).toHaveLength(2);
    expect(after.every((r) => r.placement === null)).toBe(true);
  });

  it('an absurdly long Referer host stores null, not a header-sized row', async () => {
    // `Referer` is VISITOR-supplied and referrer_host is unbounded `text` on
    // an unbounded table, with no rate limit on entry views — an uncapped
    // host let any link holder write header-sized rows at request rate.
    const token = await mintToken('Long host');
    const res = await app.app.request(`/v/${token.secret}/`, {
      headers: {
        ...DOC_NAV,
        referer: `https://${'a'.repeat(4000)}.example.com/p`,
        'x-forwarded-for': nextIp()
      }
    });
    expect(res.status).toBe(200); // the view still counts
    const rows = await rowsOfToken(token.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.referrerHost).toBeNull();

    // A real-world host of legal length is untouched.
    const ok = await app.app.request(`/v/${token.secret}/`, {
      headers: { ...DOC_NAV, referer: 'https://docs.example.com/a/b?c=d', 'x-forwarded-for': nextIp() }
    });
    expect(ok.status).toBe(200);
    const after = await rowsOfToken(token.id);
    expect(after).toHaveLength(2);
    expect(after[1]!.referrerHost).toBe('docs.example.com');
  });

  it('the no-trailing-slash 301 preserves the query string, so ?p= survives the canonical redirect', async () => {
    const token = await mintToken('Redirect');
    const res = await app.app.request(`/v/${token.secret}?p=hero`, {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(res.status).toBe(301);
    const location = res.headers.get('location')!;
    expect(location).toContain(`/v/${token.secret}/`);
    expect(location).toContain('?p=hero');
  });
});

describe('history and retention', () => {
  it('token deletion keeps the rows: share_token_id is nulled, nothing cascades', async () => {
    const token = await mintToken('Deleted token');
    expect(
      (
        await app.app.request(`/v/${token.secret}/?p=kept`, {
          headers: { ...DOC_NAV, 'x-forwarded-for': nextIp() }
        })
      ).status
    ).toBe(200);
    const before = await rowsOfToken(token.id);
    expect(before).toHaveLength(1);
    const rowId = before[0]!.id;

    await app.db.db.delete(shareTokens).where(eq(shareTokens.id, token.id));

    const [kept] = await app.db.db.select().from(shareTokenViews).where(eq(shareTokenViews.id, rowId));
    expect(kept).toBeDefined();
    expect(kept!.shareTokenId).toBeNull();
    expect(kept!.placement).toBe('kept');
  });

  it('the purge deletes only rows older than the retention window; 0 disables it', async () => {
    const token = await mintToken('Retention');
    // Two counted views (no dedupe cookie presented → both count).
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await app.app.request(`/v/${token.secret}/`, {
            headers: { ...DOC_NAV, 'x-forwarded-for': nextIp() }
          })
        ).status
      ).toBe(200);
    }
    const rows = await rowsOfToken(token.id);
    expect(rows).toHaveLength(2);
    // Backdate ONE row beyond a 90-day window.
    await app.db.db
      .update(shareTokenViews)
      .set({ occurredAt: sql`now() - interval '91 days'` })
      .where(eq(shareTokenViews.id, rows[0]!.id));

    // 0 = keep forever: nothing deleted, even the backdated row survives.
    expect(await purgeShareTokenViews(app.db.db, 0)).toBe(0);
    expect(await rowsOfToken(token.id)).toHaveLength(2);

    // 90-day retention: exactly the backdated row goes.
    expect(await purgeShareTokenViews(app.db.db, 90)).toBe(1);
    const after = await rowsOfToken(token.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(rows[1]!.id);
  });
});

describe('the read endpoint', () => {
  it('pages newest-first with a cursor', async () => {
    const token = await mintToken('Paging');
    for (const p of ['first', 'second', 'third']) {
      expect(
        (
          await app.app.request(`/v/${token.secret}/?p=${p}`, {
            headers: { ...DOC_NAV, 'x-forwarded-for': nextIp() }
          })
        ).status
      ).toBe(200);
    }

    const page1 = await readJson(
      await app.app.request(`/api/v1/presentations/${deckId}/tokens/${token.id}/views?limit=2`, {
        headers: { cookie: ownerCookie }
      })
    );
    expect(page1.views).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    // Newest first: the LAST recorded placement leads.
    expect(page1.views[0].placement).toBe('third');
    expect(page1.views[1].placement).toBe('second');
    // Wire shape is the privacy-vetted field set, nothing more.
    expect(Object.keys(page1.views[0]).sort()).toEqual(
      ['id', 'occurredAt', 'placement', 'referrerHost', 'uaFamily', 'version'].sort()
    );

    const page2 = await readJson(
      await app.app.request(
        `/api/v1/presentations/${deckId}/tokens/${token.id}/views?limit=2&cursor=${page1.nextCursor}`,
        { headers: { cookie: ownerCookie } }
      )
    );
    expect(page2.views).toHaveLength(1);
    expect(page2.views[0].placement).toBe('first');
    expect(page2.nextCursor).toBeNull();
  });

  it('answers 404 (never 403) to a plain member — existence is not probeable', async () => {
    const token = await mintToken('Member probe');
    const res = await app.app.request(`/api/v1/presentations/${deckId}/tokens/${token.id}/views`, {
      headers: { cookie: memberCookie }
    });
    expect(res.status).toBe(404);
    expect((await readJson(res)).error.code).toBe('not_found');
  });

  it('answers 404 for an unknown tokenId', async () => {
    const res = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens/00000000-0000-0000-0000-000000000000/views`,
      { headers: { cookie: ownerCookie } }
    );
    expect(res.status).toBe(404);
  });
});
