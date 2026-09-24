import { describe, expect, it } from 'vitest';
import { run } from '../src/index.js';
import { DECK, routedHarness, type Route } from './harness.js';

/**
 * The forms fast-lane at the terminal (PRDCT-2328/2329/2330): a NAMED link
 * remembers its recipient's answers and the share line says so, the
 * unnamed quick link does not unless asked, `tokens` shows every switch
 * whose state matters (PRDCT-1337: --no-forms used to be unverifiable),
 * `response` prints one answer with its history, and `notify` reads and
 * flips the owner-mail switch.
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
  badgePosition: null,
  expiresAt: null,
  hasPassword: false,
  revokedAt: null,
  accessCount: 2,
  lastAccessedAt: null,
  downloadCount: 0,
  agentReadCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z'
};

/** The mint fake echoes the switches the CLI sent, as the server would. */
const createRoute: Route = {
  method: 'POST',
  path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
  reply: ({ body }) => {
    const b = body as { name: string; remembersResponses?: boolean; canSubmitForms?: boolean };
    return {
      status: 201,
      body: {
        shareToken: {
          ...TOKEN,
          name: b.name,
          remembersResponses: b.remembersResponses ?? true,
          canSubmitForms: b.canSubmitForms ?? true
        },
        secret: 's3cret',
        url: 'http://x/v/s3cret/'
      }
    };
  }
};
const sendRoute: Route = {
  method: 'POST',
  path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/[^/]+/send$`),
  reply: () => ({ body: { shareToken: TOKEN, emailSent: true } })
};

describe('share: a named link remembers, the unnamed one does not', () => {
  it('sends remembersResponses true for a named link and says so on the share line', async () => {
    const h = routedHarness([createRoute]);
    expect(await run(['share', DECK.id, '--name', 'Alice', ...AUTH], h.io)).toBe(0);
    expect(h.calls[0]?.body).toMatchObject({ name: 'Alice', remembersResponses: true, canSubmitForms: true });
    expect(h.out()).toContain('remembers answers');
    expect(h.out()).toContain('Do not post it publicly');
  });

  it('sends false for the unnamed quick link, true with --remember, false with --no-remember on a name', async () => {
    const unnamed = routedHarness([createRoute]);
    expect(await run(['share', DECK.id, ...AUTH], unnamed.io)).toBe(0);
    expect(unnamed.calls[0]?.body).toMatchObject({ name: 'cli', remembersResponses: false });
    expect(unnamed.out()).not.toContain('remembers answers');

    const asked = routedHarness([createRoute]);
    expect(await run(['share', DECK.id, '--remember', ...AUTH], asked.io)).toBe(0);
    expect(asked.calls[0]?.body).toMatchObject({ name: 'cli', remembersResponses: true });

    const refused = routedHarness([createRoute]);
    expect(await run(['share', DECK.id, '--name', 'Team', '--no-remember', ...AUTH], refused.io)).toBe(0);
    expect(refused.calls[0]?.body).toMatchObject({ name: 'Team', remembersResponses: false });
  });

  it('says "no forms" on the share line when forms are off, so the state is never invisible', async () => {
    const h = routedHarness([createRoute]);
    expect(await run(['share', DECK.id, '--name', 'Ro', '--no-forms', ...AUTH], h.io)).toBe(0);
    expect(h.calls[0]?.body).toMatchObject({ canSubmitForms: false });
    expect(h.out()).toContain('no forms');
  });

  it('share-email mints a remembering link per address; --no-remember switches them all off', async () => {
    const h = routedHarness([createRoute, sendRoute]);
    expect(await run(['share-email', DECK.id, '--to', 'a@x.io', 'b@x.io', ...AUTH], h.io)).toBe(0);
    const mints = h.calls.filter((c) => c.method === 'POST' && /\/tokens$/.test(c.path));
    expect(mints.map((c) => (c.body as { name: string }).name)).toEqual(['a@x.io', 'b@x.io']);
    for (const c of mints) expect(c.body).toMatchObject({ remembersResponses: true });

    const off = routedHarness([createRoute, sendRoute]);
    expect(await run(['share-email', DECK.id, '--to', 'a@x.io', '--no-remember', ...AUTH], off.io)).toBe(0);
    expect(off.calls[0]?.body).toMatchObject({ name: 'a@x.io', remembersResponses: false });
  });
});

describe('tokens shows the forms and remembering states', () => {
  it('prints "no forms" and "remembers answers" beside the other flags', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens`),
        reply: () => ({
          body: {
            shareTokens: [
              TOKEN,
              {
                ...TOKEN,
                id: '55555555-5555-5555-5555-555555555555',
                name: 'alice',
                remembersResponses: true
              },
              { ...TOKEN, id: '66666666-6666-6666-6666-666666666666', name: 'ro', canSubmitForms: false }
            ],
            nextCursor: null
          }
        })
      }
    ]);
    expect(await run(['tokens', DECK.id, ...AUTH], h.io)).toBe(0);
    const lines = h.out().split('\n');
    expect(lines[0]).toMatch(/cli\s+2 opens\s+never\s+latest\s+0 downloads\s+0 agent reads\s+-\s/);
    expect(lines[1]).toMatch(
      /alice\s+2 opens\s+never\s+latest\s+0 downloads\s+0 agent reads\s+remembers answers/
    );
    expect(lines[2]).toMatch(/ro\s+2 opens\s+never\s+latest\s+0 downloads\s+0 agent reads\s+no forms/);
  });
});

describe('response <id> <responseId>: the answer with its history', () => {
  const RESPONSE_ID = '77777777-7777-7777-7777-777777777777';
  const detail = {
    response: {
      id: RESPONSE_ID,
      presentationId: DECK.id,
      version: 1,
      formName: 'rsvp',
      shareTokenId: TOKEN.id,
      shareTokenName: 'alice',
      source: 'link',
      placement: null,
      payload: { name: 'Alice', dish: 'tart' },
      revision: 2,
      createdAt: '2026-09-14T20:00:00.000Z',
      updatedAt: '2026-09-14T22:00:00.000Z'
    },
    versions: [
      {
        revision: 2,
        version: 1,
        shareTokenId: TOKEN.id,
        shareTokenName: 'alice',
        source: 'link',
        placement: null,
        payload: { name: 'Alice', dish: 'tart' },
        createdAt: '2026-09-14T22:00:00.000Z'
      },
      {
        revision: 1,
        version: 1,
        shareTokenId: TOKEN.id,
        shareTokenName: 'alice',
        source: 'link',
        placement: null,
        payload: { name: 'Alice', dish: 'pie' },
        createdAt: '2026-09-14T20:00:00.000Z'
      }
    ]
  };
  const route: Route = {
    method: 'GET',
    path: new RegExp(`/api/v1/presentations/${DECK.id}/responses/${RESPONSE_ID}$`),
    reply: () => ({ body: detail })
  };

  it('prints the current answer, then every revision newest first', async () => {
    const h = routedHarness([route]);
    expect(await run(['response', DECK.id, RESPONSE_ID, ...AUTH], h.io)).toBe(0);
    const out = h.out();
    expect(out).toContain('revision 2');
    expect(out).toContain('2 revisions kept, newest first');
    const r2 = out.indexOf('r2');
    const r1 = out.indexOf('r1');
    expect(r2).toBeGreaterThan(-1);
    expect(r1).toBeGreaterThan(r2);
    expect(out).toContain('"dish":"pie"');
  });

  it('--json prints the detail as the wire has it', async () => {
    const h = routedHarness([route]);
    expect(await run(['response', DECK.id, RESPONSE_ID, '--json', ...AUTH], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual(detail);
  });
});

describe('notify <id>: the owner-mail switch', () => {
  const deckWire = (notifyOnResponse: boolean) => ({
    ...DECK,
    totalViews: 0,
    metadata: {},
    notifyOnResponse
  });
  it('reads the state without a flag, flips it with --off and --on', async () => {
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}$`),
        reply: () => ({ body: deckWire(true) })
      },
      {
        method: 'PATCH',
        path: new RegExp(`/api/v1/presentations/${DECK.id}$`),
        reply: ({ body }) => ({ body: deckWire((body as { notifyOnResponse: boolean }).notifyOnResponse) })
      }
    ]);
    expect(await run(['notify', DECK.id, ...AUTH], h.io)).toBe(0);
    expect(h.calls[0]?.method).toBe('GET');
    expect(h.out()).toContain('Response mails are ON');

    expect(await run(['notify', DECK.id, '--off', ...AUTH], h.io)).toBe(0);
    expect(h.calls[1]).toMatchObject({ method: 'PATCH', body: { notifyOnResponse: false } });
    expect(h.out()).toContain('Response mails are OFF');

    expect(await run(['notify', DECK.id, '--on', '--json', ...AUTH], h.io)).toBe(0);
    expect(h.calls[2]).toMatchObject({ method: 'PATCH', body: { notifyOnResponse: true } });
    expect(h.out()).toContain('"notifyOnResponse": true');
  });

  it('refuses --on together with --off', async () => {
    const h = routedHarness([]);
    expect(await run(['notify', DECK.id, '--on', '--off', ...AUTH], h.io)).not.toBe(0);
    expect(h.err()).toContain('either --on or --off');
  });
});
