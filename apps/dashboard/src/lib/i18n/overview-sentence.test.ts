import { describe, expect, it } from 'vitest';
import { en, fr } from './index';

/**
 * The overview's one sentence under the title: the same on both editions, so
 * each catalog carries ONE key for it and no cloud variant.
 */
describe('the overview sentence', () => {
  it('reads the same sentence in each language', () => {
    expect(en['overview.description']).toBe('Your workspace at a glance.');
    expect(fr['overview.description']).toBe('Votre espace de travail en un coup d’œil.');
  });

  it('has no cloud variant in either catalog', () => {
    expect(Object.keys(en)).not.toContain('overview.descriptionCloud');
    expect(Object.keys(fr)).not.toContain('overview.descriptionCloud');
  });
});
