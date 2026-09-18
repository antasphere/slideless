/**
 * A person's name as two fields, a change of the view only: the account forms
 * ask for a first name and a last name, and send ONE `name`, exactly where
 * the single field's value went. No API, contract or schema knows about the
 * split.
 *
 * Capitalising only ever RAISES a letter: the first letter of each part of a
 * name (parts are separated by spaces, hyphens and apostrophes) goes to upper
 * case, and nothing a person typed in capitals is lowered, so "McDONALD" and
 * "van der BERG" keep their capitals. "jean-luc de la tour" becomes
 * "Jean-Luc De La Tour": a particle is raised too, which is the accepted cost
 * of never guessing at a language's particles.
 */

/** Trims, collapses inner runs of spaces, and raises the first letter of each part. */
export function capitalizeNamePart(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(
      /(^|[\s\-'’])(\p{Ll})/gu,
      (_, lead: string, letter: string) => lead + letter.toLocaleUpperCase()
    );
}

/** The one `name` the API receives: "First Last", either part allowed to be empty. */
export function joinPersonName(first: string, last: string): string {
  return `${capitalizeNamePart(first)} ${capitalizeNamePart(last)}`.trim();
}
