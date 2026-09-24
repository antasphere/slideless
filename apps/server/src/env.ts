import { z } from 'zod';
import {
  blankToUndefined,
  buildEnvSchema,
  httpUrl,
  numeric,
  parseEnv as parseChassisEnv,
  type EnvExtension,
  type EnvOptions,
  type ToolEnv
} from '@antasphere/chassis-server/env';
import { INTRINSIC_VERSION } from './version.js';

export { hubConfig, type HubConfig } from '@antasphere/chassis-server/env';

/**
 * The Slideless environment: the chassis schema (every generic key, declared in
 * `@antasphere/chassis-server/env`) plus the deck domain's own keys below. The
 * docs env reference is generated from the MERGED schema, so each deck key
 * also says which chassis key it follows.
 */
const deckEnvShape = {
  /**
   * Base URL share links point at (the `/v/{secret}` viewer). Unset (default)
   * = same origin as PUBLIC_BASE_URL — the proven-safe default: user HTML
   * only ever renders under `Content-Security-Policy: sandbox` (opaque
   * origin, never `allow-same-origin`). Setting this to a dedicated
   * user-content origin (a domain that carries no app cookies and no API,
   * fronting the same instance) is the documented hardening path
   * (docs/security/viewer-security-model.md): share URLs are
   * then built on that origin, that hostname serves ONLY decks and the
   * token-authed viewer API (the dashboard, login, /mcp and the rest of
   * /api/v1 answer 404 there; deck links on the app hostname redirect
   * across), the app API refuses requests carrying the viewer origin, and
   * a header regression can no longer expose the dashboard session across a
   * real origin boundary. Must differ from PUBLIC_BASE_URL's origin.
   */
  VIEWER_BASE_URL: z.preprocess(blankToUndefined, httpUrl().optional()),
  /** De-dupe window (minutes) for share-link view counting: repeat opens of the same link from one browser inside this window count once, so browser prefetch/prerender, reloads, and mail-scanner hits no longer inflate a token's accessCount. Enforced with a signed, token-scoped HttpOnly cookie; cookie-less clients that fetch the deck's HTML count every fetch; a fetch that does not ask for HTML gets the link's index and counts as an agent read, never a view. Large values shift the metric toward "unique browsers" rather than "opens". 0 disables de-dupe: every entry GET counts and no cookie is set. */
  VIEW_DEDUPE_WINDOW_MINUTES: numeric(z.coerce.number().int().min(0).default(10)),
  /** Turns the capture of each deck version's still image (PRDCT-2725) on or off. Off, deck cards show the drawn plate. On needs Chromium in the image (the shipped image carries it) and a container that lets Chromium's sandbox start (the compose stack's seccomp profile); a process where the sandbox cannot start logs one error and captures nothing, never running Chromium without its sandbox. About 1–3 s of CPU and 200–300 MB of memory per capture, one capture at a time. */
  SLIDELESS_THUMBNAILS: z.preprocess(blankToUndefined, z.enum(['on', 'off']).default('on')),
  /** The Chromium binary the still-image capture launches. The image's is the default; a path that does not exist turns capture off with one warning at boot. */
  SLIDELESS_CHROMIUM_PATH: z.preprocess(
    blankToUndefined,
    z.string().min(1).default('/usr/bin/chromium-browser')
  ),
  /** Size ceiling, in MB, of ONE file a respondent uploads into a form's file field (PRDCT-2403) — an anonymous write path, so it has its own knob. Never above MAX_FILE_SIZE_MB (the lower of the two applies). 0 switches form file uploads off instance-wide: file fields show as unavailable and the rest of the form still submits. */
  FORMS_MAX_UPLOAD_MB: numeric(z.coerce.number().int().min(0).default(100)),
  /** How many files ONE form response can hold, all file fields together — the instance's ceiling behind the maximum a deck author sets on a field (an author who sets none gets this one). */
  FORMS_MAX_FILES_PER_RESPONSE: numeric(z.coerce.number().int().min(1).max(1000).default(100)),
  /** Total weight, in MB, of the form uploads ONE deck can hold (attached and not yet submitted together). Past it the upload route answers 403 `uploads_full` until the owner deletes responses. The bound on what a share link can write to the instance's disk. */
  FORMS_MAX_UPLOADS_MB_PER_DECK: numeric(z.coerce.number().int().min(1).default(5120)),
  /** Days of per-view share-link analytics events (share_token_views: when a link was opened, referring site host, placement label, browser family — never IPs or full URLs) to keep. Nightly purge at 03:00; 0 = keep forever. */
  VIEW_EVENTS_RETENTION_DAYS: numeric(z.coerce.number().int().min(0).default(90))
};

export type DeckEnvShape = typeof deckEnvShape;

/** The env slot of the tool definition (tool.ts): the deck keys, their placement, their cross-key check. */
export const deckEnvExtension: EnvExtension<DeckEnvShape> = {
  shape: deckEnvShape,
  // Where each deck key sits in the merged schema (and so in the reference).
  after: {
    VIEWER_BASE_URL: 'PUBLIC_BASE_URL',
    VIEW_DEDUPE_WINDOW_MINUTES: 'PUBLIC_BASE_URL',
    SLIDELESS_THUMBNAILS: 'MAX_FILE_SIZE_MB',
    SLIDELESS_CHROMIUM_PATH: 'MAX_FILE_SIZE_MB',
    FORMS_MAX_UPLOAD_MB: 'MAX_FILE_SIZE_MB',
    FORMS_MAX_FILES_PER_RESPONSE: 'MAX_FILE_SIZE_MB',
    FORMS_MAX_UPLOADS_MB_PER_DECK: 'MAX_FILE_SIZE_MB',
    VIEW_EVENTS_RETENTION_DAYS: 'AUDIT_RETENTION_DAYS'
  },
  refine: (env, ctx) => {
    // The viewer origin is a boundary only if it is a DIFFERENT origin: equal
    // to the public origin, the host gate (middleware/host-gate.ts) would put
    // every dashboard, login and API request on the viewer side and answer
    // 404 — a dead instance. Refuse at boot with the fix named.
    if (env.VIEWER_BASE_URL !== undefined) {
      let same = false;
      try {
        same = new URL(env.VIEWER_BASE_URL).origin === new URL(env.PUBLIC_BASE_URL).origin;
      } catch {
        same = false;
      }
      if (same) {
        ctx.addIssue({
          code: 'custom',
          path: ['VIEWER_BASE_URL'],
          message:
            'must be a different origin than PUBLIC_BASE_URL (a second hostname for deck content) — unset it to serve decks on the app origin'
        });
      }
    }
  }
};

const envOptions: EnvOptions<DeckEnvShape> = {
  version: INTRINSIC_VERSION,
  extension: deckEnvExtension
};

export const envSchema = buildEnvSchema(envOptions);

export type Env = ToolEnv<DeckEnvShape>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return parseChassisEnv(source, envOptions);
}
