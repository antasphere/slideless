import type {
  ApiKeyCreate,
  ApiKeyCreated,
  ApiKeyInfo,
  AuditEntry,
  BreakGlassClaimOwnership,
  BreakGlassClaimOwnershipRequest,
  BreakGlassResetTwoFactor,
  BreakGlassResetTwoFactorRequest,
  FileInfo,
  InstanceInfo,
  InvitationAccept,
  InvitationCreate,
  InvitationCreated,
  InvitationInfo,
  InvitationLookup,
  Member,
  MemberChangeEmailLink,
  MemberChangeEmailLinkRequest,
  MemberResetLink,
  MemberUpdate,
  MeResponse,
  SetupRequest,
  SetupResponse,
  WorkspaceRole
} from '@platform/contract';

/**
 * Thin typed client over /api/v1. Isomorphic: in the dashboard it rides the
 * same-origin session cookie; in Node/CLI contexts pass an API key.
 */

export class PlatformApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

export interface ClientOptions {
  /** Origin of the instance; '' (default) = same-origin (dashboard). */
  baseUrl?: string;
  /** API key (`<prefix>_<keyid>_<secret>`) for machine callers. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

/** Cursor-pagination params shared by every list endpoint. */
export interface ListParams {
  /** `nextCursor` from the previous page; omit for page 1. */
  cursor?: string;
  /** Page size (server default 50, max 100). */
  limit?: number;
}

export interface AuditListResponse {
  entries: AuditEntry[];
  nextCursor: string | null;
}

export interface InvitationAccepted {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface FileUploaded {
  file: FileInfo;
  deduplicated: boolean;
}

/**
 * Options for the non-idempotent create calls. Setting `idempotencyKey`
 * (any client-chosen string ≤200 chars, e.g. a UUID) makes a retried create
 * replay the original response instead of double-creating (docs/security.md).
 */
export interface IdempotentRequestOptions {
  idempotencyKey?: string;
}

function idempotencyHeader(opts: IdempotentRequestOptions): Record<string, string> | undefined {
  return opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : undefined;
}

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? '';
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;

    const json = (await res.json().catch(() => null)) as
      { error?: { code?: string; message?: string; details?: unknown } } | T | null;

    if (!res.ok) {
      const errBody = (json ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
      throw new PlatformApiError(
        res.status,
        errBody.error?.code ?? 'unknown_error',
        errBody.error?.message ?? `Request failed with ${res.status}`,
        errBody.error?.details
      );
    }
    return json as T;
  }

  /** Append cursor-pagination params to a list path. */
  private pathWithQuery(base: string, params: ListParams): string {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const qs = query.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      // Always see live state: /instance flips setupRequired the moment the
      // wizard completes but is served with public max-age for CLI/MCP
      // discovery — the browser HTTP cache must not answer for the app.
      // (`cache` is a browser-only field; cast keeps this isomorphic under a
      // Node lib where RequestInit omits it.)
      cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    } as RequestInit);
    return this.parse<T>(res);
  }

  instance(): Promise<InstanceInfo> {
    return this.request('GET', '/instance');
  }

  setup(req: SetupRequest): Promise<SetupResponse> {
    return this.request('POST', '/setup', req);
  }

  me(): Promise<MeResponse> {
    return this.request('GET', '/me');
  }

  /** Better Auth session probe — null when signed out. */
  async session(): Promise<{ user: { id: string; email: string; name: string } } | null> {
    return this.request('GET', '/auth/get-session');
  }

  signInEmail(email: string, password: string): Promise<{ user: { id: string } }> {
    return this.request('POST', '/auth/sign-in/email', { email, password });
  }

  signOut(): Promise<void> {
    return this.request('POST', '/auth/sign-out', {});
  }

  // ── Members ───────────────────────────────────────────────────────────────

  members(params: ListParams = {}): Promise<{ members: Member[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery('/members', params));
  }

  updateMember(id: string, patch: MemberUpdate): Promise<Member> {
    return this.request('PATCH', `/members/${encodeURIComponent(id)}`, patch);
  }

  /**
   * Admin: delete a member's account (GDPR erasure). Sessions only — the
   * endpoint is unlisted in the machine scope allowlist, so API keys 403.
   * Files the member uploaded stay with the workspace.
   */
  deleteMember(id: string): Promise<Member> {
    return this.request('DELETE', `/members/${encodeURIComponent(id)}`);
  }

  /** Admin: mint a one-time password reset link for a member (SMTP-free recovery). */
  createMemberResetLink(id: string, opts: IdempotentRequestOptions = {}): Promise<MemberResetLink> {
    return this.request(
      'POST',
      `/members/${encodeURIComponent(id)}/reset-link`,
      undefined,
      idempotencyHeader(opts)
    );
  }

  /**
   * Admin: mint a one-time email change link for a member (SMTP-free email
   * change). ⚠️ The link updates the email AND signs the member in — share
   * it with the target member only.
   */
  createMemberChangeEmailLink(
    id: string,
    req: MemberChangeEmailLinkRequest,
    opts: IdempotentRequestOptions = {}
  ): Promise<MemberChangeEmailLink> {
    return this.request(
      'POST',
      `/members/${encodeURIComponent(id)}/change-email-link`,
      req,
      idempotencyHeader(opts)
    );
  }

  // ── Break-glass (superadmin recovery, ADR 010) ────────────────────────────

  /**
   * Superadmin: make the caller (or a named existing user) an ACTIVE OWNER
   * of the workspace — creating, reactivating, or promoting the membership.
   * Adds an owner, never removes one. Sessions only: the endpoint is
   * unlisted in the machine scope allowlist (API keys/tokens 403), and the
   * calling session's VERIFIED email must be on SUPERADMIN_EMAILS.
   */
  breakGlassClaimOwnership(req: BreakGlassClaimOwnershipRequest = {}): Promise<BreakGlassClaimOwnership> {
    return this.request('POST', '/admin/break-glass/claim-ownership', req);
  }

  /** Superadmin: clear a locked-out user's 2FA (sessions only, audited). */
  breakGlassResetTwoFactor(req: BreakGlassResetTwoFactorRequest): Promise<BreakGlassResetTwoFactor> {
    return this.request('POST', '/admin/break-glass/reset-2fa', req);
  }

  // ── API keys ──────────────────────────────────────────────────────────────

  apiKeys(params: ListParams = {}): Promise<{ apiKeys: ApiKeyInfo[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery('/api-keys', params));
  }

  /** The returned `key` is the full secret — shown once, never retrievable. */
  createApiKey(req: ApiKeyCreate, opts: IdempotentRequestOptions = {}): Promise<ApiKeyCreated> {
    return this.request('POST', '/api-keys', req, idempotencyHeader(opts));
  }

  revokeApiKey(id: string): Promise<ApiKeyInfo> {
    return this.request('DELETE', `/api-keys/${encodeURIComponent(id)}`);
  }

  // ── Invitations ───────────────────────────────────────────────────────────

  invitations(
    params: ListParams = {}
  ): Promise<{ invitations: InvitationInfo[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery('/invitations', params));
  }

  /** `acceptUrl` is always returned — email delivery is best-effort on top. */
  createInvitation(req: InvitationCreate, opts: IdempotentRequestOptions = {}): Promise<InvitationCreated> {
    return this.request('POST', '/invitations', req, idempotencyHeader(opts));
  }

  revokeInvitation(id: string): Promise<InvitationInfo> {
    return this.request('DELETE', `/invitations/${encodeURIComponent(id)}`);
  }

  /** Public: resolves an invitation token for the acceptance page. */
  lookupInvitation(token: string): Promise<InvitationLookup> {
    return this.request('GET', `/invitations/lookup?token=${encodeURIComponent(token)}`);
  }

  /** Public: accepts an invitation (creates the account when needed). */
  acceptInvitation(req: InvitationAccept): Promise<InvitationAccepted> {
    return this.request('POST', '/invitations/accept', req);
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  audit(params: ListParams = {}): Promise<AuditListResponse> {
    return this.request('GET', this.pathWithQuery('/audit', params));
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  files(params: ListParams = {}): Promise<{ files: FileInfo[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery('/files', params));
  }

  /** Uploads raw bytes; the filename travels as a query param. */
  async uploadFile(
    name: string,
    body: Blob | ArrayBuffer | Uint8Array,
    contentType?: string
  ): Promise<FileUploaded> {
    const type =
      contentType ??
      (typeof Blob !== 'undefined' && body instanceof Blob && body.type
        ? body.type
        : 'application/octet-stream');
    const headers: Record<string, string> = { 'content-type': type };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/files?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: body as unknown as RequestInit['body']
    } as RequestInit);
    return this.parse<FileUploaded>(res);
  }

  deleteFile(id: string): Promise<FileInfo> {
    return this.request('DELETE', `/files/${encodeURIComponent(id)}`);
  }

  file(id: string): Promise<FileInfo> {
    return this.request('GET', `/files/${encodeURIComponent(id)}`);
  }

  /** URL of the streamed (Range-capable) content endpoint for a file. */
  fileContentUrl(id: string): string {
    return `${this.baseUrl}/api/v1/files/${encodeURIComponent(id)}/content`;
  }

  // ── Workspace export ──────────────────────────────────────────────────────

  /** URL of the workspace export endpoint (admin+; keys need data:export). */
  workspaceExportUrl(): string {
    return `${this.baseUrl}/api/v1/workspace/export`;
  }

  /**
   * Downloads the full workspace export. Returns the raw Response so callers
   * can stream the zip (exports can be large — never buffer by default);
   * a non-2xx answer throws PlatformApiError like every other method.
   */
  async downloadExport(): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(this.workspaceExportUrl(), {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      // Browser-only field; cast keeps this isomorphic under a Node lib.
      cache: 'no-store'
    } as RequestInit);
    if (!res.ok) {
      await this.parse(res); // throws PlatformApiError with the wire shape
    }
    return res;
  }
}
