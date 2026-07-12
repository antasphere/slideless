import { describe, expect, it } from 'vitest';
import { DEFAULT_HUB_DIALS, HubStatusClient, type HubStatusDials } from '../../src/identity/hub-status.js';
import type { Logger } from '../../src/logger.js';

/**
 * HubStatusClient — the D5 cache discipline, pinned with an injected clock
 * and fetch (no HTTP): TTL, stale-while-error, the fail-closed window,
 * outage throttling, single-flight, and the exact H2 response mapping
 * (ONLY a definitive 200 {active:false} reads as inactive; 401/403/404/5xx/
 * network/malformed are all inconclusive).
 */

const noopLogger = { error: () => {}, info: () => {}, warn: () => {} } as unknown as Logger;

const DIALS: HubStatusDials = {
  orgTtlMs: 1_000,
  orgStaleMaxMs: 10_000,
  retryMs: 500,
  memberTtlMs: 5_000,
  timeoutMs: 1_000
};

const ORG = '11111111-aaaa-4bbb-8ccc-00000000cafe';

interface FetchCall {
  url: string;
  auth: string | null;
}

/** A scriptable fetch: each queued step answers one call; the last step repeats. */
function scriptedFetch(steps: Array<() => Response | Error>) {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), auth: headers.get('authorization') });
    const step = steps.length > 1 ? steps.shift()! : steps[0]!;
    const out = step();
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { impl, calls };
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function makeClient(steps: Array<() => Response | Error>, dials: HubStatusDials = DIALS) {
  let nowMs = 1_000_000;
  const { impl, calls } = scriptedFetch(steps);
  const client = new HubStatusClient({
    issuerUrl: 'https://hub.test',
    serviceKey: 'ant_unit_test_key',
    logger: noopLogger,
    dials,
    fetchImpl: impl,
    now: () => nowMs
  });
  return { client, calls, advance: (ms: number) => (nowMs += ms) };
}

describe('orgStatus cache discipline (D5)', () => {
  it('fetches once, serves from cache within the TTL, and presents the service key', async () => {
    const { client, calls } = makeClient([() => jsonRes(200, { status: 'active', kind: 'organization' })]);
    expect(await client.orgStatus(ORG)).toBe('active');
    expect(await client.orgStatus(ORG)).toBe('active');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://hub.test/api/v1/accounts/${ORG}/status`);
    expect(calls[0]!.auth).toBe('Bearer ant_unit_test_key');
  });

  it('a definitive suspended answer replaces the cached active at the next refresh', async () => {
    const { client, calls, advance } = makeClient([
      () => jsonRes(200, { status: 'active', kind: 'organization' }),
      () => jsonRes(200, { status: 'suspended', kind: 'organization' })
    ]);
    expect(await client.orgStatus(ORG)).toBe('active');
    advance(DIALS.orgTtlMs + 1);
    // Expired entry: this call serves stale and kicks the refresh…
    expect(await client.orgStatus(ORG)).toBe('active');
    await new Promise((r) => setTimeout(r, 0)); // let the refresh land
    // …which is now the enforced value: the detection bound is TTL + RTT.
    expect(await client.orgStatus(ORG)).toBe('suspended');
    expect(calls).toHaveLength(2);
  });

  it('404 is definitive: cached and enforced as not_found', async () => {
    const { client, calls } = makeClient([() => jsonRes(404, { error: { code: 'not_found' } })]);
    expect(await client.orgStatus(ORG)).toBe('not_found');
    expect(await client.orgStatus(ORG)).toBe('not_found');
    expect(calls).toHaveLength(1);
  });

  it('errors serve the last value stale within the window, then fail CLOSED', async () => {
    const { client, advance } = makeClient([
      () => jsonRes(200, { status: 'active', kind: 'organization' }),
      () => new Error('connect ECONNREFUSED')
    ]);
    expect(await client.orgStatus(ORG)).toBe('active');
    advance(DIALS.orgTtlMs + 1);
    expect(await client.orgStatus(ORG)).toBe('active'); // stale-served, refresh failing
    await new Promise((r) => setTimeout(r, 0));
    advance(DIALS.orgStaleMaxMs); // beyond the stale window from the last SUCCESS
    expect(await client.orgStatus(ORG)).toBe('unavailable'); // fail closed
  });

  it('an error with NO prior success fails closed immediately and throttles re-probes', async () => {
    const { client, calls, advance } = makeClient([() => new Error('connect ECONNREFUSED')]);
    expect(await client.orgStatus(ORG)).toBe('unavailable');
    // Within retryMs: no new attempt (a down hub costs one probe per window).
    expect(await client.orgStatus(ORG)).toBe('unavailable');
    expect(calls).toHaveLength(1);
    advance(DIALS.retryMs + 1);
    expect(await client.orgStatus(ORG)).toBe('unavailable');
    expect(calls).toHaveLength(2);
  });

  it('recovers after an outage: the next successful probe restores active', async () => {
    const { client, advance } = makeClient([
      () => new Error('boom'),
      () => jsonRes(200, { status: 'active', kind: 'organization' })
    ]);
    expect(await client.orgStatus(ORG)).toBe('unavailable');
    advance(DIALS.retryMs + 1);
    expect(await client.orgStatus(ORG)).toBe('active');
  });

  it('5xx and malformed bodies take the error path, never a definitive value', async () => {
    const bad = makeClient([() => jsonRes(500, { error: 'boom' })]);
    expect(await bad.client.orgStatus(ORG)).toBe('unavailable');
    const malformed = makeClient([() => jsonRes(200, { status: 'weird' })]);
    expect(await malformed.client.orgStatus(ORG)).toBe('unavailable');
  });

  it('concurrent cold misses share ONE fetch (single-flight)', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      await gate;
      return jsonRes(200, { status: 'active', kind: 'organization' });
    }) as typeof fetch;
    const client = new HubStatusClient({
      issuerUrl: 'https://hub.test',
      serviceKey: 'ant_unit_test_key',
      logger: noopLogger,
      dials: DIALS,
      fetchImpl: impl
    });
    const [a, b] = [client.orgStatus(ORG), client.orgStatus(ORG)];
    release!();
    expect(await a).toBe('active');
    expect(await b).toBe('active');
    expect(calls).toHaveLength(1);
  });

  it('ships the production dials from D5/D3', () => {
    expect(DEFAULT_HUB_DIALS.orgTtlMs).toBe(60_000);
    expect(DEFAULT_HUB_DIALS.orgStaleMaxMs).toBe(900_000);
    expect(DEFAULT_HUB_DIALS.memberTtlMs).toBe(300_000);
  });
});

describe('memberStatus response mapping (H2 contract)', () => {
  const SUB = 'hub-user-123';
  const path = `https://hub.test/api/v1/accounts/${ORG}/members/${SUB}/status`;

  it('200 {active:true, role} → active with the validated role', async () => {
    const { client, calls } = makeClient([() => jsonRes(200, { active: true, role: 'admin' })]);
    expect(await client.memberStatus(ORG, SUB)).toEqual({ kind: 'active', role: 'admin' });
    expect(calls[0]!.url).toBe(path);
    expect(calls[0]!.auth).toBe('Bearer ant_unit_test_key');
  });

  it('200 {active:true} with an unknown/absent role → active, role null (keep local)', async () => {
    const unknown = makeClient([() => jsonRes(200, { active: true, role: 'emperor' })]);
    expect(await unknown.client.memberStatus(ORG, SUB)).toEqual({ kind: 'active', role: null });
    const absent = makeClient([() => jsonRes(200, { active: true })]);
    expect(await absent.client.memberStatus(ORG, SUB)).toEqual({ kind: 'active', role: null });
  });

  it('200 {active:false} is the ONLY deactivation signal', async () => {
    const { client } = makeClient([() => jsonRes(200, { active: false })]);
    expect(await client.memberStatus(ORG, SUB)).toEqual({ kind: 'inactive' });
  });

  it('401/403 (broken service key) are inconclusive — never a deactivation', async () => {
    for (const status of [401, 403]) {
      const { client } = makeClient([() => jsonRes(status, { error: { code: 'nope' } })]);
      expect(await client.memberStatus(ORG, SUB)).toEqual({ kind: 'inconclusive' });
    }
  });

  it('404 (a hub without H2) is inconclusive — fail open', async () => {
    const { client } = makeClient([() => jsonRes(404, { error: { code: 'not_found' } })]);
    expect(await client.memberStatus(ORG, SUB)).toEqual({ kind: 'inconclusive' });
  });

  it('5xx, network errors, and malformed bodies are inconclusive', async () => {
    const http = makeClient([() => jsonRes(500, { error: 'boom' })]);
    expect(await http.client.memberStatus(ORG, SUB)).toEqual({ kind: 'inconclusive' });
    const net = makeClient([() => new Error('socket hang up')]);
    expect(await net.client.memberStatus(ORG, SUB)).toEqual({ kind: 'inconclusive' });
    const malformed = makeClient([() => jsonRes(200, { active: 'yes' })]);
    expect(await malformed.client.memberStatus(ORG, SUB)).toEqual({ kind: 'inconclusive' });
    const unparseable = makeClient([() => new Response('not json', { status: 200 })]);
    expect(await unparseable.client.memberStatus(ORG, SUB)).toEqual({ kind: 'inconclusive' });
  });

  it('is uncached here: every call fetches (the caller owns the D3 cache)', async () => {
    const { client, calls } = makeClient([() => jsonRes(200, { active: true, role: 'member' })]);
    await client.memberStatus(ORG, SUB);
    await client.memberStatus(ORG, SUB);
    expect(calls).toHaveLength(2);
  });
});
