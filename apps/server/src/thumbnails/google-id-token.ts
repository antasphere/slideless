import type { Logger } from '@antasphere/chassis-server/logger';

/**
 * A Google-signed identity token for the renderer's Cloud Run service
 * (PRDCT-2785). On the cloud the renderer is a PRIVATE service: Cloud Run
 * admits a request only when it carries an identity token of a principal
 * holding `roles/run.invoker` on it, and the only such principal is this
 * instance's service account. The token is minted by the metadata server of
 * the Cloud Run instance this process runs on (no key, no secret in the
 * environment) for the audience the renderer's URL names, and presented in
 * `X-Serverless-Authorization`, which Cloud Run reads for IAM and does not
 * pass on, so the shared secret keeps `Authorization` to itself.
 *
 * Only the transport is authenticated here; the one-time key protocol is
 * unchanged (renderer-client.ts).
 */
export type IdTokenSource = () => Promise<string | null>;

export const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

/** A token is reused until this long before it expires (Google mints them for one hour). */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** After a failed mint, the next ask waits this long before asking the metadata server again. */
const FAILURE_BACKOFF_MS = 10_000;

export interface GoogleIdTokenOptions {
  /** The renderer service's URL; its origin is the token's audience (Cloud Run's default audience). */
  audience: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** The `exp` claim of a JWT, in ms, or null when the token is not a readable JWT. */
export function jwtExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The token source: one token cached until five minutes before its expiry,
 * one mint in flight at a time, and null (never a throw) when the metadata
 * server cannot give one, so the hand-off counts as an unreachable renderer
 * and costs the version no attempt.
 */
export function googleIdTokenSource(opts: GoogleIdTokenOptions): IdTokenSource {
  const audience = new URL(opts.audience).origin;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`;

  let cached: { token: string; refreshAt: number } | null = null;
  let failedAt = -Infinity;
  let inFlight: Promise<string | null> | null = null;

  const mint = async (): Promise<string | null> => {
    try {
      const res = await fetchImpl(url, {
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error'
      });
      const body = (await res.text()).trim();
      const expiry = res.ok ? jwtExpiryMs(body) : null;
      if (expiry === null) {
        opts.logger.error(
          { status: res.status },
          'thumbnails: the metadata server gave no identity token for the renderer (is this instance on Cloud Run with a service account?)'
        );
        failedAt = now();
        return null;
      }
      cached = { token: body, refreshAt: expiry - REFRESH_MARGIN_MS };
      return body;
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'thumbnails: the metadata server is unreachable, no identity token for the renderer'
      );
      failedAt = now();
      return null;
    }
  };

  return async () => {
    if (cached && now() < cached.refreshAt) return cached.token;
    if (now() - failedAt < FAILURE_BACKOFF_MS) return null;
    inFlight ??= mint().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
