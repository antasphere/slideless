import { PlatformClient, PlatformApiError } from '@slideless/sdk';
import { t } from '$lib/i18n';

/** Same-origin client — the HttpOnly session cookie rides every call. */
export const api = new PlatformClient();

export { PlatformApiError };

/**
 * Human-readable message for a thrown API error (toast copy). Only the
 * FALLBACKS are localized — a server-originated e.message passes through
 * untranslated (the API speaks English; see docs/i18n.md).
 */
export function errorMessage(e: unknown, fallback = t('common.genericError')): string {
  if (e instanceof PlatformApiError) {
    if (e.status === 429) return t('common.tooManyAttempts');
    return e.message || fallback;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}
