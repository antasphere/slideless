import { IDENTITY, type Scope } from '@slideless/contract';
import { createScopeAllowlist, type ScopeRule } from '@antasphere/chassis-server/middleware';

/**
 * The Slideless half of the fail-closed endpoint allowlist for machine
 * principals. The mechanism and the rules of the generic endpoints (`/me`,
 * `/files`, `DELETE /cli/auth/key`, `/workspace/export`) live in
 * `@antasphere/chassis-server/middleware`; this file owns the scope NAMES and
 * the deck rules, and exports the composed `requiredScopeFor` — chassis rules
 * first, then the rules below, `null` (403) when nothing matched.
 */
export type { Scope };

/** The three scope names, spelled ONCE in the tool's identity (`packages/contract/src/identity.ts`). */
const { read: READ, write: WRITE, dataExport: DATA_EXPORT } = IDENTITY.scopes;

/**
 * Products rename presentations:read / presentations:write to their domain's scopes — also in
 * middleware/scopes.ts and the consent page copy.
 */
export const OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  READ,
  WRITE,
  // Full-workspace export download — a deliberate opt-in, never implied by
  // presentations:read (see middleware/scopes.ts).
  DATA_EXPORT
] as const;

/** The CLI key's fixed grant — the agent surface, never data:export. */
export const CLI_KEY_SCOPES = [READ, WRITE] as const;

const deckRules: ReadonlyArray<ScopeRule<Scope>> = [
  // Presentation domain (ADR 011): the primary agent surface. Covers the
  // whole /presentations tree — listings, upload sessions, precheck, asset
  // push/pull, version commits, share tokens, collaborators, per-deck
  // annotations. Reads → presentations:read, mutations → presentations:write.
  // (Per-route authorization still applies on top: e.g. a dev collaborator's
  // write key can commit versions but its deck-delete / collaborator-invite
  // calls 403 at the handler — the scope opens the door, the deck ACL rules.)
  // The owner-side attachment reads (PRDCT-2278, `/presentations/{id}/
  // versions/{n}/downloads.zip` and `/downloads/{name}`) are OPEN to read
  // keys through this prefix, consciously: an agent that can pull a deck's
  // blobs by sha can take its attachments by name, under the same
  // canReadDeck 404 posture. The recipient side stays under /viewer/*,
  // unlisted below. The duplicate (PRDCT-2279, `POST /presentations/{id}/
  // duplicate`) is a mutation under presentations:write through the same
  // prefix, consciously: an agent that can push a deck can copy one it
  // reads, and the handler's guest wall + read check still rule on top.
  (path, _method, isRead) => {
    if (path === '/api/v1/presentations' || path.startsWith('/api/v1/presentations/')) {
      return isRead ? READ : WRITE;
    }
    return null;
  },
  // Workspace-wide annotation inbox: read-only today — list ONLY the read so
  // any future mutation on this path stays fail-closed until opened here.
  (path, _method, isRead) => (path === '/api/v1/annotations' && isRead ? READ : null)
  // Deliberately UNLISTED (fail-closed 403 for keys/tokens), like break-glass:
  //  - /collaborators/lookup + /collaborators/claim — public token-redemption
  //    endpoints for HUMANS (they mint accounts/memberships); a machine
  //    credential has no business redeeming a claim link. Anonymous callers
  //    never reach this gate — it judges resolved machine principals only.
  //  - /viewer/* — the public share-token surfaces (annotations, forms, the
  //    attachments list): the share-token secret is the credential there,
  //    never a principal; agents manage annotations through
  //    /presentations/{id}/annotations and read attachments through the
  //    version detail instead.
  // (The generic unlisted surfaces — /sso/logout, POST /workspaces,
  // /me/onboarding/dismiss — are recorded beside the chassis rules.)
];

export const requiredScopeFor = createScopeAllowlist<Scope>({
  read: READ,
  write: WRITE,
  dataExport: DATA_EXPORT,
  rules: deckRules
});
