/**
 * An invitation accepted on the way back from "Sign in with Antasphere"
 * (PRDCT-2817), bound to the person's OWN click.
 *
 * The person who presses the button on the invitation page has said what
 * they want: the page reads "Sign in to accept your invitation". The sign-in
 * leaves for the account site and comes back to the same page, which then
 * accepts without asking a second time. What must never happen is an
 * acceptance nobody asked for: a link that carries a mark in its address
 * joined whoever opened it while signed in (the verifier's round 1, F2).
 *
 * So the mark is not in the address. It is written in THIS browser tab's
 * session storage at the click, names the one invitation it was pressed for,
 * lives ten minutes, and is taken (read and removed) once on the return. A
 * link cannot write it, another tab does not see it, and a second visit
 * finds none.
 */
const PREFIX = 'platform.inviteAccept.';
export const ACCEPT_MARK_TTL_MS = 10 * 60 * 1000;

type MarkStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function store(): MarkStore | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // storage refused (privacy modes): the person presses Accept on the return
  }
}

/** At the click on "Sign in with Antasphere": remember that THIS invitation was asked for. */
export function markAcceptOnReturn(
  token: string,
  now = Date.now(),
  target: MarkStore | null = store()
): void {
  try {
    target?.setItem(PREFIX + token, String(now + ACCEPT_MARK_TTL_MS));
  } catch {
    // Not writable: no mark, so the return shows the Accept button.
  }
}

/** On the return: true once, for the invitation that was asked for, while the mark lives. */
export function takeAcceptOnReturn(
  token: string,
  now = Date.now(),
  target: MarkStore | null = store()
): boolean {
  try {
    const raw = target?.getItem(PREFIX + token) ?? null;
    if (raw === null) return false;
    target?.removeItem(PREFIX + token);
    const until = Number(raw);
    return Number.isFinite(until) && now < until;
  } catch {
    return false;
  }
}
