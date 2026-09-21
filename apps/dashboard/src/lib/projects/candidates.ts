/**
 * Who the "Add member" dialog offers (PRDCT-2582). A project takes its members
 * from the workspace's own people: active, not a guest, and not in the project
 * yet. The server holds the rule (`guest_target`, `already_member`); this is
 * the dashboard's reading of it, so the list never offers a name that can only
 * be refused.
 */
export interface Candidate {
  userId: string;
  email: string;
  name: string | null;
  isActive: boolean;
  /** Not on the member wire today. Read when it is there, so a guest drops out of the list the day it lands. */
  origin?: string | null;
}

export function offeredMembers<T extends Candidate>(
  people: T[],
  alreadyIn: Iterable<string>,
  query = ''
): T[] {
  const taken = new Set(alreadyIn);
  const asked = query.trim().toLowerCase();
  return people
    .filter((person) => person.isActive && person.origin !== 'guest' && !taken.has(person.userId))
    .filter(
      (person) =>
        !asked ||
        person.email.toLowerCase().includes(asked) ||
        (person.name ?? '').toLowerCase().includes(asked)
    )
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}
