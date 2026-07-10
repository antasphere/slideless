/**
 * API error → model-readable hint mapping (the predecessor MCP template's
 * DOMAIN_HINTS pattern). The API returns `{ error: { code, message } }` on
 * failure; each domain code can carry an actionable hint so the model
 * self-corrects instead of retrying blindly. Products extend DOMAIN_HINTS as
 * they open their own endpoints to OAuth tokens/keys.
 */
const DOMAIN_HINTS: Record<string, string> = {
  insufficient_scope:
    'Reconnect the MCP server and approve the permission on the consent screen ' +
    '(or mint an API key that includes the scope).',
  endpoint_not_allowed:
    'This endpoint is not opened to machine credentials — a human must do this in the dashboard.',
  invalid_token: 'The OAuth token expired or was revoked. Reconnect the MCP server.',
  unauthenticated: 'No valid credential reached the API. Reconnect the MCP server.',
  rate_limited: 'Rate limited — wait before retrying.',
  // ── Presentation domain (the slideless_ tool set) ──────────────────────────
  not_found:
    'The resource does not exist or this credential cannot read it (deck reads are private — ' +
    'owner, workspace admin, or active collaborator only). Check the id with slideless_list_presentations.',
  forbidden:
    'This credential lacks the deck-level right for this action (e.g. only the deck owner or a ' +
    'workspace admin can delete/invite). Ask the deck owner to do it or to grant access.',
  version_conflict:
    'Someone committed a new version in between. Re-read the deck (slideless_get_presentation) ' +
    'and retry on top of its currentVersion.',
  missing_blobs:
    'The manifest references content not uploaded to this workspace. Retry the upload tool; if it ' +
    'persists, push with the slideless CLI.',
  invalid_manifest: 'Fix the manifest entries (paths must be relative, no ".." segments) and retry.',
  invalid_version: 'That version number does not exist on this deck — list them with slideless_list_versions.',
  session_expired: 'The upload session expired — call the upload tool again (it reserves a fresh one).',
  session_consumed: 'This upload session was already committed — start a new upload.',
  token_revoked: 'This share token was revoked — mint a new one with slideless_add_share_token.',
  token_expired: 'This share token expired — extend it or mint a new one with slideless_add_share_token.',
  already_owner: 'The deck owner does not need a collaborator grant — nothing to do.',
  entitlement_denied: 'The workspace quota refused this upload — free space or raise the plan limits.',
  file_too_large: 'One file exceeds the instance upload limit — use the slideless CLI or shrink the file.',
  payload_too_large: 'The request exceeds the 1 MiB MCP body cap — push large decks with the slideless CLI.',
  validation_error: 'The request shape was rejected — fix the listed fields and retry.'
};

/** Thrown when the in-process API call returns a non-2xx wire-shape response. */
export class ApiToolError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'ApiToolError';
    this.status = status;
    this.code = code;
  }

  toUserFacingText(): string {
    const hint = this.code ? DOMAIN_HINTS[this.code] : undefined;
    const codePart = this.code ? `, code: ${this.code}` : '';
    return `API error (HTTP ${this.status}${codePart}): ${this.message}${hint ? ` — Next: ${hint}` : ''}`;
  }
}

export interface ToolTextResult {
  // Index signature: the MCP SDK's CallToolResult carries extra open fields.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

export const jsonText = (result: unknown): ToolTextResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
});

export const deny = (text: string): ToolTextResult => ({
  content: [{ type: 'text' as const, text }],
  isError: true as const
});

/**
 * Wrap a tool body so any thrown ApiToolError surfaces as a structured MCP
 * tool error (`isError: true` + text) rather than a protocol-level exception.
 * Other errors propagate to the SDK.
 */
export async function wrapToolErrors(fn: () => Promise<ToolTextResult>): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiToolError) {
      return { content: [{ type: 'text', text: err.toUserFacingText() }], isError: true };
    }
    throw err;
  }
}
