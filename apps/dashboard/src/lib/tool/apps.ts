import type { AppEntry, AppsList } from '@antasphere/chassis-contract';
import { formatDate } from '$lib/format';
import { api } from '$lib/api';
import { t } from '$lib/i18n';

/**
 * The Apps page's words for one card: the sentence and the quiet facts line,
 * and the order the fold and the page show the tools in. The list itself
 * comes from the chassis (`api.apps()`, `GET /apps`, a session's alone): the
 * hub's catalogue as the person sees it, each tool with the descriptor its
 * registry entry declares once (PRDCT-3493), so this file knows no tool by
 * name.
 */

/**
 * The card's sentence: the registry's description when the descriptor has
 * one, this tool's own sentence on its own card otherwise (`apps.descHere`: a
 * tool born from the template rewrites it), else a generic one.
 */
export function appSentence(app: Pick<AppEntry, 'descriptor'> & { current?: boolean }): string {
  if (app.descriptor?.description) return app.descriptor.description;
  if (app.current) return t('apps.descHere');
  return t('apps.descGeneric');
}

/** "Antasphere Finance" sorts and reads as "Finance": every tool is the company's. */
export function shortName(name: string): string {
  return name.replace(/^antasph[eè]re\s+/iu, '');
}

/** The rows by short name, the locale's way, case and accents ignored; the input left alone. */
export function sortApps<T extends { name: string }>(apps: readonly T[]): T[] {
  return [...apps].sort((a, b) =>
    shortName(a.name).localeCompare(shortName(b.name), undefined, { sensitivity: 'base' })
  );
}

/** The page's order: this tool's own card first (after the account's), the others by name. */
export function hereFirst<T extends { current: boolean; name: string }>(apps: readonly T[]): T[] {
  const sorted = sortApps(apps);
  return [...sorted.filter((a) => a.current), ...sorted.filter((a) => !a.current)];
}

/** The quiet line under the sentence: connected since, last used; null when the list says neither. */
export function appFact(app: Pick<AppEntry, 'firstUsedAt' | 'lastUsedAt'>): string | null {
  const parts: string[] = [];
  if (app.firstUsedAt) parts.push(t('apps.connectedSince', { date: formatDate(app.firstUsedAt) }));
  if (app.lastUsedAt) parts.push(t('apps.lastUsed', { date: formatDate(app.lastUsedAt) }));
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

// ── One read for the page and the rail ───────────────────────────────────────

let pending: Promise<AppsList> | null = null;

/**
 * The list, read once per visit and shared by the Apps page and the rail's fold (the server
 * holds its own five-minute answer per person). A failed read is forgotten, so the next
 * caller asks again.
 */
export function loadApps(): Promise<AppsList> {
  if (!pending) {
    pending = api.apps().catch((e: unknown) => {
      pending = null;
      throw e;
    });
  }
  return pending;
}
