/**
 * The deck domain's Idempotency-Key targets, handed to the chassis middleware
 * (`idempotency({ …, toolTargets })`), which applies them to POST only, next
 * to its own list (middleware/idempotency.ts in the chassis documents both).
 */

// A retried reserve must not leak a second session + reserved deck id.
const UPLOADS_PATH = '/api/v1/presentations/uploads';
// Share-token creation returns a one-shot secret — exactly what replay
// protection exists for (a retried create must not mint a second link).
const SHARE_TOKEN_CREATE_RE = /^\/api\/v1\/presentations\/[^/]+\/tokens$/;
// The duplicate (PRDCT-2279) mints a deck row and its version 1 from one
// click: a retried click must land on the same copy, never a second one.
const DUPLICATE_RE = /^\/api\/v1\/presentations\/[^/]+\/duplicate$/;

export function isDeckIdempotencyTarget(path: string): boolean {
  return path === UPLOADS_PATH || SHARE_TOKEN_CREATE_RE.test(path) || DUPLICATE_RE.test(path);
}
