/**
 * Fail-closed endpoint allowlist for machine principals (API keys now, OAuth
 * bearer tokens in M6). Ported from a predecessor template's oauth-scopes.ts.
 *
 * Machine principals are deliberately MORE restricted than the user they
 * belong to: they can only reach endpoints listed here, each behind its
 * scope. Anything not listed returns null and the gate 403s — new endpoints
 * are unreachable to keys/tokens until someone consciously opens them.
 * Session principals are role-gated instead and never pass through this.
 *
 * Pure logic (no I/O) so it stays unit-testable. Products rename the generic
 * presentations:read / presentations:write scopes to their domain's.
 */
export type Scope = 'presentations:read' | 'presentations:write' | 'data:export';

export function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

export function requiredScopeFor(path: string, method: string): Scope | null {
  const isRead = method === 'GET' || method === 'HEAD';
  if (path === '/api/v1/me' && isRead) return 'presentations:read';
  // Files: the substrate machine callers actually need (agents pushing and
  // pulling artifacts). Reads → presentations:read, mutations → presentations:write.
  if (path === '/api/v1/files' || path.startsWith('/api/v1/files/')) {
    return isRead ? 'presentations:read' : 'presentations:write';
  }
  // CLI logout self-revoke (api/cli-auth.ts): the ONE /cli/auth route open
  // to machines — DELETE revokes exactly the PRESENTING key. Safe to open
  // because the route names no key (no id parameter): the handler acts only
  // on principal.apiKeyId, resolved from the presented secret, and refuses
  // every non-key principal — so the widest possible effect is a credential
  // revoking ITSELF. presentations:write because revocation is a mutation
  // and every CLI-minted key carries it (mirrors the hub's account:write
  // entry). Exact path + method match: any OTHER method on the path, and
  // the PUBLIC mint routes (/cli/auth/request, /cli/auth/complete — which
  // never reach this gate anyway), stay fail-closed.
  if (path === '/api/v1/cli/auth/key' && method === 'DELETE') return 'presentations:write';
  // Full-workspace export: a dedicated opt-in scope, NEVER presentations:read — any
  // admin read key would otherwise be a whole-tenant exfiltration tool.
  // (Account deletion, DELETE /members/{id}, stays deliberately UNLISTED:
  // machines 403 fail-closed; deleting people is a session-only act.
  // Break-glass, /admin/break-glass/*, is likewise deliberately UNLISTED:
  // superadmin recovery is a human session act — a key or token whose owner
  // is on SUPERADMIN_EMAILS still 403s here, fail-closed. Never list it.)
  if (path === '/api/v1/workspace/export' && isRead) return 'data:export';
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
  if (path === '/api/v1/presentations' || path.startsWith('/api/v1/presentations/')) {
    return isRead ? 'presentations:read' : 'presentations:write';
  }
  // Workspace-wide annotation inbox: read-only today — list ONLY the read so
  // any future mutation on this path stays fail-closed until opened here.
  if (path === '/api/v1/annotations' && isRead) return 'presentations:read';
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
  //  - /sso/logout (cloud) — single logout is a BROWSER act: a machine
  //    credential must never be able to end its user's sessions. Never
  //    list it.
  //  - /me/onboarding/dismiss (cloud) — the first-run welcome is a browser
  //    concern; machines carry no banner to dismiss.
  return null;
}
