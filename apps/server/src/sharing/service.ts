import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  presentations,
  shareTokens,
  type BadgePosition,
  type Db,
  type ShareTokenPurpose,
  type ShareTokenRow
} from '@slideless/db';
import type { PepperRegistry } from '../apikeys/peppers.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';

/**
 * Per-recipient share tokens (Phase 4). The recipient credential is a
 * 48-byte (384-bit) random secret carried in the viewer URL path
 * (`/v/{secret}`); the database stores ONLY `sha256(secret + pepper)` — the
 * same peppering the API keys use (ADR 008), so a leaked database alone can
 * neither validate nor forge share links.
 *
 * One deliberate difference from API keys: the secret carries no key-id and
 * no pepper-version indicator (the URL must stay a single opaque path
 * segment), so resolution computes the candidate hash under EVERY registered
 * pepper version and matches the unique token_hash index — O(rotations),
 * and a version dropped from the registry fails closed exactly like a key.
 *
 * Timing note: the hash lookup is an index probe, not a comparison oracle —
 * with 384 bits of secret entropy, remote timing yields nothing usable.
 */
export const SHARE_SECRET_BYTES = 48; // 64 base64url chars

/**
 * Preview tokens (purpose 'preview') self-destruct after an hour. The TTL is
 * SERVER-fixed at mint time (api/presentations.ts preview-token route) and
 * preview tokens are immutable, so nothing can extend one into a long-lived
 * hidden link.
 */
export const PREVIEW_TOKEN_TTL_MS = 60 * 60 * 1000;

function hashSecret(secret: string, pepper: string): string {
  return createHash('sha256')
    .update(secret + pepper)
    .digest('hex');
}

export interface MintedShareSecret {
  /** The recipient secret, base64url — shown once, never stored. */
  secret: string;
  /** sha256(secret + current pepper), what the row stores. */
  tokenHash: string;
}

export class ShareTokenService {
  constructor(
    private readonly db: Db,
    private readonly peppers: PepperRegistry
  ) {}

  /** Mint a fresh secret + its stored hash under the CURRENT pepper version. */
  mintSecret(): MintedShareSecret {
    const secret = randomBytes(SHARE_SECRET_BYTES).toString('base64url');
    const pepper = this.peppers.get(this.peppers.current);
    if (pepper === undefined) {
      throw new Error(`pepper registry has no current version ${this.peppers.current}`);
    }
    return { secret, tokenHash: hashSecret(secret, pepper) };
  }

  async create(opts: {
    workspaceId: string;
    presentationId: string;
    createdBy: string;
    name: string;
    /**
     * SECURITY: set by the HANDLER from its code path, never from request
     * input. Only the dedicated preview-token route (owner/admin gated)
     * passes 'preview'; the public token-create route always passes 'share'.
     */
    purpose: ShareTokenPurpose;
    pinnedVersion: number | null;
    canAnnotate: boolean;
    /** Forms default ON (share route) — the preview mint passes false. */
    canSubmitForms: boolean;
    /**
     * Downloads default ON (share route, PRDCT-2278); the preview mint
     * passes true too — an owner's preview shows what a default link shows,
     * and preview downloads are never counted (viewer/routes.ts).
     */
    canDownload: boolean;
    /**
     * The recipient top bar, default ON (share route, PRDCT-2281); the
     * preview mint passes true too — the owner's preview shows what a
     * default link shows.
     */
    showBar: boolean;
    /**
     * The link remembers its answers (PRDCT-2328). The share route passes
     * the contract default (true); the preview mint passes false — and the
     * remembering resolver refuses previews by purpose regardless.
     */
    remembersResponses: boolean;
    /**
     * Respondents may upload files into the form's file fields (PRDCT-2403).
     * The share route passes the contract default (true); the preview mint
     * passes false, and the upload route refuses previews by purpose too.
     */
    canUploadFiles: boolean;
    /** Explicit badge slot for this link, or null = inherit the deck default. */
    badgePosition: BadgePosition | null;
    expiresAt: Date | null;
    passwordHash: string | null;
  }): Promise<{ row: ShareTokenRow; secret: string }> {
    const { secret, tokenHash } = this.mintSecret();
    const [row] = await this.db
      .insert(shareTokens)
      .values({
        workspaceId: opts.workspaceId,
        presentationId: opts.presentationId,
        name: opts.name,
        purpose: opts.purpose,
        tokenHash,
        pinnedVersion: opts.pinnedVersion,
        canAnnotate: opts.canAnnotate,
        canSubmitForms: opts.canSubmitForms,
        canDownload: opts.canDownload,
        showBar: opts.showBar,
        remembersResponses: opts.remembersResponses,
        canUploadFiles: opts.canUploadFiles,
        badgePosition: opts.badgePosition,
        expiresAt: opts.expiresAt,
        passwordHash: opts.passwordHash,
        createdBy: opts.createdBy
      })
      .returning();
    if (!row) throw new Error('share token insert failed');
    return { row, secret };
  }

  async list(
    workspaceId: string,
    presentationId: string,
    opts: { cursor?: string; limit: number }
  ): Promise<{ tokens: ShareTokenRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    const rows = await this.db
      .select()
      .from(shareTokens)
      .where(
        and(
          eq(shareTokens.presentationId, presentationId),
          eq(shareTokens.workspaceId, workspaceId),
          ...(cursorId
            ? [
                keysetBefore({
                  table: shareTokens,
                  id: shareTokens.id,
                  createdAt: shareTokens.createdAt,
                  // Scope the cursor subquery to THIS deck (the versions-
                  // listing precedent): a foreign deck's cursor cannot
                  // position here.
                  workspaceId: shareTokens.presentationId,
                  cursorId,
                  workspace: presentationId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(shareTokens.createdAt), desc(shareTokens.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(rows, opts.limit);
    return { tokens: page, nextCursor };
  }

  async get(workspaceId: string, presentationId: string, tokenId: string): Promise<ShareTokenRow | null> {
    const [row] = await this.db
      .select()
      .from(shareTokens)
      .where(
        and(
          eq(shareTokens.id, tokenId),
          eq(shareTokens.presentationId, presentationId),
          eq(shareTokens.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /** Apply a pre-computed patch; returns the updated row (null = gone). */
  async update(tokenId: string, set: Partial<ShareTokenRow>): Promise<ShareTokenRow | null> {
    const [row] = await this.db.update(shareTokens).set(set).where(eq(shareTokens.id, tokenId)).returning();
    return row ?? null;
  }

  /** Soft revoke (idempotent): access stats survive, the viewer answers 403. */
  async revoke(tokenId: string): Promise<ShareTokenRow | null> {
    await this.db
      .update(shareTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(shareTokens.id, tokenId), sql`${shareTokens.revokedAt} IS NULL`));
    const [row] = await this.db.select().from(shareTokens).where(eq(shareTokens.id, tokenId)).limit(1);
    return row ?? null;
  }

  /**
   * Resolve a presented viewer secret to its token row, or null. Candidate
   * hashes are computed under every registered pepper version (see the
   * module doc); revocation/expiry/password are POLICY, judged by the
   * viewer with distinct statuses (403/410/401) — this stays a pure lookup.
   */
  async resolveBySecret(secret: string): Promise<ShareTokenRow | null> {
    if (secret.length < 20 || secret.length > 128) return null;
    const candidates: string[] = [];
    for (const version of this.peppers.versions) {
      const pepper = this.peppers.get(version);
      if (pepper !== undefined) candidates.push(hashSecret(secret, pepper));
    }
    if (candidates.length === 0) return null;
    const [row] = await this.db
      .select()
      .from(shareTokens)
      .where(inArray(shareTokens.tokenHash, candidates))
      .limit(1);
    return row ?? null;
  }

  /**
   * Entry-view accounting, atomic increments in one transaction: the TOKEN's
   * access stats and the deck's total. Fired ONLY when the viewer serves the
   * ENTRY HTML — never per asset, never for password-gate challenges.
   */
  async recordEntryView(tokenId: string, presentationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(shareTokens)
        .set({ accessCount: sql`${shareTokens.accessCount} + 1`, lastAccessedAt: sql`now()` })
        .where(eq(shareTokens.id, tokenId));
      await tx
        .update(presentations)
        .set({ totalViews: sql`${presentations.totalViews} + 1`, lastViewedAt: sql`now()` })
        .where(eq(presentations.id, presentationId));
    });
  }
}

/** Wire mapping shared by the API handlers (never the secret, never a hash). */
export function shareTokenToWire(t: ShareTokenRow): {
  id: string;
  presentationId: string;
  name: string;
  purpose: ShareTokenPurpose;
  versionMode: 'latest' | 'pinned';
  pinnedVersion: number | null;
  canAnnotate: boolean;
  canSubmitForms: boolean;
  canDownload: boolean;
  showBar: boolean;
  remembersResponses: boolean;
  canUploadFiles: boolean;
  badgePosition: BadgePosition | null;
  expiresAt: string | null;
  hasPassword: boolean;
  revokedAt: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  downloadCount: number;
  createdAt: string;
} {
  return {
    id: t.id,
    presentationId: t.presentationId,
    name: t.name,
    purpose: t.purpose,
    versionMode: t.pinnedVersion === null ? 'latest' : 'pinned',
    pinnedVersion: t.pinnedVersion,
    canAnnotate: t.canAnnotate,
    canSubmitForms: t.canSubmitForms,
    canDownload: t.canDownload,
    showBar: t.showBar,
    remembersResponses: t.remembersResponses,
    canUploadFiles: t.canUploadFiles,
    badgePosition: t.badgePosition,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    hasPassword: t.passwordHash !== null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
    accessCount: t.accessCount,
    lastAccessedAt: t.lastAccessedAt?.toISOString() ?? null,
    downloadCount: t.downloadCount,
    createdAt: t.createdAt.toISOString()
  };
}

/**
 * The share URL a recipient opens. `VIEWER_BASE_URL` (when set) points share
 * links at a dedicated user-content origin — the ADR 012 hardening path;
 * unset, links ride the instance origin (`PUBLIC_BASE_URL`), where the
 * viewer's `CSP: sandbox` is the proven-safe MVP boundary. Deliberately a
 * config knob, not request-Host derived: the Host header is client-supplied.
 */
export function buildViewerUrl(
  env: { PUBLIC_BASE_URL: string; VIEWER_BASE_URL?: string | undefined },
  secret: string
): string {
  const base = (env.VIEWER_BASE_URL ?? env.PUBLIC_BASE_URL).replace(/\/$/, '');
  // Trailing slash on purpose: the entry serves at /v/{secret}/ so the
  // deck's RELATIVE references resolve inside the token's subtree (the
  // no-slash form is a 301) — see viewer/routes.ts "Entry URL
  // canonicalization".
  return `${base}/v/${secret}/`;
}
