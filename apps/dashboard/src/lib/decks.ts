import { t } from '$lib/i18n';
import { PREVIEW_SHARE_TOKEN_NAME, type PresentationKind, type ShareToken } from '@slideless/contract';

/**
 * Deck-domain helpers shared by the decks list, the deck detail page, and
 * its panels. Pure functions — unit-tested in decks.test.ts.
 */

/**
 * The exact iframe sandbox set for the dashboard's deck preview — ADR 012
 * Surface D. SECURITY: this must NEVER contain `allow-same-origin` (that
 * single token re-opens full session theft, ADR 012 Surface C) and never
 * `allow-top-navigation*`. decks.test.ts pins both properties.
 */
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';

/**
 * Name of the transient share token the deck detail page mints for its own
 * sandboxed preview (the contract's reserved label — the server excludes it
 * from view aggregates). Preview tokens are short-lived (1 h expiry),
 * revoked when the page goes away, filtered out of the share-links panel,
 * and any stale survivors are revoked before a new one is minted.
 */
export const PREVIEW_TOKEN_NAME = PREVIEW_SHARE_TOKEN_NAME;

/** Preview tokens self-destruct after an hour even if revocation never ran. */
export const PREVIEW_TOKEN_TTL_MS = 60 * 60 * 1000;

export type TokenStatus = 'active' | 'revoked' | 'expired';

/**
 * Status precedence mirrors the viewer's resolution order: revoked (403)
 * beats expired (410) beats active.
 */
export function tokenStatus(
  token: Pick<ShareToken, 'revokedAt' | 'expiresAt'>,
  now: Date = new Date()
): TokenStatus {
  if (token.revokedAt) return 'revoked';
  if (token.expiresAt && new Date(token.expiresAt) <= now) return 'expired';
  return 'active';
}

/** Hide the page's own transient preview tokens from the share-links panel. */
export function isPreviewToken(token: Pick<ShareToken, 'name'>): boolean {
  return token.name === PREVIEW_TOKEN_NAME;
}

export function kindLabel(kind: PresentationKind): string {
  switch (kind) {
    case 'app':
      return t('decks.kindApp');
    case 'plan':
      return t('decks.kindPlan');
    default:
      return t('decks.kindPresentation');
  }
}
