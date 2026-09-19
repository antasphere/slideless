import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deckMasterUrl } from '@slideless/contract';
import { run } from '../src/index.js';
import { writeLink } from '../src/manifest.js';
import { shouldOpenAfterPush } from '../src/open.js';
import { DECK, routedHarness, VERSION_ROW, type Route } from './harness.js';

/**
 * PRDCT-2280: a push answers with the deck's master page and opens it on the
 * first push; `slideless open` opens the linked deck's page. The opener is
 * injected (`io.openUrl`) so nothing is spawned here; the TTY signal is
 * `io.out.isTTY`, exactly what `process.stdout` carries. The opener itself is
 * the chassis suite's (`packages/chassis-cli/test/suite/open.test.ts`).
 */

const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const MASTER = deckMasterUrl('http://x', DECK.id);

async function makeDeckDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slideless-open-'));
  await writeFile(join(dir, 'index.html'), '<html>v1</html>');
  await mkdir(join(dir, 'img'), { recursive: true });
  await writeFile(join(dir, 'img', 'dot.png'), Buffer.from([1, 2, 3]));
  return dir;
}

function pushRoutes(existingDeck: boolean): Route[] {
  const routes: Route[] = [
    { method: 'POST', path: /\/api\/v1\/presentations\/precheck$/, reply: () => ({ body: { missing: [] } }) },
    {
      method: 'POST',
      path: /\/api\/v1\/presentations\/uploads$/,
      reply: () => ({
        status: 201,
        body: {
          uploadSession: {
            id: SESSION_ID,
            presentationId: DECK.id,
            expiresAt: '2026-01-01T01:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        }
      })
    },
    {
      method: 'POST',
      path: new RegExp(`/api/v1/presentations/uploads/${SESSION_ID}/commit$`),
      reply: () => ({
        status: 201,
        body: { presentation: { ...DECK, currentVersion: 1 }, version: VERSION_ROW }
      })
    }
  ];
  if (existingDeck) {
    routes.push(
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}$`),
        reply: () => ({ body: { ...DECK, currentVersion: 3 } })
      },
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/versions$`),
        reply: () => ({
          status: 201,
          body: { presentation: { ...DECK, currentVersion: 4 }, version: { ...VERSION_ROW, version: 4 } }
        })
      }
    );
  }
  return routes;
}

/** A harness whose stdout is (or is not) a terminal, with a recording opener. */
function openingHarness(routes: Route[], tty: boolean) {
  const h = routedHarness(routes);
  const opened: string[] = [];
  h.io.out.isTTY = tty;
  h.io.openUrl = (url) => opened.push(url);
  return { ...h, opened };
}

describe('shouldOpenAfterPush', () => {
  const cases: Array<[string, Parameters<typeof shouldOpenAfterPush>[0], boolean]> = [
    ['new deck, tty, no flag', { created: true, json: false, interactive: true, flag: undefined }, true],
    [
      'existing deck, tty, no flag',
      { created: false, json: false, interactive: true, flag: undefined },
      false
    ],
    ['existing deck, tty, --open', { created: false, json: false, interactive: true, flag: true }, true],
    ['new deck, tty, --no-open', { created: true, json: false, interactive: true, flag: false }, false],
    ['new deck, piped', { created: true, json: false, interactive: false, flag: undefined }, false],
    ['new deck, piped, --open', { created: true, json: false, interactive: false, flag: true }, false],
    ['new deck, --json on a tty', { created: true, json: true, interactive: true, flag: undefined }, false],
    ['new deck, --json, --open', { created: true, json: true, interactive: true, flag: true }, false],
    ['existing deck, piped, --open', { created: false, json: false, interactive: false, flag: true }, false]
  ];
  for (const [label, input, expected] of cases) {
    it(`${label} → ${expected ? 'opens' : 'does not open'}`, () => {
      expect(shouldOpenAfterPush(input)).toBe(expected);
    });
  }
});

describe('push answers with the master URL', () => {
  it('first push on a tty: prints the URL and opens it once', async () => {
    const dir = await makeDeckDir();
    const h = openingHarness(pushRoutes(false), true);
    const code = await run(['push', dir, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    expect(h.out()).toContain(`  url: ${MASTER}\n`);
    expect(h.out()).toContain('opened in your browser (--no-open to skip)');
    expect(h.opened).toEqual([MASTER]);
  });

  it('first push piped: prints the URL, opens nothing', async () => {
    const dir = await makeDeckDir();
    const h = openingHarness(pushRoutes(false), false);
    expect(await run(['push', dir, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    expect(h.out()).toContain(`  url: ${MASTER}\n`);
    expect(h.out()).not.toContain('opened in your browser');
    expect(h.opened).toEqual([]);
  });

  it('first push with --open piped: still nothing (CI safety beats the flag)', async () => {
    const dir = await makeDeckDir();
    const h = openingHarness(pushRoutes(false), false);
    expect(await run(['push', dir, '--open', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    expect(h.opened).toEqual([]);
  });

  it('first push with --no-open on a tty: prints the URL, opens nothing', async () => {
    const dir = await makeDeckDir();
    const h = openingHarness(pushRoutes(false), true);
    expect(await run(['push', dir, '--no-open', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    expect(h.out()).toContain(`  url: ${MASTER}\n`);
    expect(h.opened).toEqual([]);
  });

  it('first push --json on a tty: the JSON carries url, byte-exact, and nothing opens', async () => {
    const dir = await makeDeckDir();
    const h = openingHarness(pushRoutes(false), true);
    expect(
      await run(['push', dir, '--json', '--open', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)
    ).toBe(0);
    const parsed = JSON.parse(h.out()) as { url: string; presentation: { id: string }; version: unknown };
    expect(parsed.url).toBe(MASTER);
    expect(parsed.presentation.id).toBe(DECK.id);
    expect(parsed.version).toBeDefined();
    expect(h.opened).toEqual([]);
  });

  it('a later push of a linked folder on a tty: prints the URL, opens nothing', async () => {
    const dir = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'http://x' });
    const h = openingHarness(pushRoutes(true), true);
    expect(await run(['push', dir, '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    expect(h.out()).toContain('version 4');
    expect(h.out()).toContain(`  url: ${MASTER}\n`);
    expect(h.opened).toEqual([]);
  });

  it('a later push with --open on a tty: opens', async () => {
    const dir = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'http://x' });
    const h = openingHarness(pushRoutes(true), true);
    expect(await run(['push', dir, '--open', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    expect(h.opened).toEqual([MASTER]);
  });

  it('a later push --json: url on the existing shape', async () => {
    const dir = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'http://x' });
    const h = openingHarness(pushRoutes(true), true);
    expect(await run(['push', dir, '--json', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    const parsed = JSON.parse(h.out()) as { url: string; version: { version: number } };
    expect(parsed.url).toBe(MASTER);
    expect(parsed.version.version).toBe(4);
    expect(h.opened).toEqual([]);
  });

  it('a deck that embeds a form keeps url next to formsDetected in the JSON, on both branches', async () => {
    // Created branch.
    const dir = await makeDeckDir();
    await writeFile(join(dir, 'index.html'), '<html><form data-slideless-form="signup"></form></html>');
    const h = openingHarness(pushRoutes(false), true);
    expect(await run(['push', dir, '--json', '--url', 'http://x', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    const created = JSON.parse(h.out()) as { url: string; formsDetected: string[] };
    expect(created.url).toBe(MASTER);
    expect(created.formsDetected).toEqual(['signup']);
    // Existing-deck branch.
    const h2 = openingHarness(pushRoutes(true), true);
    expect(await run(['push', dir, '--json', '--url', 'http://x', '--api-key', 'slk_k_s'], h2.io)).toBe(0);
    const pushed = JSON.parse(h2.out()) as {
      url: string;
      formsDetected: string[];
      version: { version: number };
    };
    expect(pushed.url).toBe(MASTER);
    expect(pushed.formsDetected).toEqual(['signup']);
    expect(pushed.version.version).toBe(4);
  });

  it('composes the URL from the resolved base URL, trailing slash or not', async () => {
    const dir = await makeDeckDir();
    const h = openingHarness(pushRoutes(false), false);
    expect(await run(['push', dir, '--url', 'http://x/', '--api-key', 'slk_k_s'], h.io)).toBe(0);
    expect(h.out()).toContain(`  url: http://x/decks/${DECK.id}/present\n`);
  });
});

describe('slideless open', () => {
  it('opens the linked deck page from .slideless.json, no key and no network', async () => {
    const dir = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'https://slides.example.com' });
    const h = openingHarness([], false);
    const code = await run(['open', dir], h.io);
    expect(h.err()).toBe('');
    expect(code).toBe(0);
    const url = `https://slides.example.com/decks/${DECK.id}/present`;
    expect(h.out()).toBe(`${url}\n`);
    expect(h.opened).toEqual([url]);
    expect(h.calls).toHaveLength(0);
  });

  it('--json prints the URL instead of opening', async () => {
    const dir = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'https://slides.example.com' });
    const h = openingHarness([], true);
    expect(await run(['open', dir, '--json'], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      presentationId: DECK.id,
      baseUrl: 'https://slides.example.com',
      url: `https://slides.example.com/decks/${DECK.id}/present`
    });
    expect(h.opened).toEqual([]);
  });

  it("trims a trailing slash on the link file's base URL (read raw, never through the resolver)", async () => {
    const dir = await makeDeckDir();
    await writeLink(dir, { presentationId: DECK.id, baseUrl: 'https://slides.example.com/' });
    const h = openingHarness([], false);
    expect(await run(['open', dir], h.io)).toBe(0);
    expect(h.out()).toBe(`https://slides.example.com/decks/${DECK.id}/present\n`);
    expect(h.opened).toEqual([`https://slides.example.com/decks/${DECK.id}/present`]);
  });

  for (const base of ['javascript:alert(1)//', 'file:///etc', 'not a url', 'ftp://x']) {
    it(`refuses a link file whose instance is ${JSON.stringify(base)} and opens nothing`, async () => {
      const dir = await makeDeckDir();
      await writeLink(dir, { presentationId: DECK.id, baseUrl: base });
      const h = openingHarness([], true);
      expect(await run(['open', dir], h.io)).toBe(1);
      expect(h.err()).toContain('not an http(s) URL');
      expect(h.out()).toBe('');
      expect(h.opened).toEqual([]);
      // --json refuses the same way: no URL is composed from it either.
      const hj = openingHarness([], true);
      expect(await run(['open', dir, '--json'], hj.io)).toBe(1);
      expect(hj.out()).toBe('');
    });
  }

  it('an unlinked folder is a usage error pointing at push', async () => {
    const dir = await makeDeckDir();
    const h = openingHarness([], true);
    expect(await run(['open', dir], h.io)).toBe(1);
    expect(h.err()).toContain('.slideless.json');
    expect(h.err()).toContain('slideless push');
    expect(h.opened).toEqual([]);
  });
});

describe('slideless dev', () => {
  it('opens the local preview through the shared opener, --no-open suppresses it', async () => {
    const dir = await makeDeckDir();
    // `dev` serves until SIGINT or SIGTERM (one `once` listener each); run it
    // unawaited, wait for the open, stop it with one signal, and remove the
    // other's listener so nothing leaks across runs. Vitest's own 5 s test
    // timeout is the safety net: a run that never opens fails red on it.
    const listeners = () => ({
      int: process.listenerCount('SIGINT'),
      term: process.listenerCount('SIGTERM')
    });
    const before = listeners();
    const waitFor = async (done: () => boolean) => {
      const deadline = Date.now() + 4000;
      while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    };
    const stop = (signal: 'SIGINT' | 'SIGTERM') => {
      const other = signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT';
      const pending = process.listeners(other).at(-1);
      process.emit(signal);
      if (pending) process.removeListener(other, pending as () => void);
    };

    const h = openingHarness([], true);
    const running = run(['dev', dir, '--port', '0'], h.io);
    await waitFor(() => h.opened.length > 0);
    stop('SIGINT');
    expect(await running).toBe(0);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(h.out()).toContain(`Serving ${dir} at ${h.opened[0]}`);

    const quiet = openingHarness([], true);
    const runningQuiet = run(['dev', dir, '--port', '0', '--no-open'], quiet.io);
    await waitFor(() => quiet.out().includes('Serving'));
    stop('SIGTERM');
    expect(await runningQuiet).toBe(0);
    expect(quiet.opened).toEqual([]);
    expect(listeners()).toEqual(before);
  });
});
