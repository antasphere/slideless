import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '../src/context.js';

/**
 * Router-style fake fetch: handlers matched by method + path regex, so
 * order-insensitive flows (parallel uploads) stay assertable. Records every
 * call with its parsed body (JSON / FormData summary).
 */

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

export interface Route {
  method: string;
  path: RegExp;
  reply: (call: { path: string; body?: unknown; form?: FormData }) => { status?: number; body?: unknown; raw?: Response };
}

export function routedHarness(routes: Route[], env: Record<string, string | undefined> = {}) {
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname + url.search;
    let body: unknown;
    let form: FormData | undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof FormData) {
      form = init.body;
      body = { sha256: form.get('sha256') };
    }
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const route = routes.find((r) => r.method === method && r.path.test(url.pathname));
    if (!route) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: `no fake route ${method} ${path}` } }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    const result = route.reply({ path, body, ...(form ? { form } : {}) });
    if (result.raw) return result.raw;
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof globalThis.fetch;

  const io: CliIo = {
    env,
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) },
    fetch
  };
  return { io, calls, out: () => out.join(''), err: () => err.join('') };
}

/** A temp HOME-like config root, isolated per test. */
export async function tempConfigEnv(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'slideless-cli-cfg-'));
  return { XDG_CONFIG_HOME: dir };
}

export const DECK = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Test Deck',
  kind: 'presentation',
  interactive: false,
  currentVersion: 1,
  entryPath: 'index.html',
  ownerUserId: 'u1',
  remixedFrom: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

export const VERSION_ROW = {
  presentationId: DECK.id,
  version: 1,
  entryPath: 'index.html',
  sizeBytes: 10,
  fileCount: 1,
  createdBy: 'u1',
  createdByRole: 'owner',
  createdAt: '2026-01-01T00:00:00.000Z'
};
