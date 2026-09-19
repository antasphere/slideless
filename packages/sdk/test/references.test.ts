import { describe, expect, it } from 'vitest';
import { PlatformApiError, PlatformClient } from '../src/index.js';

/**
 * References (ADR 025) on the SDK: the presentations list's `type` and
 * `default` filters, the two conveniences built on them, and the two
 * reference properties of the PATCH. The route-coverage guard compares
 * pathnames only, so the QUERY STRING is pinned here.
 */

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

const deck = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, ...extra });

function recordingClient(answer: unknown = { presentations: [], nextCursor: null }, status = 200) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://x');
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    });
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof globalThis.fetch;
  return { client: new PlatformClient({ baseUrl: 'http://x', apiKey: 'slk_k_s', fetch: fetchImpl }), calls };
}

describe('presentations() reference filters', () => {
  it('sends no type and no default when neither is asked (the ordinary-deck listing)', async () => {
    const { client, calls } = recordingClient();
    await client.presentations();
    expect(calls).toEqual([{ method: 'GET', path: '/api/v1/presentations', query: {}, body: undefined }]);
  });

  it('sends type beside the cursor and the limit', async () => {
    const { client, calls } = recordingClient();
    await client.presentations({ type: 'brand', cursor: 'c1', limit: 10 });
    expect(calls[0]!.query).toEqual({ type: 'brand', cursor: 'c1', limit: '10' });
  });

  it("sends default as the literal 'true', and never sends a false", async () => {
    const { client, calls } = recordingClient();
    await client.presentations({ type: 'template', default: true });
    await client.presentations({ type: 'template', default: false });
    expect(calls[0]!.query).toEqual({ type: 'template', default: 'true' });
    expect(calls[1]!.query).toEqual({ type: 'template' });
  });
});

describe('references()', () => {
  it('lists every reference by default', async () => {
    const { client, calls } = recordingClient();
    await client.references();
    expect(calls[0]!.path).toBe('/api/v1/presentations');
    expect(calls[0]!.query).toEqual({ type: 'reference' });
  });

  it('narrows to one type and pages like any list', async () => {
    const { client, calls } = recordingClient();
    await client.references({ type: 'brand', cursor: 'c2', limit: 5 });
    expect(calls[0]!.query).toEqual({ type: 'brand', cursor: 'c2', limit: '5' });
  });

  it('returns the page as the server answered it', async () => {
    const page = { presentations: [deck('a'), deck('b')], nextCursor: 'next' };
    const { client } = recordingClient(page);
    await expect(client.references()).resolves.toEqual(page);
  });
});

describe('defaultReference()', () => {
  it('asks the list for the default of that type and returns the first', async () => {
    const found = deck('house', {
      reference: { type: 'brand' },
      audience: 'workspace',
      defaultReference: true
    });
    const { client, calls } = recordingClient({ presentations: [found], nextCursor: null });
    await expect(client.defaultReference('brand')).resolves.toEqual(found);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.path).toBe('/api/v1/presentations');
    expect(calls[0]!.query).toEqual({ type: 'brand', default: 'true', limit: '1' });
  });

  it('answers null when the workspace has no default of that type', async () => {
    const { client } = recordingClient({ presentations: [], nextCursor: null });
    await expect(client.defaultReference('template')).resolves.toBeNull();
  });
});

describe('updatePresentation() on a reference', () => {
  it('sends audience and defaultReference in the PATCH body', async () => {
    const { client, calls } = recordingClient(deck('d'));
    await client.updatePresentation('d', { audience: 'workspace', defaultReference: true });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.path).toBe('/api/v1/presentations/d');
    expect(calls[0]!.body).toEqual({ audience: 'workspace', defaultReference: true });
  });

  it.each([
    [422, 'not_a_reference'],
    [409, 'audience_private'],
    [409, 'default_reference']
  ])('surfaces %i %s as a PlatformApiError carrying the code', async (status, code) => {
    const { client } = recordingClient({ error: { code, message: 'refused' } }, status);
    const failure = await client.updatePresentation('d', { defaultReference: true }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PlatformApiError);
    expect((failure as PlatformApiError).status).toBe(status);
    expect((failure as PlatformApiError).code).toBe(code);
  });
});
