import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_MS, PlatformClient } from '../src/index.js';

/**
 * PRDCT-1353 / CLI-10 — `fetch` has no default timeout anywhere. Without an
 * AbortSignal a silent (or deliberately stalling) instance parks the caller
 * forever: a CLI invocation that never returns, a dashboard request that
 * never settles. Every call the SDK makes must carry one.
 */

function recordingClient(overrides: { timeoutMs?: number } = {}) {
  const inits: RequestInit[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    inits.push(init ?? {});
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof globalThis.fetch;
  const client = new PlatformClient({
    baseUrl: 'http://x',
    apiKey: 'slk_k_s',
    fetch: fetchImpl,
    ...overrides
  });
  return { client, inits };
}

describe('SDK request deadlines', () => {
  it('puts an AbortSignal on the JSON calls', async () => {
    const { client, inits } = recordingClient();
    await client.instance();
    expect(inits).toHaveLength(1);
    expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(inits[0]!.signal!.aborted).toBe(false);
  });

  it('puts an AbortSignal on the streaming download calls', async () => {
    const { client, inits } = recordingClient();
    await client.downloadExport();
    await client.downloadPresentationAsset('deck', 'a'.repeat(64));
    await client.agentDoc('deck');
    expect(inits).toHaveLength(3);
    for (const init of inits) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('puts an AbortSignal on the upload calls', async () => {
    const { client, inits } = recordingClient();
    await client.uploadFile('a.txt', new Uint8Array([1]), 'text/plain');
    await client.uploadAsset('a'.repeat(64), new Uint8Array([1]), 'text/plain');
    expect(inits).toHaveLength(2);
    for (const init of inits) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('actually aborts once the deadline passes', async () => {
    const stalling = (async (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof globalThis.fetch;
    const client = new PlatformClient({ baseUrl: 'http://x', fetch: stalling, timeoutMs: 20 });
    await expect(client.instance()).rejects.toThrow(/abort/i);
  });

  it('lets an explicit 0 opt out', async () => {
    const { client, inits } = recordingClient({ timeoutMs: 0 });
    await client.instance();
    expect(inits[0]!.signal).toBeUndefined();
  });

  it('documents its default', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
