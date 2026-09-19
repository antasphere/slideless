/**
 * The push open decision, in one place so the matrix is testable:
 *
 *   --json or a piped stdout  → never (CI safety, whatever the flags say)
 *   --no-open                 → never
 *   --open                    → yes
 *   otherwise                 → only when this push CREATED the deck
 */
export function shouldOpenAfterPush(input: {
  created: boolean;
  json: boolean;
  interactive: boolean;
  /** `--open` → true, `--no-open` → false, neither → undefined. */
  flag: boolean | undefined;
}): boolean {
  // `push` returns its JSON before it ever reaches this, so the `json` guard
  // never fires from there today. It stays: a second layer for any future
  // caller, and the matrix tests pin it on its own.
  if (input.json || !input.interactive) return false;
  if (input.flag !== undefined) return input.flag;
  return input.created;
}
