import { en as shellEn } from './en';
import { fr as shellFr } from './fr';
import { en as toolEn, fr as toolFr } from '$lib/tool/i18n';

/**
 * Dashboard i18n — deliberately tiny (see ADR 007).
 *
 * The locale is resolved ONCE per page load and never changes afterwards:
 * `setLocale` persists the choice and reloads the page. Because of that,
 * `t()` is a plain synchronous function — no runes, no stores, no
 * reactivity plumbing anywhere. Both catalogs are statically imported, so
 * key parity is a compile-time guarantee (each fr half is `Record<keyof
 * typeof en, string>` against its English half).
 *
 * Each catalog is two halves merged here: the shell's words (./en, ./fr) and
 * the tool's (`$lib/tool/i18n`, the shell's second door into the tool's half,
 * see `$lib/contribution.ts`). Every string reads the same as before the
 * split; `MessageKey` is the union of the two key sets.
 */

/** A key is in one half only: a key in both would let the tool's string win in silence. */
type Overlap = keyof typeof shellEn & keyof typeof toolEn;
const noOverlap: [Overlap] extends [never] ? true : Overlap = true;
void noOverlap;

const en = { ...shellEn, ...toolEn };
const fr = { ...shellFr, ...toolFr };
type MessageKey = keyof typeof en;

export const LANGS = ['en', 'fr'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'en';

/** localStorage key for the persisted choice. */
export const LANG_STORAGE_KEY = 'platform.lang';

const catalogs: Record<Lang, Record<MessageKey, string>> = { en, fr };

function isLang(value: string | null | undefined): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/**
 * Resolution order: persisted choice → browser language (fr* → fr) →
 * English. Guarded so it is also safe under vitest's node environment.
 */
export function resolveLocale(): Lang {
  try {
    const stored = globalThis.localStorage?.getItem(LANG_STORAGE_KEY);
    if (isLang(stored)) return stored;
  } catch {
    // localStorage can throw (privacy modes) — fall through to the default.
  }
  if (globalThis.navigator?.language?.toLowerCase().startsWith('fr')) return 'fr';
  return DEFAULT_LANG;
}

// Resolved lazily on first use so import order never matters; fixed for the
// rest of the page's life.
let current: Lang | null = null;

export function getLocale(): Lang {
  current ??= resolveLocale();
  return current;
}

/**
 * App-boot hook (root +layout.ts): resolves the locale and mirrors it onto
 * <html lang> for screen readers and UA hyphenation/spellcheck.
 */
export function initLocale(): Lang {
  const lang = getLocale();
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  return lang;
}

/**
 * Persist the choice and reload: the locale is fixed per page load, so a
 * full reload is the apply mechanism (this is what keeps t() rune-free).
 */
export function setLocale(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // Nothing to persist onto — the reload still applies it via navigator
    // language or the default.
  }
  window.location.reload();
}

/**
 * Translate a key, interpolating `{name}` placeholders from `params`.
 * Fallback chain: active locale → English → the key itself (the first two
 * are type-guaranteed complete; belt and braces against runtime surprises).
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalogs[getLocale()][key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  );
}

export { en, fr };
export type { MessageKey };
