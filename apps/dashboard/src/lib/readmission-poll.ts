/**
 * The refusal page's re-admission poll (no-organization): while the hub
 * names an organization that does not open the tool to this person, the
 * page re-reads `GET /me` on this cadence, and opens the workspace as soon
 * as the answer carries one. The server's zero-state read runs the
 * reconciler's cached pass (10 s TTL, 15 s retry throttle), so a faster
 * poll would buy nothing.
 */
export const READMISSION_POLL_MS = 10_000;

/** The tab's visibility, as `document.visibilityState` reads it. */
export type TabVisibility = DocumentVisibilityState;

/**
 * Whether the page polls, and how often: only while something is denied and
 * the tab is visible (a hidden tab stops, and resumes when shown). `null` =
 * no poll.
 */
export function readmissionPollInterval(deniedCount: number, visibility: TabVisibility): number | null {
  if (deniedCount <= 0) return null;
  if (visibility !== 'visible') return null;
  return READMISSION_POLL_MS;
}
