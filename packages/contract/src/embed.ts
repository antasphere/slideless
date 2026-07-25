import { VIEWER_IFRAME_SANDBOX } from './schemas/share-tokens.js';

/**
 * Embedding snippet builder (PRDCT-1312): the ONE source behind every
 * copyable embed snippet — the dashboard's created-token dialog and the
 * CLI's `share --embed` both call this, so the snippets can never drift
 * from each other or from the ADR 012 Surface D attribute set.
 */

/**
 * Placement labels are owner-chosen slugs, never free text (PRDCT-1313).
 * Shared by the viewer's `?p=` sanitizer and the snippet builder below —
 * the builder REFUSES an invalid label instead of emitting it, because the
 * label lands inside an HTML attribute and a URL.
 */
export const EMBED_PLACEMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface EmbedSnippetOptions {
  /** The share link (viewer URL, canonical trailing-slash form). */
  viewerUrl: string;
  /**
   * Origin serving `/embed.js` — the APP origin (PUBLIC_BASE_URL), never
   * the viewer origin: when VIEWER_BASE_URL points share links elsewhere,
   * the loader still lives on the instance itself.
   */
  appOrigin: string;
  /**
   * Optional placement label baked into the snippet (the `?p=` view-event
   * dimension): the script form carries it as `data-slideless-placement`,
   * the iframe form appends it to the URL. Must match EMBED_PLACEMENT_RE.
   */
  placement?: string | undefined;
}

export interface EmbedSnippets {
  /** The loader URL, e.g. `https://slides.example.com/embed.js`. */
  embedJsUrl: string;
  /** Script + div form: responsive, the recommended snippet. */
  script: string;
  /** Plain-iframe fallback: no script, fixed 16/9, same sandbox attrs. */
  iframe: string;
}

export function buildEmbedSnippets(opts: EmbedSnippetOptions): EmbedSnippets {
  if (opts.placement !== undefined && !EMBED_PLACEMENT_RE.test(opts.placement)) {
    throw new Error(
      'invalid placement label: 1-64 characters of letters, digits, ".", "_" or "-"'
    );
  }
  const embedJsUrl = `${opts.appOrigin.replace(/\/+$/, '')}/embed.js`;
  const placementAttr =
    opts.placement !== undefined ? ` data-slideless-placement="${opts.placement}"` : '';
  const iframeUrl =
    opts.placement !== undefined
      ? `${opts.viewerUrl}${opts.viewerUrl.includes('?') ? '&' : '?'}p=${opts.placement}`
      : opts.viewerUrl;
  return {
    embedJsUrl,
    script: `<script src="${embedJsUrl}" async></script>\n<div data-slideless-embed="${opts.viewerUrl}"${placementAttr}></div>`,
    iframe: `<iframe src="${iframeUrl}" sandbox="${VIEWER_IFRAME_SANDBOX}" referrerpolicy="no-referrer" allow="fullscreen" style="width:100%;aspect-ratio:16/9;border:0"></iframe>`
  };
}
