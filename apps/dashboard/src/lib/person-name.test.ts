import { describe, expect, it } from 'vitest';
import { capitalizeNamePart, joinPersonName } from './person-name';

describe('capitalizeNamePart', () => {
  it('raises the first letter of a lowercase name', () => {
    expect(capitalizeNamePart('romain')).toBe('Romain');
  });

  it('raises every part: spaces, hyphens, apostrophes', () => {
    expect(capitalizeNamePart('jean-luc')).toBe('Jean-Luc');
    expect(capitalizeNamePart('de la tour')).toBe('De La Tour');
    expect(capitalizeNamePart("o'brien")).toBe("O'Brien");
    expect(capitalizeNamePart('d’haene')).toBe('D’Haene');
  });

  it('never lowers what was typed in capitals', () => {
    expect(capitalizeNamePart('McDONALD')).toBe('McDONALD');
    expect(capitalizeNamePart('van der BERG')).toBe('Van Der BERG');
    expect(capitalizeNamePart('ROMAIN')).toBe('ROMAIN');
  });

  it('handles accents and letters with no case', () => {
    expect(capitalizeNamePart('élodie')).toBe('Élodie');
    expect(capitalizeNamePart('østergård')).toBe('Østergård');
    expect(capitalizeNamePart('李')).toBe('李');
  });

  it('trims and collapses spaces', () => {
    expect(capitalizeNamePart('  anne   marie ')).toBe('Anne Marie');
    expect(capitalizeNamePart('')).toBe('');
  });
});

describe('joinPersonName', () => {
  it('sends "First Last"', () => {
    expect(joinPersonName('jean-luc', 'de la tour')).toBe('Jean-Luc De La Tour');
    expect(joinPersonName('Owner', 'One')).toBe('Owner One');
  });

  it('never leaves a stray space when a part is empty', () => {
    expect(joinPersonName('cher', '')).toBe('Cher');
    expect(joinPersonName('', 'one')).toBe('One');
    expect(joinPersonName(' ', ' ')).toBe('');
  });
});
