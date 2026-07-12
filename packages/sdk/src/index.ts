import type {
  Annotation,
  AnnotationCreate,
  AnnotationStatus,
  AnnotationUpdate,
  ApiKeyCreate,
  ApiKeyCreated,
  ApiKeyInfo,
  AssetPrecheckResponse,
  AssetUploaded,
  AuditEntry,
  BreakGlassClaimOwnership,
  BreakGlassClaimOwnershipRequest,
  BreakGlassResetTwoFactor,
  BreakGlassResetTwoFactorRequest,
  CliAuthComplete,
  CliAuthCompleted,
  CliAuthRequest,
  CliAuthRequested,
  Collaborator,
  CollaboratorClaim,
  CollaboratorClaimed,
  CollaboratorInvite,
  CollaboratorInvited,
  CollaboratorLookup,
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
  OauthConsentWorkspace,
  Presentation,
  PresentationVersion,
  PresentationVersionDetail,
  PreviewTokenCreate,
  SetupRequest,
  SetupResponse,
  ShareToken,
  ShareTokenCreate,
  ShareTokenCreated,
  ShareTokenSend,
  ShareTokenSent,
  ShareTokenUpdate,
  UploadSession,
  UploadSessionCommit,
  VersionCommit,
  VersionCommitted,
  WorkspaceRole
} from '@slideless/contract';

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
  /**
   * Active workspace for SESSION callers (sent as X-Workspace-Id, ADR 014).
   * Only meaningful with the session cookie: a user in several workspaces
   * names which one their requests target. API keys and OAuth tokens are
   * workspace-bound at mint and need none (a mismatching value is rejected
   * server-side). Mutable later via setWorkspace().
   */
  workspaceId?: string;
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

/** Cursor pagination + the annotation-specific filters. */
export interface AnnotationListParams extends ListParams {
  /** Only notes anchored to this deck version. */
  version?: number;
  status?: AnnotationStatus;
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
  private workspaceId: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? '';
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Set (or clear) the active workspace all subsequent requests target. */
  setWorkspace(workspaceId: string | null): void {
    this.workspaceId = workspaceId ?? undefined;
  }

  /** Base headers shared by every call: credential + active workspace. */
  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    if (this.workspaceId) headers['x-workspace-id'] = this.workspaceId;
    return headers;
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
    const headers: Record<string, string> = { ...this.baseHeaders(), ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';

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

  // ── CLI auth (browserless email-OTP → API key) ────────────────────────────

  /** Public: email a sign-in code. Generic success — silent about account existence. */
  cliAuthRequest(req: CliAuthRequest): Promise<CliAuthRequested> {
    return this.request('POST', '/cli/auth/request', req);
  }

  /**
   * Public: verify the code and mint an `slk_` API key (presentations:read +
   * presentations:write). The returned `key` appears only here.
   */
  cliAuthComplete(req: CliAuthComplete): Promise<CliAuthCompleted> {
    return this.request('POST', '/cli/auth/complete', req);
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

  // ── OAuth consent ─────────────────────────────────────────────────────────

  /**
   * Park the workspace the upcoming OAuth consent should bind (ADR 014).
   * Sessions only; the consent page calls it right before approving when
   * the user picked a non-default workspace.
   */
  oauthConsentWorkspace(workspaceId: string): Promise<OauthConsentWorkspace> {
    return this.request('POST', '/oauth/consent-workspace', { workspaceId });
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
    const headers: Record<string, string> = { ...this.baseHeaders(), 'content-type': type };

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

  // ── Presentations ─────────────────────────────────────────────────────────

  presentations(
    params: ListParams = {}
  ): Promise<{ presentations: Presentation[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery('/presentations', params));
  }

  presentation(id: string): Promise<Presentation> {
    return this.request('GET', `/presentations/${encodeURIComponent(id)}`);
  }

  /** Soft delete: versions and share tokens stop resolving. */
  deletePresentation(id: string): Promise<Presentation> {
    return this.request('DELETE', `/presentations/${encodeURIComponent(id)}`);
  }

  // ── Upload (push) ─────────────────────────────────────────────────────────

  /** Reserve a new-deck upload session (~1 h): mints the future presentation id. */
  createUploadSession(opts: IdempotentRequestOptions = {}): Promise<{ uploadSession: UploadSession }> {
    return this.request('POST', '/presentations/uploads', undefined, idempotencyHeader(opts));
  }

  /** Which of these blobs the workspace is missing (upload exactly those). */
  precheckAssets(sha256: string[]): Promise<AssetPrecheckResponse> {
    return this.request('POST', '/presentations/precheck', { sha256 });
  }

  /** Upload one deck asset (multipart); the server re-hashes and rejects a mismatch. */
  async uploadAsset(
    sha256: string,
    body: Blob | ArrayBuffer | Uint8Array,
    contentType?: string
  ): Promise<AssetUploaded> {
    const blob =
      typeof Blob !== 'undefined' && body instanceof Blob
        ? body
        : new Blob([body as ArrayBuffer], contentType ? { type: contentType } : undefined);
    const form = new FormData();
    form.set('sha256', sha256);
    form.set('file', blob, sha256);

    const headers: Record<string, string> = this.baseHeaders();
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/presentations/assets`, {
      method: 'POST',
      headers, // content-type comes from FormData (boundary included)
      credentials: 'same-origin',
      body: form as unknown as RequestInit['body']
    } as RequestInit);
    return this.parse<AssetUploaded>(res);
  }

  /** Commit an upload session: creates the deck and its version 1 (one-shot). */
  commitUploadSession(sessionId: string, req: UploadSessionCommit): Promise<VersionCommitted> {
    return this.request('POST', `/presentations/uploads/${encodeURIComponent(sessionId)}/commit`, req);
  }

  /**
   * Commit a new immutable version. `expectedBaseVersion` must equal the
   * deck's currentVersion or the server answers 409 version_conflict.
   */
  commitVersion(id: string, req: VersionCommit): Promise<VersionCommitted> {
    return this.request('POST', `/presentations/${encodeURIComponent(id)}/versions`, req);
  }

  // ── Pull ──────────────────────────────────────────────────────────────────

  presentationVersions(
    id: string,
    params: ListParams = {}
  ): Promise<{ versions: PresentationVersion[]; nextCursor: string | null }> {
    return this.request(
      'GET',
      this.pathWithQuery(`/presentations/${encodeURIComponent(id)}/versions`, params)
    );
  }

  /** One version including its full manifest (path → sha256). */
  presentationVersion(id: string, version: number): Promise<PresentationVersionDetail> {
    return this.request('GET', `/presentations/${encodeURIComponent(id)}/versions/${version}`);
  }

  /** URL of the streamed asset download endpoint (content-addressed). */
  presentationAssetUrl(id: string, sha256: string): string {
    return `${this.baseUrl}/api/v1/presentations/${encodeURIComponent(id)}/assets/${encodeURIComponent(sha256)}`;
  }

  /**
   * Downloads one deck blob. Returns the raw Response so callers can stream
   * the bytes; a non-2xx answer throws PlatformApiError like every method.
   */
  async downloadPresentationAsset(id: string, sha256: string): Promise<Response> {
    const headers: Record<string, string> = this.baseHeaders();
    const res = await this.fetchImpl(this.presentationAssetUrl(id, sha256), {
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

  // ── Sharing ───────────────────────────────────────────────────────────────

  shareTokens(
    id: string,
    params: ListParams = {}
  ): Promise<{ shareTokens: ShareToken[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithQuery(`/presentations/${encodeURIComponent(id)}/tokens`, params));
  }

  /** The returned `secret`/`url` appear only here — never retrievable again. */
  createShareToken(
    id: string,
    req: ShareTokenCreate,
    opts: IdempotentRequestOptions = {}
  ): Promise<ShareTokenCreated> {
    return this.request(
      'POST',
      `/presentations/${encodeURIComponent(id)}/tokens`,
      req,
      idempotencyHeader(opts)
    );
  }

  /**
   * Mint the dashboard's transient preview token (deck owner / workspace
   * admin only — 403 for dev collaborators). Server-fixed: purpose
   * 'preview', 1 h expiry, hidden from the sharing panel, excluded from view
   * stats, immutable. `version` pins the preview; omitted = latest.
   */
  createPreviewToken(id: string, req: PreviewTokenCreate = {}): Promise<ShareTokenCreated> {
    return this.request('POST', `/presentations/${encodeURIComponent(id)}/preview-token`, req);
  }

  /** Pin/unpin version, rename, annotate flag, expiry, password (null clears). */
  updateShareToken(id: string, tokenId: string, patch: ShareTokenUpdate): Promise<ShareToken> {
    return this.request(
      'PATCH',
      `/presentations/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}`,
      patch
    );
  }

  /** Soft revoke — access stats survive. */
  revokeShareToken(id: string, tokenId: string): Promise<ShareToken> {
    return this.request(
      'DELETE',
      `/presentations/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}`
    );
  }

  /** Email the viewer link to a recipient (best-effort on top of the copyable URL). */
  sendShareToken(id: string, tokenId: string, req: ShareTokenSend): Promise<ShareTokenSent> {
    return this.request(
      'POST',
      `/presentations/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}/send`,
      req
    );
  }

  // ── Collaborators ─────────────────────────────────────────────────────────

  collaborators(
    id: string,
    params: ListParams = {}
  ): Promise<{ collaborators: Collaborator[]; nextCursor: string | null }> {
    return this.request(
      'GET',
      this.pathWithQuery(`/presentations/${encodeURIComponent(id)}/collaborators`, params)
    );
  }

  /** `claimUrl` is always returned — email delivery is best-effort on top. */
  inviteCollaborator(
    id: string,
    req: CollaboratorInvite,
    opts: IdempotentRequestOptions = {}
  ): Promise<CollaboratorInvited> {
    return this.request(
      'POST',
      `/presentations/${encodeURIComponent(id)}/collaborators`,
      req,
      idempotencyHeader(opts)
    );
  }

  removeCollaborator(id: string, collaboratorId: string): Promise<Collaborator> {
    return this.request(
      'DELETE',
      `/presentations/${encodeURIComponent(id)}/collaborators/${encodeURIComponent(collaboratorId)}`
    );
  }

  /** Public: resolves a collaborator claim token for the claim page. */
  lookupCollaboratorInvite(token: string): Promise<CollaboratorLookup> {
    return this.request('GET', `/collaborators/lookup?token=${encodeURIComponent(token)}`);
  }

  /** Public: claims a collaborator grant (creates the account when needed). */
  claimCollaboratorInvite(req: CollaboratorClaim): Promise<CollaboratorClaimed> {
    return this.request('POST', '/collaborators/claim', req);
  }

  // ── Annotations ───────────────────────────────────────────────────────────

  private pathWithAnnotationQuery(base: string, params: AnnotationListParams): string {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.version !== undefined) query.set('version', String(params.version));
    if (params.status) query.set('status', params.status);
    const qs = query.toString();
    return qs ? `${base}?${qs}` : base;
  }

  annotations(
    id: string,
    params: AnnotationListParams = {}
  ): Promise<{ annotations: Annotation[]; nextCursor: string | null }> {
    return this.request(
      'GET',
      this.pathWithAnnotationQuery(`/presentations/${encodeURIComponent(id)}/annotations`, params)
    );
  }

  /** Workspace-wide inbox: annotations across all decks, newest first. */
  annotationInbox(
    params: AnnotationListParams = {}
  ): Promise<{ annotations: Annotation[]; nextCursor: string | null }> {
    return this.request('GET', this.pathWithAnnotationQuery('/annotations', params));
  }

  createAnnotation(id: string, req: AnnotationCreate): Promise<Annotation> {
    return this.request('POST', `/presentations/${encodeURIComponent(id)}/annotations`, req);
  }

  updateAnnotation(id: string, annotationId: string, patch: AnnotationUpdate): Promise<Annotation> {
    return this.request(
      'PATCH',
      `/presentations/${encodeURIComponent(id)}/annotations/${encodeURIComponent(annotationId)}`,
      patch
    );
  }

  deleteAnnotation(id: string, annotationId: string): Promise<Annotation> {
    return this.request(
      'DELETE',
      `/presentations/${encodeURIComponent(id)}/annotations/${encodeURIComponent(annotationId)}`
    );
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
    const headers: Record<string, string> = this.baseHeaders();
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
