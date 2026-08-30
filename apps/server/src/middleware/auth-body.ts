import type { MiddlewareHandler } from 'hono';
import { hasNulDeep } from '@slideless/contract';
import { apiError } from '../api/errors.js';

/** Matches better-call's / Hono's JSON content-type test (the json-depth regex). */
const JSON_CONTENT_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * Pre-validates JSON bodies bound for the Better Auth mount (AF-1 + the
 * update-user half of SL-B4, PRDCT-1358).
 *
 * Better Auth catches a JSON parse error INSIDE its own dispatch and answers
 * its own 500 — a response `app.onError` never sees, so the app-level
 * invalid_json mapping that covers every Hono-validated route does not reach
 * `/auth/*`: a malformed or empty JSON body was an anonymous 500 across the
 * whole auth surface. Same story one step later for a NUL character: Better
 * Auth's free-text sinks (`/update-user`'s `name`) are outside the contract,
 * so a NUL rode through to Postgres (SQLSTATE 22021) and surfaced as Better
 * Auth's own 500 — again invisible to the app-level 22021 backstop.
 *
 * So both classes are refused HERE, before the mount: a body under a JSON
 * content-type must parse, and the parsed value must carry no NUL anywhere.
 * Non-JSON content types pass untouched (the OAuth token endpoint is
 * form-encoded), as do bodyless requests. The body is read from a clone —
 * the mount consumes the original.
 */
export function authBodyGuard(): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw;
    if (!raw.body) return next();
    if (!JSON_CONTENT_TYPE.test(raw.headers.get('content-type') ?? '')) return next();
    let text: string;
    try {
      text = await raw.clone().text();
    } catch {
      // Unreadable body — let the mount produce its own error.
      return next();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return apiError(c, 400, 'invalid_json', 'Request body is not valid JSON');
    }
    if (hasNulDeep(parsed)) {
      return apiError(
        c,
        400,
        'invalid_characters',
        'Request contains characters that cannot be stored (e.g. a NUL byte)'
      );
    }
    return next();
  };
}
