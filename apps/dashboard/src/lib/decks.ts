import { t } from '$lib/i18n';
import type { PresentationKind, ShareToken } from '@slideless/contract';

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

/**
 * Hide the page's own transient preview tokens from the share-links panel.
 * SECURITY: keyed on the SERVER-SET `purpose` column, never on the token
 * name — the name is free user input, and a name-keyed filter let any deck
 * writer create a token invisible in the owner's panel. A token merely
 * NAMED "Dashboard preview" (purpose 'share') stays visible.
 */
export function isPreviewToken(token: Pick<ShareToken, 'purpose'>): boolean {
  return token.purpose === 'preview';
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
