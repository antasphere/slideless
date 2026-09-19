import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell } from './csv';

describe('csvCell (formula-injection tripwire)', () => {
  it("prefixes '=', '+', '-', '@' leading cells with a quote — respondent input must never execute", () => {
    expect(csvCell('=SUM(A1:A9)')).toBe('"\'=SUM(A1:A9)"');
    expect(csvCell('+1234')).toBe('"\'+1234"');
    expect(csvCell('-cmd')).toBe('"\'-cmd"');
    expect(csvCell('@import')).toBe('"\'@import"');
  });

  it('leaves ordinary cells unprefixed', () => {
    expect(csvCell('hello')).toBe('"hello"');
    expect(csvCell('')).toBe('""');
    expect(csvCell('a=b')).toBe('"a=b"');
  });

  it('doubles embedded quotes per RFC 4180', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('keeps newlines inside the quoted cell', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('buildCsv', () => {
  it('joins header + rows with CRLF, guarding every cell — header included', () => {
    // Payload KEYS become header cells and are respondent-controlled too.
    const csv = buildCsv(['form', '=evil'], [['rsvp', '@cmd']]);
    expect(csv).toBe('"form","\'=evil"\r\n"rsvp","\'@cmd"');
  });
});
