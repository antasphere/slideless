import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IDENTITY } from '@slideless/contract';
import type { Db } from '@antasphere/chassis-db';
import type { GrantAccess } from '@antasphere/chassis-server/identity';
import type { Logger } from '@antasphere/chassis-server/logger';
import {
  appsFromFile,
  parseMeTools,
  parseToolAccess,
  safeHttpUrl,
  selectHubApps,
  type HubToolAccess
} from '../../src/apps/select.js';
import { APPS_CACHE_TTL_MS, AppsService, type HubTokens } from '../../src/apps/service.js';

/**
 * The Apps page's list (`src/apps/`): the URL rule, the operator's file, the
 * hub's tools kept where the workspace's organization grants them, the
 * current tool, and the service's fall-backs and cache. The route itself
 * (session only, the allowlist's 403) is the scope test's and the
 * integration suite's.
 */

const ORG = '0b9f1a52-6f8e-4b5e-9a35-1d2c3e4f5a6b';
const OTHER_ORG = 'c3d4e5f6-0718-4a2b-8c9d-0e1f2a3b4c5d';

describe('safeHttpUrl', () => {
  it('keeps http and https, normalised', () => {
    expect(safeHttpUrl('https://finance.example.com')).toBe('https://finance.example.com/');
    expect(safeHttpUrl('http://localhost:5190/x?y=1')).toBe('http://localhost:5190/x?y=1');
  });

  it('refuses every other scheme, a relative path, credentials, a blank and a non-string', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com',
      '/relative',
      'example.com',
      'https://user:pass@example.com',
      '',
      42,
      null,
      undefined,
      'https://' + 'a'.repeat(2001)
    ]) {
      expect(safeHttpUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('appsFromFile', () => {
  it('reads the development fixture the README names whole: the account, the five tools, this one current', () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../scripts/apps.fixture.json'), 'utf8')
    );
    const file = appsFromFile(raw, IDENTITY.slug);
    expect(file.rejected).toEqual([]);
    expect(file.hub?.name).toBe('Antasphere Account');
    expect(file.apps).toHaveLength(6);
    expect(file.apps.filter((a) => a.current).map((a) => a.slug)).toEqual([IDENTITY.slug]);
  });

  it('lists the valid entries in order, marks this tool current, takes the description', () => {
    const file = appsFromFile(
      [
        { slug: 'finance', name: 'Antasphere Finance', launchUrl: 'https://finance.example.com' },
        {
          slug: 'slideless',
          name: 'Slideless',
          launchUrl: 'https://slideless.example.com',
          description: ' Book. '
        }
      ],
      'slideless'
    );
    expect(file.apps.map((a) => [a.slug, a.current, a.description])).toEqual([
      ['finance', false, null],
      ['slideless', true, 'Book.']
    ]);
    expect(file.apps[0]).toMatchObject({ connected: false, firstUsedAt: null, lastUsedAt: null });
    expect(file.rejected).toEqual([]);
  });

  it('leaves out an entry without a slug, a name or an http(s) launchUrl, and a second of the same slug', () => {
    const file = appsFromFile(
      [
        { name: 'No slug', launchUrl: 'https://a.example.com' },
        { slug: 'Bad Slug', name: 'X', launchUrl: 'https://a.example.com' },
        { slug: 'crm', launchUrl: 'https://crm.example.com' },
        { slug: 'crm', name: 'CRM', launchUrl: 'javascript:alert(1)' },
        { slug: 'crm', name: 'CRM', launchUrl: 'https://crm.example.com' },
        { slug: 'crm', name: 'CRM again', launchUrl: 'https://crm2.example.com' },
        'not an object'
      ],
      'slideless'
    );
    expect(file.apps.map((a) => a.name)).toEqual(['CRM']);
    expect(file.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3, 5, 6]);
  });

  it('takes an entry named hub or account as the account’s card, not a tool', () => {
    const file = appsFromFile(
      [
        { slug: 'account', name: 'Antasphere Account', launchUrl: 'https://account.example.com' },
        { slug: 'hiring', name: 'Hiring', launchUrl: 'https://hiring.example.com' }
      ],
      'slideless'
    );
    expect(file.hub).toEqual({ url: 'https://account.example.com/', name: 'Antasphere Account' });
    expect(file.apps.map((a) => a.slug)).toEqual(['hiring']);
  });

  it('a file that is not an array lists nothing', () => {
    expect(appsFromFile({ slug: 'x' }, 'slideless')).toMatchObject({ apps: [], hub: null });
  });
});

describe('the hub’s answers', () => {
  it('parseMeTools reads tools[], drops an entry without a slug, and is null without the list', () => {
    expect(
      parseMeTools({
        tools: [
          {
            slug: 'finance',
            name: 'Finance',
            firstUsedAt: '2026-01-01T00:00:00Z',
            lastUsedAt: '2026-10-01T00:00:00Z'
          },
          { name: 'no slug' }
        ]
      })
    ).toEqual([
      {
        slug: 'finance',
        name: 'Finance',
        firstUsedAt: '2026-01-01T00:00:00Z',
        lastUsedAt: '2026-10-01T00:00:00Z'
      }
    ]);
    expect(parseMeTools({ user: {} })).toBeNull();
    expect(parseMeTools(null)).toBeNull();
  });

  it('parseToolAccess reads the launch URL and the granted ids, and is null on another shape', () => {
    expect(
      parseToolAccess({
        tool: { slug: 'crm', name: 'CRM', launchUrl: 'https://crm.example.com', returnOrigins: [] },
        granted: [{ id: ORG, name: 'Acme' }],
        denied: []
      })
    ).toEqual({ launchUrl: 'https://crm.example.com', granted: [ORG] });
    expect(parseToolAccess({ granted: [] })).toBeNull();
    expect(parseToolAccess({ tool: { launchUrl: 'x' } })).toBeNull();
  });
});

describe('selectHubApps', () => {
  const tools = [
    { slug: 'finance', name: 'Finance', firstUsedAt: 'f1', lastUsedAt: 'l1' },
    { slug: 'hiring', name: 'Hiring', firstUsedAt: null, lastUsedAt: null },
    { slug: 'slideless', name: 'Slideless', firstUsedAt: null, lastUsedAt: null },
    { slug: 'crm', name: 'CRM', firstUsedAt: null, lastUsedAt: null },
    { slug: 'steward', name: 'Steward', firstUsedAt: null, lastUsedAt: null }
  ];
  const access = new Map<string, HubToolAccess | null>([
    ['finance', { launchUrl: 'https://finance.example.com', granted: [ORG, OTHER_ORG] }],
    // granted elsewhere only: this workspace's organization does not open it to the person
    ['hiring', { launchUrl: 'https://hiring.example.com', granted: [OTHER_ORG] }],
    ['slideless', { launchUrl: 'https://slideless.example.com', granted: [ORG] }],
    // a launch URL that is not http(s) is never served
    ['crm', { launchUrl: 'javascript:alert(1)', granted: [ORG] }]
    // steward: unanswered
  ]);

  it('keeps the tools the workspace’s organization grants, in the hub’s order, with their facts', () => {
    const apps = selectHubApps(tools, access, ORG, 'slideless');
    expect(apps.map((a) => a.slug)).toEqual(['finance', 'slideless']);
    expect(apps[0]).toEqual({
      slug: 'finance',
      name: 'Finance',
      launchUrl: 'https://finance.example.com/',
      description: null,
      connected: true,
      firstUsedAt: 'f1',
      lastUsedAt: 'l1',
      current: false
    });
  });

  it('marks this tool current and nothing else', () => {
    const apps = selectHubApps(tools, access, ORG, 'slideless');
    expect(apps.filter((a) => a.current).map((a) => a.slug)).toEqual(['slideless']);
  });

  it('another organization sees what it grants', () => {
    expect(selectHubApps(tools, access, OTHER_ORG, 'slideless').map((a) => a.slug)).toEqual([
      'finance',
      'hiring'
    ]);
  });
});

// ── The service ──────────────────────────────────────────────────────────────

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as Logger;

/** A db whose one query (the workspace's hub organization) answers `hubOrgId`. */
function fakeDb(hubOrgId: string | null): Db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([{ hubOrgId }])
  };
  return chain as unknown as Db;
}

function fakeTokens(access: GrantAccess = { kind: 'ok', accessToken: 'tok-1' }) {
  const tokens = {
    accessToken: vi.fn<HubTokens['accessToken']>(() => Promise.resolve(access)),
    refresh: vi.fn<HubTokens['refresh']>(() => Promise.resolve({ kind: 'ok', accessToken: 'tok-2' })),
    invalidateAccess: vi.fn<HubTokens['invalidateAccess']>()
  };
  return tokens;
}

/** A hub that answers /me and /me/tool-access for the given token. */
function fakeHub(opts: { token?: string; meStatus?: number; failSlug?: string } = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${opts.token ?? 'tok-1'}`) return Response.json({ error: {} }, { status: 401 });
    if (url.pathname === '/api/v1/me') {
      if (opts.meStatus) return Response.json({}, { status: opts.meStatus });
      return Response.json({
        tools: [
          {
            slug: 'finance',
            name: 'Antasphere Finance',
            firstUsedAt: '2026-09-01T00:00:00Z',
            lastUsedAt: '2026-10-10T00:00:00Z'
          },
          { slug: 'slideless', name: 'Slideless', firstUsedAt: null, lastUsedAt: null },
          { slug: 'hiring', name: 'Antasphere Hiring', firstUsedAt: null, lastUsedAt: null }
        ]
      });
    }
    const slug = url.searchParams.get('tool') ?? '';
    if (slug === opts.failSlug) return Response.json({}, { status: 503 });
    return Response.json({
      tool: { slug, name: slug, launchUrl: `https://${slug}.example.com`, returnOrigins: [] },
      granted: slug === 'hiring' ? [{ id: OTHER_ORG, name: 'Other' }] : [{ id: ORG, name: 'Acme' }],
      denied: []
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const principal = { userId: 'usr_1', workspaceId: 'ws_1' };

function cloud(over: {
  db?: Db;
  tokens?: HubTokens;
  fetchImpl?: typeof fetch;
  appsFile?: string;
  now?: () => number;
}) {
  return new AppsService({
    db: over.db ?? fakeDb(ORG),
    logger,
    edition: 'cloud',
    hubIssuerUrl: 'https://account.example.com/',
    appsFile: over.appsFile,
    selfSlug: 'slideless',
    tokens: over.tokens ?? fakeTokens(),
    ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}),
    ...(over.now ? { now: over.now } : {})
  });
}

function writeFile(entries: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'apps-'));
  const path = join(dir, 'apps.json');
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

describe('AppsService on the cloud edition', () => {
  it('asks the hub as the person and keeps what the workspace’s organization grants', async () => {
    const hub = fakeHub();
    const list = await cloud({ fetchImpl: hub.impl }).list(principal);
    expect(list.source).toBe('hub');
    expect(list.hub).toEqual({ url: 'https://account.example.com/', name: 'Antasphere Account' });
    expect(list.apps.map((a) => [a.slug, a.current])).toEqual([
      ['finance', false],
      ['slideless', true]
    ]);
    expect(list.apps[0]?.lastUsedAt).toBe('2026-10-10T00:00:00Z');
    expect(hub.calls).toContain('/api/v1/me/tool-access?tool=finance');
  });

  it('refreshes the grant once on a 401 and retries', async () => {
    const tokens = fakeTokens({ kind: 'ok', accessToken: 'stale' });
    const hub = fakeHub({ token: 'tok-2' });
    const list = await cloud({ tokens, fetchImpl: hub.impl }).list(principal);
    expect(list.source).toBe('hub');
    expect(tokens.invalidateAccess).toHaveBeenCalledWith('usr_1');
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
  });

  it('holds the answer five minutes per person and workspace', async () => {
    const hub = fakeHub();
    let now = 1_000_000;
    const service = cloud({ fetchImpl: hub.impl, now: () => now });
    await service.list(principal);
    const asked = hub.calls.length;
    now += APPS_CACHE_TTL_MS - 1;
    await service.list(principal);
    expect(hub.calls.length).toBe(asked);
    await service.list({ ...principal, workspaceId: 'ws_2' });
    expect(hub.calls.length).toBe(asked * 2);
    now += 2;
    await service.list(principal);
    expect(hub.calls.length).toBe(asked * 3);
  });

  it('does not hold an answer with a tool the hub left unanswered, and shows the rest', async () => {
    const hub = fakeHub({ failSlug: 'finance' });
    const service = cloud({ fetchImpl: hub.impl });
    expect((await service.list(principal)).apps.map((a) => a.slug)).toEqual(['slideless']);
    const asked = hub.calls.length;
    await service.list(principal);
    expect(hub.calls.length).toBe(asked * 2);
  });

  it('falls back to the file when the grant is dead, the hub fails, or the workspace is no hub organization', async () => {
    const appsFile = writeFile([{ slug: 'crm', name: 'CRM', launchUrl: 'https://crm.example.com' }]);
    const cases = [
      cloud({ appsFile, tokens: fakeTokens({ kind: 'grant_dead' }), fetchImpl: fakeHub().impl }),
      cloud({ appsFile, fetchImpl: fakeHub({ meStatus: 502 }).impl }),
      cloud({
        appsFile,
        fetchImpl: (() => Promise.reject(new Error('network'))) as unknown as typeof fetch
      }),
      cloud({ appsFile, db: fakeDb(null), fetchImpl: fakeHub().impl })
    ];
    for (const service of cases) {
      const list = await service.list(principal);
      expect(list.source).toBe('file');
      expect(list.apps.map((a) => a.slug)).toEqual(['crm']);
      expect(list.hub?.url).toBe('https://account.example.com/');
    }
  });
});

describe('AppsService on a self-hosted instance', () => {
  const oss = (appsFile?: string) =>
    new AppsService({
      db: fakeDb(ORG),
      logger,
      edition: 'oss',
      hubIssuerUrl: 'https://account.example.com',
      appsFile,
      selfSlug: 'slideless',
      tokens: null,
      fetchImpl: (() => {
        throw new Error('the hub is never asked on oss');
      }) as unknown as typeof fetch
    });

  it('reads the file, the account from its hub entry, never the hub', async () => {
    const appsFile = writeFile([
      { slug: 'hub', name: 'Our account', launchUrl: 'https://id.example.com' },
      { slug: 'slideless', name: 'Slideless', launchUrl: 'https://slideless.example.com' },
      { slug: 'finance', name: 'Finance', launchUrl: 'ftp://finance.example.com' }
    ]);
    const list = await oss(appsFile).list(principal);
    expect(list).toEqual({
      source: 'file',
      hub: { url: 'https://id.example.com/', name: 'Our account' },
      apps: [expect.objectContaining({ slug: 'slideless', current: true })]
    });
  });

  it('lists nothing without a file, or with one that is not JSON', async () => {
    expect(await oss().list(principal)).toEqual({ apps: [], hub: null, source: 'none' });
    const dir = mkdtempSync(join(tmpdir(), 'apps-'));
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    expect(await oss(broken).list(principal)).toEqual({ apps: [], hub: null, source: 'none' });
  });
});
