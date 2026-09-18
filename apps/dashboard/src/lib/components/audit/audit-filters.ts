/**
 * The audit log's filters: one plain object, kept in the page's URL query
 * string (a filtered view is a link, and it survives a reload), and turned
 * into the API's own parameters at request time. The quick ranges are
 * relative ("last 7 days" is a rule, not two instants), so they resolve
 * against the clock when the request goes out.
 */
import type { AuditListParams } from '@slideless/sdk';
import type { AuditVia } from '@slideless/contract';
import { t } from '$lib/i18n';

export type QuickRange = 'hour' | 'today' | '7d' | '30d';
export const QUICK_RANGES: QuickRange[] = ['hour', 'today', '7d', '30d'];
export const VIAS: AuditVia[] = ['session', 'api_key', 'oauth', 'system'];

/** The actor filter's reserved word: rows nobody signed. */
export const ACTOR_SYSTEM = 'system';

export interface AuditFilters {
  /** Free text: actor email or action. */
  q: string;
  /** A quick range, or null when the two dates (or nothing) bound the list. */
  range: QuickRange | null;
  /** Calendar days, `YYYY-MM-DD`, in the viewer's own zone. */
  from: string | null;
  to: string | null;
  /** A member's user id, `system`, or null for anyone. */
  actor: string | null;
  via: AuditVia[];
  /** Actions, or families when they end in `.` (`presentation.`). */
  actions: string[];
  resourceType: string | null;
  resourceId: string | null;
}

export const EMPTY_FILTERS: AuditFilters = {
  q: '',
  range: null,
  from: null,
  to: null,
  actor: null,
  via: [],
  actions: [],
  resourceType: null,
  resourceId: null
};

/**
 * Every action the server writes today, so the panel offers the whole
 * vocabulary before a single row of a family has loaded. Kept in step with
 * the `c.set('audit', { action })` calls of apps/server by hand; an action
 * the rows carry and this list lacks still shows, from the rows.
 */
export const KNOWN_ACTIONS: string[] = [
  'apikey.create',
  'apikey.revoke',
  'break_glass.claim_ownership',
  'break_glass.reset_two_factor',
  'collaborator.claim',
  'file.delete',
  'file.upload',
  'instance.setup',
  'invitation.accept',
  'invitation.create',
  'invitation.revoke',
  'member.change_email_link',
  'member.deactivate',
  'member.delete',
  'member.reset_link',
  'member.update',
  'presentation.annotation_create',
  'presentation.annotation_delete',
  'presentation.annotation_update',
  'presentation.asset_upload',
  'presentation.collaborator_invite',
  'presentation.collaborator_revoke',
  'presentation.create',
  'presentation.delete',
  'presentation.duplicate',
  'presentation.form_response_delete',
  'presentation.form_response_files_download',
  'presentation.preview_token_create',
  'presentation.share_token_create',
  'presentation.share_token_revoke',
  'presentation.share_token_send',
  'presentation.share_token_update',
  'presentation.update',
  'presentation.upload_session_create',
  'presentation.version_commit',
  'user.account_delete',
  'user.erasure_replay_refused',
  'user.erasure_replayed',
  'user.orphan_purge',
  'workspace.export'
];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VIA_SET = new Set<string>(VIAS);
const RANGE_SET = new Set<string>(QUICK_RANGES);
// what the API admits for an action item; anything else is dropped at parse
const ACTION_RE = /^[a-z0-9_.\-/ ]+$/;

const day = (value: string | null): string | null => (value && DAY_RE.test(value) ? value : null);
const text = (value: string | null, max: number): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed && trimmed.length <= max ? trimmed : null;
};
const list = (value: string | null): string[] =>
  value
    ? [...new Set(value.split(',').map((v) => v.trim()))].filter(
        (v) => v && v.length <= 120 && ACTION_RE.test(v)
      )
    : [];

/** The filters a URL carries; anything malformed reads as "not set". */
export function parseFilters(params: URLSearchParams): AuditFilters {
  const range = params.get('range');
  const via = list(params.get('via')).filter((v): v is AuditVia => VIA_SET.has(v));
  return {
    q: text(params.get('q'), 120) ?? '',
    range: range && RANGE_SET.has(range) ? (range as QuickRange) : null,
    from: day(params.get('from')),
    to: day(params.get('to')),
    actor: text(params.get('actor'), 64),
    via,
    actions: list(params.get('action')).slice(0, 20),
    resourceType: text(params.get('type'), 64),
    resourceId: text(params.get('id'), 200)
  };
}

/** The URL of a filter set: only what is set, in a fixed order, so equal filters make equal links. */
export function toSearchParams(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.range) params.set('range', filters.range);
  else {
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
  }
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.via.length) params.set('via', filters.via.join(','));
  if (filters.actions.length) params.set('action', filters.actions.join(','));
  if (filters.resourceType) params.set('type', filters.resourceType);
  if (filters.resourceId) params.set('id', filters.resourceId);
  return params;
}

/** One string per filter set: the key a page compares to know the list must start over. */
export function filterKey(filters: AuditFilters): string {
  return toSearchParams(filters).toString();
}

/** The instants a quick range or the two days bound, resolved against `now` in the viewer's zone. */
export function rangeBounds(filters: AuditFilters, now: Date = new Date()): { from?: string; to?: string } {
  if (filters.range) {
    const from = new Date(now);
    if (filters.range === 'hour') from.setTime(now.getTime() - 3_600_000);
    else if (filters.range === 'today') from.setHours(0, 0, 0, 0);
    else if (filters.range === '7d') from.setDate(now.getDate() - 7);
    else from.setDate(now.getDate() - 30);
    return { from: from.toISOString() };
  }
  const bounds: { from?: string; to?: string } = {};
  if (filters.from) bounds.from = localDay(filters.from, 0, 0, 0, 0).toISOString();
  if (filters.to) bounds.to = localDay(filters.to, 23, 59, 59, 999).toISOString();
  return bounds;
}

// a `YYYY-MM-DD` at a time of day, in the viewer's own zone (not UTC)
function localDay(value: string, h: number, m: number, s: number, ms: number): Date {
  const [y, mo, d] = value.split('-').map(Number);
  return new Date(y!, mo! - 1, d!, h, m, s, ms);
}

/** What the API is asked, minus the page cursor and size. */
export function toApiParams(filters: AuditFilters, now: Date = new Date()): AuditListParams {
  const params: AuditListParams = { ...rangeBounds(filters, now) };
  if (filters.q) params.q = filters.q;
  if (filters.actor) params.actor = filters.actor;
  if (filters.via.length) params.actorVia = filters.via;
  if (filters.actions.length) params.action = filters.actions;
  if (filters.resourceType) params.resourceType = filters.resourceType;
  if (filters.resourceId) params.resourceId = filters.resourceId;
  return params;
}

/** How many of the panel's groups hold something (the search field is not one of them). */
export function activeCount(filters: AuditFilters): number {
  let n = 0;
  if (filters.range || filters.from || filters.to) n++;
  if (filters.actor) n++;
  if (filters.via.length) n++;
  if (filters.actions.length) n++;
  if (filters.resourceType || filters.resourceId) n++;
  return n;
}

export const isFiltering = (filters: AuditFilters): boolean => activeCount(filters) > 0 || filters.q !== '';

/** A family is the part before the first dot; an action without one (`get /api/v1/me`, the fallback of an unlabelled route) has none. */
export function familyOf(action: string): string | null {
  const dot = action.indexOf('.');
  return dot > 0 ? action.slice(0, dot) : null;
}

/**
 * The actions on offer, grouped by family and sorted: the fixed vocabulary
 * plus what the rows carry. The families come first; the actions without
 * one follow as single rows (`family` null).
 */
export function actionFamilies(seen: Iterable<string>): { family: string | null; actions: string[] }[] {
  const byFamily = new Map<string, Set<string>>();
  const plain = new Set<string>();
  for (const action of [...KNOWN_ACTIONS, ...seen]) {
    if (!ACTION_RE.test(action)) continue;
    const family = familyOf(action);
    if (family === null) {
      plain.add(action);
      continue;
    }
    if (!byFamily.has(family)) byFamily.set(family, new Set());
    byFamily.get(family)!.add(action);
  }
  return [
    ...[...byFamily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([family, actions]) => ({ family, actions: [...actions].sort() })),
    ...[...plain].sort().map((action) => ({ family: null, actions: [action] }))
  ];
}

/** Whether the family (`presentation.`) or every one of its actions is selected. */
export function familySelected(filters: AuditFilters, family: string): boolean {
  return filters.actions.includes(`${family}.`);
}

/** Toggle one action: selecting it inside a selected family narrows the family to the rest. */
export function toggleAction(
  filters: AuditFilters,
  action: string,
  on: boolean,
  siblings: string[]
): AuditFilters {
  const family = `${familyOf(action)}.`;
  let actions = filters.actions.filter((a) => a !== action);
  if (actions.includes(family)) {
    actions = actions.filter((a) => a !== family).concat(siblings.filter((a) => a !== action));
    if (on) actions.push(action);
  } else if (on) actions.push(action);
  return { ...filters, actions: [...new Set(actions)] };
}

/** Toggle a whole family: on replaces its actions with the family, off drops both. */
export function toggleFamily(filters: AuditFilters, family: string, on: boolean): AuditFilters {
  const rest = filters.actions.filter((a) => familyOf(a) !== family && a !== `${family}.`);
  return { ...filters, actions: on ? [...rest, `${family}.`] : rest };
}

export function toggleVia(filters: AuditFilters, via: AuditVia, on: boolean): AuditFilters {
  const rest = filters.via.filter((v) => v !== via);
  return { ...filters, via: on ? [...rest, via] : rest };
}

/** One removable tag per active filter, each with the filters that remain once it goes. */
export interface ActiveFilter {
  key: string;
  label: string;
  remove: AuditFilters;
}

export function activeFilters(
  filters: AuditFilters,
  memberLabel: (userId: string) => string | undefined,
  viaLabel: (via: AuditVia) => string,
  formatDay: (day: string) => string
): ActiveFilter[] {
  const tags: ActiveFilter[] = [];
  if (filters.range) {
    tags.push({ key: 'range', label: t(RANGE_KEYS[filters.range]), remove: { ...filters, range: null } });
  } else if (filters.from && filters.to) {
    tags.push({
      key: 'range',
      label: t('audit.tagBetween', { from: formatDay(filters.from), to: formatDay(filters.to) }),
      remove: { ...filters, from: null, to: null }
    });
  } else if (filters.from) {
    tags.push({
      key: 'range',
      label: t('audit.tagSince', { from: formatDay(filters.from) }),
      remove: { ...filters, from: null }
    });
  } else if (filters.to) {
    tags.push({
      key: 'range',
      label: t('audit.tagUntil', { to: formatDay(filters.to) }),
      remove: { ...filters, to: null }
    });
  }
  if (filters.actor) {
    tags.push({
      key: 'actor',
      label:
        filters.actor === ACTOR_SYSTEM
          ? t('audit.actorSystem')
          : (memberLabel(filters.actor) ?? filters.actor),
      remove: { ...filters, actor: null }
    });
  }
  for (const via of filters.via) {
    tags.push({ key: `via:${via}`, label: viaLabel(via), remove: toggleVia(filters, via, false) });
  }
  for (const action of filters.actions) {
    tags.push({
      key: `action:${action}`,
      label: action.endsWith('.') ? `${action}*` : action,
      remove: { ...filters, actions: filters.actions.filter((a) => a !== action) }
    });
  }
  if (filters.resourceType) {
    tags.push({ key: 'type', label: filters.resourceType, remove: { ...filters, resourceType: null } });
  }
  if (filters.resourceId) {
    tags.push({ key: 'id', label: filters.resourceId, remove: { ...filters, resourceId: null } });
  }
  return tags;
}

export const RANGE_KEYS = {
  hour: 'audit.rangeHour',
  today: 'audit.rangeToday',
  '7d': 'audit.range7d',
  '30d': 'audit.range30d'
} as const;
