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
 * data:read / data:write scopes to their domain's.
 */
export type Scope = 'data:read' | 'data:write' | 'data:export';

export function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

export function requiredScopeFor(path: string, method: string): Scope | null {
  const isRead = method === 'GET' || method === 'HEAD';
  if (path === '/api/v1/me' && isRead) return 'data:read';
  // Files: the substrate machine callers actually need (agents pushing and
  // pulling artifacts). Reads → data:read, mutations → data:write.
  if (path === '/api/v1/files' || path.startsWith('/api/v1/files/')) {
    return isRead ? 'data:read' : 'data:write';
  }
  // Full-workspace export: a dedicated opt-in scope, NEVER data:read — any
  // admin read key would otherwise be a whole-tenant exfiltration tool.
  // (Account deletion, DELETE /members/{id}, stays deliberately UNLISTED:
  // machines 403 fail-closed; deleting people is a session-only act.
  // Break-glass, /admin/break-glass/*, is likewise deliberately UNLISTED:
  // superadmin recovery is a human session act — a key or token whose owner
  // is on SUPERADMIN_EMAILS still 403s here, fail-closed. Never list it.)
  if (path === '/api/v1/workspace/export' && isRead) return 'data:export';
  // Products: open your domain endpoints here — reads → data:read,
  // mutations → data:write. Example:
  //   if (path.startsWith('/api/v1/items')) return isRead ? 'data:read' : 'data:write';
  return null;
}
