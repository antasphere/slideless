/**
 * The deck domain's exemption from the generic audit row, handed to the
 * chassis `auditMiddleware` as `options.exempt`.
 *
 * Share-token viewer surface (annotations/forms/badge): the SECRET rides
 * the path, and these writes are documented as unaudited — token
 * recipients are not principals. Without this exemption a visitor who
 * ALSO holds a session cookie lands a fallback row whose action embeds
 * the live share secret (PRIV-1). Owner-side moderation lives under
 * /presentations/ and stays audited.
 */
export const isDeckAuditExempt = (path: string): boolean => path.startsWith('/api/v1/viewer/');
