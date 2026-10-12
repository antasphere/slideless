import type { AppEntry, AppsList } from '@slideless/contract';
import { formatDate } from '$lib/format';
import { api } from '$lib/api';
import { t } from '$lib/i18n';

/**
 * The Apps page's words for one card: the sentence and the quiet facts line.
 * The list itself comes from the SDK's `api.apps()` (`GET /apps`, a session's
 * alone), read by the page.
 */

/** The tools the page knows a sentence for (both languages, `apps.desc.*`). */
const KNOWN = {
  finance: 'apps.desc.finance',
  hiring: 'apps.desc.hiring',
  meet: 'apps.desc.meet',
  crm: 'apps.desc.crm',
  steward: 'apps.desc.steward'
} as const;

/**
 * The card's sentence: the page's own for a known tool, this tool's own sentence on its
 * own card (`apps.descHere`: a tool born from the template rewrites it), else the
 * operator's description, else a generic one.
 */
export function appSentence(app: Pick<AppEntry, 'slug' | 'description'> & { current?: boolean }): string {
  const key = KNOWN[app.slug as keyof typeof KNOWN];
  if (key) return t(key);
  if (app.current) return t('apps.descHere');
  return app.description ?? t('apps.descGeneric');
}

/** The page's order: this tool's own card first (after the account's), the others as the list gives them. */
export function hereFirst<T extends { current: boolean }>(apps: readonly T[]): T[] {
  return [...apps.filter((a) => a.current), ...apps.filter((a) => !a.current)];
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

// ── The rail's fold ─────────────────────────────────────────────────────────

/** "Antasphere Finance" reads "Finance" in the fold: every row is the company's. */
export function shortAppName(name: string): string {
  return name.replace(/^antasph[eè]re\s+/iu, '');
}

export interface FoldRow {
  key: string;
  name: string;
  /** Where the row opens, in a new tab; null on this tool's own row, which is never a link. */
  href: string | null;
  /** This tool: named like the others, marked as where the reader is. */
  current: boolean;
}

/**
 * The rows the rail unfolds under the Apps entry: the account first when the list names it,
 * then the tools in the list's order, each named without the company's name in front. This
 * tool's own row carries no address: the reader is already here, and a link to it would open
 * the dashboard again in another tab.
 */
export function foldRows(list: Pick<AppsList, 'apps' | 'hub'>): FoldRow[] {
  const apps = list.apps.map((app) => ({
    key: app.slug,
    name: shortAppName(app.name),
    href: app.current ? null : app.launchUrl,
    current: app.current
  }));
  return list.hub
    ? [{ key: 'hub', name: shortAppName(list.hub.name), href: list.hub.url, current: false }, ...apps]
    : apps;
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
