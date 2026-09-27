import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@antasphere/chassis-server/logger';
import {
  METADATA_IDENTITY_URL,
  googleIdTokenSource,
  jwtExpiryMs
} from '../../src/thumbnails/google-id-token.js';
import { HttpRendererClient, type RendererJob } from '../../src/thumbnails/renderer-client.js';

/**
 * The app's side of the renderer hand-off (PRDCT-2725) and, on the cloud,
 * the identity token Cloud Run requires to admit it (PRDCT-2785).
 */
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const SECRET = 'a-shared-secret-of-sixteen';
const job: RendererJob = {
  job: '33333333-3333-4333-8333-333333333333',
  token: 'K'.repeat(43),
  entryPath: 'index.html',
  deadline: '2026-09-27T10:00:00.000Z'
};

function jwt(expSeconds: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ aud: 'https://renderer.example', exp: expSeconds })}.sig`;
}

type Call = { url: string; init: RequestInit };
function recorder(answer: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer(String(url));
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name];

describe('jwtExpiryMs', () => {
  it('reads the exp claim in milliseconds, and null for anything that is not a JWT with one', () => {
    expect(jwtExpiryMs(jwt(1_800_000_000))).toBe(1_800_000_000_000);
    expect(jwtExpiryMs('not-a-jwt')).toBeNull();
    expect(jwtExpiryMs('a.%%%.c')).toBeNull();
    expect(jwtExpiryMs(`a.${Buffer.from('{"aud":"x"}').toString('base64url')}.c`)).toBeNull();
  });
});

describe('googleIdTokenSource', () => {
  it('asks the metadata server for the renderer origin as audience, with the metadata header', async () => {
    const t = jwt(2_000_000);
    const { calls, fetchImpl } = recorder(() => new Response(t));
    const source = googleIdTokenSource({
      audience: 'https://renderer-abc-ew.a.run.app/some/path',
      logger,
      fetchImpl,
      now: () => 1_000_000_000
    });
    expect(await source()).toBe(t);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent('https://renderer-abc-ew.a.run.app')}`
    );
    expect(header(calls[0]!, 'metadata-flavor')).toBe('Google');
  });

  it('reuses the token until five minutes before it expires, then mints a new one', async () => {
    let clock = 0;
    let n = 0;
    const { calls, fetchImpl } = recorder(() => new Response(jwt(3600 + n++)));
    const source = googleIdTokenSource({
      audience: 'https://r.example',
      logger,
      fetchImpl,
      now: () => clock
    });
    const first = await source();
    clock = (3600 - 301) * 1000;
    expect(await source()).toBe(first);
    expect(calls).toHaveLength(1);
    clock = (3600 - 299) * 1000;
    const second = await source();
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  it('mints once for concurrent asks', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls, fetchImpl } = recorder(async () => {
      await gate;
      return new Response(jwt(9_999_999_999));
    });
    const source = googleIdTokenSource({ audience: 'https://r.example', logger, fetchImpl, now: () => 0 });
    const all = Promise.all([source(), source(), source()]);
    release();
    const tokens = await all;
    expect(new Set(tokens).size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('answers null, never throws, on a refusal, a body that is not a token, or no metadata server; and backs off before asking again', async () => {
    let clock = 0;
    for (const answer of [
      () => new Response('nope', { status: 404 }),
      () => new Response('<html>not a token</html>'),
      () => Promise.reject(new TypeError('fetch failed'))
    ]) {
      const { calls, fetchImpl } = recorder(answer as () => Response);
      const source = googleIdTokenSource({
        audience: 'https://r.example',
        logger,
        fetchImpl,
        now: () => clock
      });
      expect(await source()).toBeNull();
      clock += 9_999;
      expect(await source()).toBeNull();
      expect(calls).toHaveLength(1);
      clock += 2;
      expect(await source()).toBeNull();
      expect(calls).toHaveLength(2);
    }
  });
});

describe('googleIdTokenSource past the refresh point', () => {
  it('keeps presenting the cached token while a refresh fails, until ten seconds before it expires', async () => {
    let clock = 0;
    let fail = false;
    const t = jwt(3600);
    const { calls, fetchImpl } = recorder(() =>
      fail ? new Response('down', { status: 500 }) : new Response(t)
    );
    const source = googleIdTokenSource({
      audience: 'https://r.example',
      logger,
      fetchImpl,
      now: () => clock
    });
    expect(await source()).toBe(t);
    fail = true;
    clock = 3301 * 1000; // past the refresh point, the refresh fails
    expect(await source()).toBe(t);
    expect(calls).toHaveLength(2);
    clock = 3589 * 1000; // still 11 s of life
    expect(await source()).toBe(t);
    clock = 3591 * 1000; // 9 s left: no longer presented
    expect(await source()).toBeNull();
  });

  it('keeps the cached token when the metadata server is unreachable, and through the backoff after', async () => {
    let clock = 0;
    let down = false;
    const t = jwt(3600);
    const { calls, fetchImpl } = recorder(() =>
      down ? (Promise.reject(new TypeError('fetch failed')) as never) : new Response(t)
    );
    const source = googleIdTokenSource({
      audience: 'https://r.example',
      logger,
      fetchImpl,
      now: () => clock
    });
    expect(await source()).toBe(t);
    down = true;
    clock = 3301 * 1000; // refresh due, the metadata server unreachable
    expect(await source()).toBe(t);
    expect(calls).toHaveLength(2);
    clock += 5_000; // inside the backoff: no new ask, the token still presented
    expect(await source()).toBe(t);
    expect(calls).toHaveLength(2);
    clock = 3700 * 1000; // expired 100 s ago, the server still unreachable
    expect(await source()).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('never re-presents a short-lived token past its own expiry', async () => {
    let clock = 0;
    let n = 0;
    const { calls, fetchImpl } = recorder(() => new Response(jwt(10 + n++ * 100))); // ten seconds of life
    const source = googleIdTokenSource({
      audience: 'https://r.example',
      logger,
      fetchImpl,
      now: () => clock
    });
    const first = await source();
    clock = 15_000; // past its expiry, within the thirty seconds of minimum reuse
    const second = await source();
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  it('reuses for at least thirty seconds a token minted already inside the refresh margin', async () => {
    let clock = 1_000_000;
    const { calls, fetchImpl } = recorder(() => new Response(jwt(1_000 + 120))); // two minutes of life
    const source = googleIdTokenSource({
      audience: 'https://r.example',
      logger,
      fetchImpl,
      now: () => clock
    });
    await Promise.all([source(), source(), source(), source(), source()]);
    expect(calls).toHaveLength(1);
    clock += 29_000;
    await source();
    expect(calls).toHaveLength(1);
    clock += 2_000;
    await source();
    expect(calls).toHaveLength(2);
  });
});

describe('HttpRendererClient', () => {
  it('presents the shared secret alone when no identity token is configured (the compose stack)', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(null, { status: 202 }));
    const client = new HttpRendererClient({
      baseUrl: 'http://renderer:3100',
      secret: SECRET,
      logger,
      fetchImpl
    });
    expect(await client.submit(job)).toBe('queued');
    expect(calls[0]!.url).toBe('http://renderer:3100/capture');
    expect(header(calls[0]!, 'authorization')).toBe(`Bearer ${SECRET}`);
    expect(header(calls[0]!, 'x-serverless-authorization')).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ v: 1, ...job });
  });

  it('adds the identity token in its own header on the cloud, the secret staying in Authorization', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(null, { status: 202 }));
    const client = new HttpRendererClient({
      baseUrl: 'https://renderer-abc-ew.a.run.app',
      secret: SECRET,
      logger,
      fetchImpl,
      idToken: async () => 'the.id.token'
    });
    expect(await client.submit(job)).toBe('queued');
    expect(header(calls[0]!, 'x-serverless-authorization')).toBe('Bearer the.id.token');
    expect(header(calls[0]!, 'authorization')).toBe(`Bearer ${SECRET}`);
  });

  it('makes no call without a token, and reports the renderer unreachable (no attempt spent, no wrong-secret alarm)', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(null, { status: 202 }));
    const client = new HttpRendererClient({
      baseUrl: 'https://renderer-abc-ew.a.run.app',
      secret: SECRET,
      logger,
      fetchImpl,
      idToken: async () => null
    });
    expect(await client.submit(job)).toBe('unreachable');
    expect(calls).toHaveLength(0);
  });

  it('on the cloud, names Google sign-in AND the secret when refused, so the operator looks at both', async () => {
    const error = vi.fn();
    const log = { ...logger, error } as unknown as Logger;
    const { fetchImpl } = recorder(() => new Response(null, { status: 403 }));
    const cloud = new HttpRendererClient({
      baseUrl: 'https://r.example',
      secret: SECRET,
      logger: log,
      fetchImpl,
      idToken: async () => 't.t.t'
    });
    expect(await cloud.submit(job)).toBe('unauthorized');
    expect(error).toHaveBeenCalledTimes(1);
    const { fetchImpl: f401 } = recorder(() => new Response(null, { status: 401 }));
    const cloud401 = new HttpRendererClient({
      baseUrl: 'https://r.example',
      secret: SECRET,
      logger: log,
      fetchImpl: f401,
      idToken: async () => 't.t.t'
    });
    expect(await cloud401.submit(job)).toBe('unauthorized');
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0]![1])).toMatch(/run\.invoker.*SLIDELESS_RENDERER_SECRET/);
    const compose = new HttpRendererClient({
      baseUrl: 'http://renderer:3100',
      secret: SECRET,
      logger: log,
      fetchImpl
    });
    expect(await compose.submit(job)).toBe('unauthorized');
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('maps the answers: 202 queued, 503 busy, 401 and 403 unauthorized, anything else or no answer unreachable', async () => {
    for (const [status, outcome] of [
      [202, 'queued'],
      [503, 'busy'],
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [500, 'unreachable']
    ] as const) {
      const { fetchImpl } = recorder(() => new Response(null, { status }));
      const client = new HttpRendererClient({
        baseUrl: 'http://renderer:3100',
        secret: SECRET,
        logger,
        fetchImpl
      });
      expect(await client.submit(job)).toBe(outcome);
    }
    const { fetchImpl } = recorder(() => Promise.reject(new TypeError('fetch failed')) as never);
    const client = new HttpRendererClient({
      baseUrl: 'http://renderer:3100',
      secret: SECRET,
      logger,
      fetchImpl
    });
    expect(await client.submit(job)).toBe('unreachable');
  });
});
