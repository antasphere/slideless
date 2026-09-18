import { toast } from 'svelte-sonner';
import { PlatformApiError } from '@slideless/sdk';
import { errorMessage } from '$lib/api';
import { t } from '$lib/i18n';

/**
 * THE download path of the dashboard (PRDCT-2426, ADR 014). Every file the
 * dashboard hands to the person goes through here, never through a plain
 * `<a href>`: an anchor navigation cannot carry `X-Workspace-Id`, so on an
 * account with several workspaces it asks the DEFAULT workspace for a file of
 * the ACTIVE one, and the server answers 404.
 *
 * The bytes are fetched by the API client's own download methods (its
 * headers: the session cookie, the active workspace), buffered ONCE as a
 * Blob (`res.blob()`, nothing read twice, no intermediate ArrayBuffer), and
 * saved through a temporary object URL that is revoked afterwards. The name
 * is the server's (`Content-Disposition`), the caller's only as a fallback. A
 * refusal becomes a sentence on screen instead of a click that does nothing.
 *
 * Trade-off, the one the settings export already accepted: the whole file
 * sits in memory before the save dialog. Fine at deck scale; a multi-GB
 * export should move to a server-tokenized download URL.
 */

/** How long the object URL outlives the click: some browsers start reading it a beat later. */
export const REVOKE_DELAY_MS = 10_000;

/** A loading toast appears only for a download slower than this (a big zip), never as a flash. */
export const SLOW_DOWNLOAD_MS = 600;

const FALLBACK_NAME = 'download';

/**
 * The file name a `Content-Disposition` carries: `filename*` (RFC 5987,
 * UTF-8) first, then the quoted or bare `filename`. null when it names none.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const extended = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended) {
    const value = extended[1]!.trim().replace(/^"(.*)"$/, '$1');
    const parts = /^([\w!#$%&+\-^`{}~]*)'[^']*'(.*)$/.exec(value);
    if (parts && /^utf-8$/i.test(parts[1]!)) {
      try {
        const decoded = safeFilename(decodeURIComponent(parts[2]!));
        if (decoded) return decoded;
      } catch {
        // A malformed percent-sequence: fall through to the plain parameter.
      }
    }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header);
  if (quoted) return safeFilename(quoted[1]!.replace(/\\(.)/g, '$1')) || null;
  const bare = /(?:^|;)\s*filename\s*=\s*([^;"\s][^;]*)/i.exec(header);
  if (bare) return safeFilename(bare[1]!) || null;
  return null;
}

/**
 * A name fit for the `download` attribute: one path segment, no control
 * characters, no bidirectional controls. Names reach here from respondents and deck authors, so a
 * separator becomes `_` rather than a folder, and a dot-only name is refused.
 */
export function safeFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // The Unicode bidirectional controls: embeddings and overrides (U+202A to
    // U+202E), isolates (U+2066 to U+2069), the marks (U+200E, U+200F,
    // U+061C). Invisible, and an override makes `<RLO>txt.exe` DISPLAY as
    // `exe.txt` in a save dialog. Right-to-left text itself is untouched.
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, '')
    .replace(/[/\\]/g, '_')
    .trim();
  return /^\.*$/.test(cleaned) ? '' : cleaned;
}

/**
 * Hand a Blob to the browser's save flow under `name`; the object URL is
 * revoked afterwards.
 *
 * SECURITY: an object URL belongs to THIS origin, and the bytes may be a
 * respondent's or a deck author's (an HTML file, an SVG). The invariant
 * "never render user content on the app origin" holds here too: the Blob is
 * re-typed `application/octet-stream` (a `slice` shares the bytes, it does
 * not copy them), so even an object URL that got navigated to instead of
 * saved could only ever download. The saved file keeps its name, and with it
 * its extension.
 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob.slice(0, blob.size, 'application/octet-stream'));
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename(name) || FALLBACK_NAME;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

export interface SaveDownloadOptions {
  /** Used only when the answer names no file. */
  fallbackName?: string;
}

/**
 * Fetch through the API client and save. `fetcher` is one of the client's
 * download methods (`() => api.downloadVersionAttachment(…)`), so the request
 * carries the active workspace. Throws what the client throws
 * (`PlatformApiError` on a refusal): `download()` below is the form with the
 * sentence on screen. Returns the name the file was saved under.
 */
export async function saveDownload(
  fetcher: () => Promise<Response>,
  options: SaveDownloadOptions = {}
): Promise<string> {
  const res = await fetcher();
  const name =
    filenameFromContentDisposition(res.headers.get('content-disposition')) ??
    (safeFilename(options.fallbackName ?? '') || FALLBACK_NAME);
  saveBlob(await res.blob(), name);
  return name;
}

/** The sentence for a download that did not happen. */
export function downloadErrorMessage(e: unknown): string {
  if (e instanceof PlatformApiError && e.status === 404) return t('download.notFound');
  if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return t('download.timedOut');
  }
  if (e instanceof TypeError) return t('download.network');
  return errorMessage(e, t('download.failed'));
}

/**
 * What a component calls: save the file, say so on screen when it cannot be
 * saved, and show that something is happening when it takes a while. Never
 * throws; resolves to whether the file was saved.
 */
export async function download(
  fetcher: () => Promise<Response>,
  options: SaveDownloadOptions = {}
): Promise<boolean> {
  let loadingToast: string | number | undefined;
  const slow = setTimeout(() => {
    loadingToast = toast.loading(t('download.preparing'));
  }, SLOW_DOWNLOAD_MS);
  try {
    await saveDownload(fetcher, options);
    return true;
  } catch (e) {
    toast.error(downloadErrorMessage(e));
    return false;
  } finally {
    clearTimeout(slow);
    if (loadingToast !== undefined) toast.dismiss(loadingToast);
  }
}
