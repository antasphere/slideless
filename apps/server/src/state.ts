/**
 * Process-local runtime state. This is NOT application state (which lives in
 * Postgres per the statelessness invariant) — it is the lifecycle of this one
 * replica: readiness for /readyz and the draining flag for graceful shutdown.
 */
export interface RuntimeState {
  ready: boolean;
  reason: string;
  draining: boolean;
}

export function createRuntimeState(): RuntimeState {
  return { ready: false, reason: 'booting', draining: false };
}
