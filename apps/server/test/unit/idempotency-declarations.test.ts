import { describe, expect, it } from 'vitest';
import { idempotencyHeaders } from '@antasphere/chassis-contract/routes';
import * as deckRoutes from '@slideless/contract/routes';
import { isDeckIdempotencyTarget } from '../../src/middleware/deck-idempotency.js';

/**
 * A route that declares the `Idempotency-Key` header promises a replay: the
 * SDK sends the key on every such call, and a client that retries a timed-out
 * write with the same key expects the first answer back, not a second write.
 * The chassis claims keys on POST only, and only on the paths a tool hands it
 * (`isDeckIdempotencyTarget`), so a declaration anywhere else is a promise the
 * instance never keeps (the PRDCT-3641 double check: a PATCH of a document's
 * data retried with one key minted two versions).
 */

interface RouteLike {
  method: string;
  path: string;
  request?: { headers?: unknown };
}

const isRoute = (v: unknown): v is RouteLike =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as RouteLike).method === 'string' &&
  typeof (v as RouteLike).path === 'string';

/** Declared before the data-bound templates lane and never a target: listed here, left to a ticket. */
const KNOWN_UNKEPT = new Set(['post /presentations/{id}/collaborators']);

// The deck domain only: the chassis's own routes (api keys, workspaces, …) ride on the same
// export, built by `defineChassisRoutes`, and the chassis keeps their keys itself.
const declaring = (Object.values(deckRoutes) as unknown[])
  .filter(isRoute)
  .filter((r) => r.path.startsWith('/presentations'))
  .filter((r) => r.request?.headers === idempotencyHeaders);

describe('every Idempotency-Key a deck route declares is one the instance keeps', () => {
  it('the walk finds the declarations', () => {
    expect(declaring.map((r) => `${r.method} ${r.path}`)).toContain('post /presentations/{id}/instances');
  });

  it.each(declaring.map((r) => [`${r.method} ${r.path}`, r] as const))('%s', (name, route) => {
    if (KNOWN_UNKEPT.has(name)) return;
    const path = `/api/v1${route.path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000')}`;
    expect(route.method, `${name}: the chassis claims keys on POST only`).toBe('post');
    expect(isDeckIdempotencyTarget(path), `${name}: declared but not a deck idempotency target`).toBe(true);
  });

  it('the document writes that cannot replay do not declare it', () => {
    for (const r of [
      deckRoutes.templateSchemaSetRoute,
      deckRoutes.documentDataReplaceRoute,
      deckRoutes.documentDataMergeRoute,
      deckRoutes.documentAnswerClearRoute
    ]) {
      expect((r as RouteLike).request?.headers, `${r.method} ${r.path}`).toBeUndefined();
    }
  });
});
