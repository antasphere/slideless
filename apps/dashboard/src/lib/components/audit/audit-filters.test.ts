import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  actionFamilies,
  activeCount,
  activeFilters,
  filterKey,
  parseFilters,
  rangeBounds,
  toApiParams,
  toSearchParams,
  toggleAction,
  toggleFamily,
  toggleVia,
  type AuditFilters
} from './audit-filters';

const parse = (qs: string) => parseFilters(new URLSearchParams(qs));

describe('the URL round trip', () => {
  it('reads every filter back from its own query string', () => {
    const filters: AuditFilters = {
      q: 'owner@',
      range: null,
      from: '2026-09-01',
      to: '2026-09-19',
      actor: 'user-1',
      via: ['session', 'api_key'],
      actions: ['presentation.', 'apikey.create'],
      resourceType: 'presentation',
      resourceId: 'deck-1'
    };
    expect(parse(toSearchParams(filters).toString())).toEqual(filters);
  });

  it('keeps only what is set, and a quick range wins over the two days', () => {
    expect(toSearchParams(EMPTY_FILTERS).toString()).toBe('');
    const params = toSearchParams({ ...EMPTY_FILTERS, range: '7d', from: '2026-09-01', to: '2026-09-19' });
    expect(params.toString()).toBe('range=7d');
  });

  it('drops what is malformed instead of carrying it to the API', () => {
    const filters = parse(
      'range=yesterday&from=1/9/2026&via=session,browser&action=a%00b,apikey.create&actor='
    );
    expect(filters.range).toBeNull();
    expect(filters.from).toBeNull();
    expect(filters.via).toEqual(['session']);
    expect(filters.actions).toEqual(['apikey.create']);
    expect(filters.actor).toBeNull();
  });

  it('gives equal filters one key', () => {
    expect(filterKey(parse('via=session&q=a'))).toBe(filterKey(parse('q=a&via=session')));
    expect(filterKey(parse('via=session'))).not.toBe(filterKey(parse('via=api_key')));
  });
});

describe('the time bounds', () => {
  const now = new Date(2026, 8, 19, 15, 30, 0, 0);

  it('resolves a quick range against the clock', () => {
    expect(rangeBounds({ ...EMPTY_FILTERS, range: 'hour' }, now)).toEqual({
      from: new Date(2026, 8, 19, 14, 30).toISOString()
    });
    expect(rangeBounds({ ...EMPTY_FILTERS, range: 'today' }, now)).toEqual({
      from: new Date(2026, 8, 19, 0, 0).toISOString()
    });
    expect(rangeBounds({ ...EMPTY_FILTERS, range: '7d' }, now).from).toBe(
      new Date(2026, 8, 12, 15, 30).toISOString()
    );
    expect(rangeBounds({ ...EMPTY_FILTERS, range: '30d' }, now).from).toBe(
      new Date(2026, 7, 20, 15, 30).toISOString()
    );
  });

  it('turns two days into the whole of both, in the local zone', () => {
    const bounds = rangeBounds({ ...EMPTY_FILTERS, from: '2026-09-01', to: '2026-09-02' }, now);
    expect(bounds.from).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).toISOString());
    expect(bounds.to).toBe(new Date(2026, 8, 2, 23, 59, 59, 999).toISOString());
    expect(rangeBounds(EMPTY_FILTERS, now)).toEqual({});
  });

  it('carries every filter into the API parameters', () => {
    const params = toApiParams(
      {
        ...EMPTY_FILTERS,
        q: 'x',
        actor: 'system',
        via: ['oauth'],
        actions: ['member.'],
        resourceType: 'member',
        resourceId: 'm1'
      },
      now
    );
    expect(params).toEqual({
      q: 'x',
      actor: 'system',
      actorVia: ['oauth'],
      action: ['member.'],
      resourceType: 'member',
      resourceId: 'm1'
    });
  });
});

describe('the action choices', () => {
  it('groups the known vocabulary and the rows’ own actions by family', () => {
    const families = actionFamilies(['zeta.thing', 'presentation.create', 'post /api/v1/x']);
    const names = families.map((f) => f.family);
    const named = names.filter((n) => n !== null);
    expect(named).toEqual([...named].sort());
    expect(names).toContain('zeta');
    // an action without a dot has no family: a single row, after the families
    expect(families[families.length - 1]).toEqual({ family: null, actions: ['post /api/v1/x'] });
    expect(toggleAction(EMPTY_FILTERS, 'post /api/v1/x', true, ['post /api/v1/x']).actions).toEqual([
      'post /api/v1/x'
    ]);
    const presentation = families.find((f) => f.family === 'presentation')!;
    expect(new Set(presentation.actions).size).toBe(presentation.actions.length);
  });

  it('a family replaces its actions, and unticking one inside a family keeps the rest', () => {
    const one = toggleAction(EMPTY_FILTERS, 'apikey.create', true, ['apikey.create', 'apikey.revoke']);
    expect(one.actions).toEqual(['apikey.create']);
    const family = toggleFamily(one, 'apikey', true);
    expect(family.actions).toEqual(['apikey.']);
    const narrowed = toggleAction(family, 'apikey.create', false, ['apikey.create', 'apikey.revoke']);
    expect(narrowed.actions).toEqual(['apikey.revoke']);
    expect(toggleFamily(narrowed, 'apikey', false).actions).toEqual([]);
  });

  it('toggles a via without repeating it', () => {
    const on = toggleVia(toggleVia(EMPTY_FILTERS, 'session', true), 'session', true);
    expect(on.via).toEqual(['session']);
    expect(toggleVia(on, 'session', false).via).toEqual([]);
  });
});

describe('the active tags', () => {
  const label = (id: string) => (id === 'user-1' ? 'Ada' : undefined);
  const via = (v: string) => v.toUpperCase();
  const dayOf = (d: string) => d;

  it('counts the groups, not the search', () => {
    expect(activeCount(EMPTY_FILTERS)).toBe(0);
    expect(activeCount({ ...EMPTY_FILTERS, q: 'x' })).toBe(0);
    expect(activeCount({ ...EMPTY_FILTERS, range: '7d', via: ['session', 'oauth'], resourceId: 'r' })).toBe(
      3
    );
  });

  it('makes one removable tag per filter, each knowing what stays without it', () => {
    const filters: AuditFilters = {
      ...EMPTY_FILTERS,
      from: '2026-09-01',
      actor: 'user-1',
      via: ['session'],
      actions: ['presentation.', 'apikey.create'],
      resourceType: 'presentation'
    };
    const tags = activeFilters(filters, label, via, dayOf);
    expect(tags.map((tag) => tag.label)).toEqual([
      'Since 2026-09-01',
      'Ada',
      'SESSION',
      'presentation.*',
      'apikey.create',
      'presentation'
    ]);
    expect(tags[0]!.remove.from).toBeNull();
    expect(tags[1]!.remove.actor).toBeNull();
    expect(tags[2]!.remove.via).toEqual([]);
    expect(tags[3]!.remove.actions).toEqual(['apikey.create']);
    expect(tags[5]!.remove.resourceType).toBeNull();
    expect(activeFilters({ ...EMPTY_FILTERS, actor: 'unknown' }, label, via, dayOf)[0]!.label).toBe(
      'unknown'
    );
    expect(activeFilters({ ...EMPTY_FILTERS, actor: 'system' }, label, via, dayOf)[0]!.label).toBe('System');
  });
});
