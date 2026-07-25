/**
 * Minimal client-side CSV builder (form-response export). Pure functions —
 * unit-tested in csv.test.ts.
 *
 * SECURITY — CSV formula injection: exported cells are RAW anonymous
 * respondent input (payload keys AND values). A cell starting with `=`,
 * `+`, `-`, or `@` would execute as a formula when the file opens in a
 * spreadsheet, so every such cell is prefixed with a single quote to force
 * text. Applied to EVERY cell, header row included — payload keys become
 * header cells. Never bypass this for "known safe" columns.
 */

/** One RFC 4180 cell: formula guard, then quote-wrap with `"` doubled. */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/** Header + rows → CRLF-joined CSV text. Every cell goes through csvCell. */
export function buildCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
