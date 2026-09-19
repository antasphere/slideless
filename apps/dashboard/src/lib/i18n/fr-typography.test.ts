import { describe, expect, it } from 'vitest';
import { fr } from './fr';

/**
 * French typography lint, VALUES only: the space before double punctuation
 * (? ! : ;) and inside guillemets must be U+00A0 (non-breaking), never an
 * ASCII space — an ASCII space lets the punctuation wrap onto its own line.
 * Scoped to catalog values on purpose: a blanket "fix spaces before :" pass
 * over the file also rewrites comments, which no-irregular-whitespace then
 * rejects. The catalog convention lives in fr.ts's header comment.
 */
describe('fr catalog typography', () => {
  it('never uses an ASCII space where French requires a non-breaking one', () => {
    const offenders = Object.entries(fr)
      .filter(([, value]) => / [?!:;»]/.test(value) || /« /.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders, 'replace the ASCII space with U+00A0 in these values').toEqual([]);
  });
});
