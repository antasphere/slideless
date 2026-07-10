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
  rate_limited: 'Rate limited — wait before retrying.'
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
    return `API error (HTTP ${this.status}${codePart}): ${this.message}${hint ? ` — ${hint}` : ''}`;
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
