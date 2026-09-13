import { api, errorMessage } from '$lib/api';
import { t } from '$lib/i18n';
import type { MeResponse, Presentation } from '@slideless/contract';

/**
 * The sandboxed preview's token lifecycle (ADR 012 Surface D), shared by the
 * admin page and the deck's master page (PRDCT-2279) so there is ONE preview
 * path. The viewer only speaks share tokens, so the page mints a TRANSIENT
 * preview token through the dedicated endpoint (server-fixed: purpose
 * 'preview', 1 h expiry, no annotations) and revokes it on the way out. The
 * secret lives only in this controller's memory. Preview minting is
 * OWNER-LEVEL (deck owner / workspace admin) — a dev collaborator gets a
 * quiet placeholder instead, never a hidden stat-excluded token. Preview
 * tokens are immutable server-side: switching versions mints a fresh one and
 * bumps `key` so the iframe remounts (the viewer entry is no-store).
 */
export interface PreviewController {
  /** The viewer URL to frame, or null while minting / when unavailable. */
  readonly url: string | null;
  readonly error: string | null;
  /** The version the frame shows (page state), null before the first mint. */
  readonly version: number | null;
  /** Remount key for the iframe — bumps on every version switch. */
  readonly key: number;
  /** Mint the first token for the deck's current version (no-op when nothing to preview). */
  init(deck: Presentation): Promise<void>;
  /** Re-target the frame at another version (a fresh token, the stale one revoked). */
  select(version: number): Promise<void>;
  /** Revoke the live token (best-effort; the server-side 1 h expiry is the backstop). */
  destroy(): void;
}

/** Who may mint a preview token: the deck owner or a workspace admin/owner. */
export function canPreviewDeck(me: MeResponse, deck: Presentation | null): boolean {
  return me.role === 'owner' || me.role === 'admin' || (deck !== null && deck.ownerUserId === me.user.id);
}

export function createPreviewController(
  deckId: string,
  opts: { canPreview: () => boolean; onSelectError?: (message: string) => void } = { canPreview: () => true }
): PreviewController {
  let url = $state<string | null>(null);
  let error = $state<string | null>(null);
  let version = $state<number | null>(null);
  let key = $state(0);
  let tokenId: string | null = null;

  async function mint(v?: number): Promise<void> {
    // Each mint produces its own short-lived token (secrets are
    // unrecoverable — hash-only storage — so reuse is impossible). Other
    // sessions' live previews are never revoked from here; the 1 h expiry
    // is the cleanup. Preview tokens are hidden from the share panel and
    // excluded from view stats (purpose column, server-set).
    const created = await api.createPreviewToken(deckId, v !== undefined ? { version: v } : {});
    const stale = tokenId;
    tokenId = created.shareToken.id;
    url = created.url;
    if (stale) api.revokeShareToken(deckId, stale).catch(() => {});
  }

  return {
    get url() {
      return url;
    },
    get error() {
      return error;
    },
    get version() {
      return version;
    },
    get key() {
      return key;
    },
    async init(deck) {
      if (deck.currentVersion < 1 || !opts.canPreview()) return;
      try {
        await mint();
        version = deck.currentVersion;
      } catch (e) {
        error = errorMessage(e, t('common.genericError'));
      }
    },
    async select(v) {
      if (!tokenId || v === version) return;
      try {
        await mint(v);
        version = v;
        key += 1;
      } catch (e) {
        opts.onSelectError?.(errorMessage(e, t('tokens.updateFailed')));
      }
    },
    destroy() {
      if (tokenId) {
        api.revokeShareToken(deckId, tokenId).catch(() => {});
        tokenId = null;
      }
    }
  };
}
