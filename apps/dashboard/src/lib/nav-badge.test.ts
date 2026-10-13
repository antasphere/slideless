import { describe, expect, it } from 'vitest';
import { badgeView } from './nav-badge';

describe('a menu entry’s badge (NavItem.badge)', () => {
  it('a count pill, capped at 99+, with the sentence a screen reader hears', () => {
    expect(badgeView({ count: 3, tone: 'alert', label: '3 mentions' })).toEqual({
      kind: 'count',
      text: '3',
      label: '3 mentions',
      alert: true
    });
    expect(badgeView({ count: 250 })).toMatchObject({ text: '99+', label: '250 new', alert: false });
  });

  it('a dot when there is no count; nothing without either', () => {
    expect(badgeView({ dot: true })).toEqual({ kind: 'dot', text: '', label: 'New activity', alert: false });
    expect(badgeView({ count: 0, dot: true, tone: 'alert' })?.kind).toBe('dot');
    expect(badgeView({ count: 0 })).toBeNull();
    expect(badgeView(undefined)).toBeNull();
  });
});
