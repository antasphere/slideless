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
  CliAuthRevoked,
  Collaborator,
  CollaboratorClaim,
  CollaboratorClaimed,
  CollaboratorInvite,
  CollaboratorInvited,
  CollaboratorLookup,
  FileInfo,
  FormResponse,
  FormResponseSourceValue,
  FormResponseDetail,
  FormResponsesSummary,
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
  OnboardingDismissed,
  Presentation,
  PresentationDuplicate,
  PresentationUpdate,
  PresentationVersionSummary,
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
  ShareTokenView,
  SsoCliConnect,
  SsoLogoutResponse,
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
   * Active workspace for EVERY credential kind (sent as X-Workspace-Id —
   * the user-scoped credential model): a caller in several workspaces names
   * which one their requests target; absent, the user's default membership
   * applies. Meaningful with the session cookie AND with user-scoped API
   * keys/OAuth tokens; a PINNED key rejects a mismatching value server-side
   * (403 workspace_mismatch). Mutable later via setWorkspace().
   */
  workspaceId?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Deadline for the JSON API calls, in milliseconds (default 30 000; 0
   * disables). Without one, a hung or throttling instance parks a CLI
   * invocation — or a dashboard request — forever: `fetch` has no default
   * timeout in Node or the browser.
   */
  timeoutMs?: number;
  /**
   * Deadline for the byte-streaming calls — deck assets, file content, the
   * workspace export (default 600 000; 0 disables). Separate because it
   * covers the whole body transfer, and an export is legitimately slow.
   */
  downloadTimeoutMs?: number;
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

/** Cursor pagination + every form-response attribution filter (ADR 022). */
export interface FormResponseListParams extends ListParams {
  /** Only this form's responses (the data-slideless-form name). */
  form?: string;
  /** Only responses that came through this share link (token id). */
  token?: string;
  /** Only direct-link or embedded submissions. */
  source?: FormResponseSourceValue;
  /** Only responses whose serving document carried this ?p= label. */
  placement?: string;
  /** ISO datetime — only responses created at or after this instant. */
  since?: string;
}

/**
 * Options for the non-idempotent create calls. Setting `idempotencyKey`
 * (any client-chosen string ≤200 chars, e.g. a UUID) makes a retried create
 * replay the original response instead of double-creating (docs/security/security.md).
 */
export interface IdempotentRequestOptions {
  idempotencyKey?: string;
}

function idempotencyHeader(opts: IdempotentRequestOptions): Record<string, string> | undefined {
  return opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : undefined;
}

/** Default deadline for the JSON API calls (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default deadline for the streaming download calls (ms). */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000;

export class PlatformClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private workspaceId: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/, '') ?? '';
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  }

  /**
   * The abort signal every call carries. `fetch` never times out on its
   * own, so a silent peer (or a hostile one holding the socket open) would
   * otherwise hang the caller indefinitely.
   */
  private signal(kind: 'api' | 'download'): AbortSignal | undefined {
    const ms = kind === 'download' ? this.downloadTimeoutMs : this.timeoutMs;
    return ms > 0 ? AbortSignal.timeout(ms) : undefined;
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
      signal: this.signal('api'),
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

  /**
   * CLOUD EDITION only (404 on oss); sessions only (machines 403): record
   * the explicit first-run-welcome dismissal — flips /me's
   * `firstRunPending` to false, permanently. Idempotent.
   */
  dismissOnboarding(): Promise<OnboardingDismissed> {
    return this.request('POST', '/me/onboarding/dismiss');
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

  /**
   * Revoke the PRESENTING API key (CLI logout). Self-revocation only: the
   * route names no key, so the credential can kill exactly itself. Requires
   * an API-key credential with presentations:write (sessions and OAuth
   * bearers are refused — the dashboard is their key-management surface).
   */
  cliAuthRevoke(): Promise<CliAuthRevoked> {
    return this.request('DELETE', '/cli/auth/key');
  }

  /**
   * Public, CLOUD EDITION only (404 on oss): exchange a hub-minted 120 s
   * connect JWT (the hub's /sso/tool-token response) for an `slk_` API key
   * bound to the projected workspace — same grant and one-shot response
   * shape as cliAuthComplete. Each token works exactly once (jti).
   */
  ssoCliConnect(req: SsoCliConnect): Promise<CliAuthCompleted> {
    return this.request('POST', '/sso/cli-connect', req);
  }

  /**
   * CLOUD EDITION only (404 on oss); sessions only (machines 403 — the
   * path is unlisted in the scope allowlist): single logout. The server
   * revokes the local session and clears the SSO hint cookie in this very
   * response; `url` is the hub end-session URL the browser must then VISIT
   * to end the hub anchor session (null = local signout only — go straight
   * to /login?signed_out=1).
   */
  ssoLogout(): Promise<SsoLogoutResponse> {
    return this.request('POST', '/sso/logout');
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

  /**
   * Owner: mint a one-time password reset link for a member (SMTP-free
   * recovery). Refused for a per-deck guest and for anyone who also belongs
   * to another workspace — the minted credential is global (PRDCT-1354).
   */
  createMemberResetLink(id: string, opts: IdempotentRequestOptions = {}): Promise<MemberResetLink> {
    return this.request(
      'POST',
      `/members/${encodeURIComponent(id)}/reset-link`,
      undefined,
      idempotencyHeader(opts)
    );
  }

  /**
   * Owner: mint a one-time email change link for a member (SMTP-free email
   * change). ⚠️ The link updates the email AND signs the member in — share
   * it with the target member only. Same refusals as the reset link (guest
   * targets, cross-workspace targets), plus the cloud edition closure.
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
    const headers: Record<string, string> = { ...this.baseHeaders(), 'content-type': type };

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/files?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      signal: this.signal('download'),
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

  /**
   * Update mutable deck properties. `metadata` replaces the stored object
   * wholesale — read-modify-write to merge.
   */
  updatePresentation(id: string, patch: PresentationUpdate): Promise<Presentation> {
    return this.request('PATCH', `/presentations/${encodeURIComponent(id)}`, patch);
  }

  /** Soft delete: versions and share tokens stop resolving. */
  deletePresentation(id: string): Promise<Presentation> {
    return this.request('DELETE', `/presentations/${encodeURIComponent(id)}`);
  }

  /**
   * Duplicate a deck (PRDCT-2279): a new deck in the same workspace whose
   * version 1 references the source version's blobs — nothing is
   * re-uploaded. `version` picks the source version (current when omitted),
   * `title` names the copy. Idempotency-Key aware like the other creates.
   */
  duplicatePresentation(
    id: string,
    req: PresentationDuplicate = {},
    opts: IdempotentRequestOptions = {}
  ): Promise<VersionCommitted> {
    return this.request(
      'POST',
      `/presentations/${encodeURIComponent(id)}/duplicate`,
      req,
      idempotencyHeader(opts)
    );
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
      signal: this.signal('download'),
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
  ): Promise<{ versions: PresentationVersionSummary[]; nextCursor: string | null }> {
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
      signal: this.signal('download'),
      // Browser-only field; cast keeps this isomorphic under a Node lib.
      cache: 'no-store'
    } as RequestInit);
    if (!res.ok) {
      await this.parse(res); // throws PlatformApiError with the wire shape
    }
    return res;
  }

  /** URL of the streamed attachments zip of one version (PRDCT-2278). */
  versionAttachmentsZipUrl(id: string, version: number): string {
    return `${this.baseUrl}/api/v1/presentations/${encodeURIComponent(id)}/versions/${version}/downloads.zip`;
  }

  /**
   * Downloads one version's attachments (its `downloads/` folder) as a
   * streamed store-only zip named `<deck-title-slug>-v<n>.zip` (the
   * Content-Disposition carries it). Returns the raw Response so callers can
   * stream the bytes; 404 no_attachments when the version carries none.
   */
  async downloadVersionAttachmentsZip(id: string, version: number): Promise<Response> {
    return this.rawDownload(this.versionAttachmentsZipUrl(id, version));
  }

  /**
   * URL of one attachment of one version by its name (the path relative to
   * `downloads/`). The name is ONE path segment on the wire: a nested name
   * (`sub/file.csv`) is percent-encoded whole (`sub%2Ffile.csv`).
   */
  versionAttachmentUrl(id: string, version: number, name: string): string {
    return `${this.baseUrl}/api/v1/presentations/${encodeURIComponent(id)}/versions/${version}/downloads/${encodeURIComponent(name)}`;
  }

  /** Downloads one attachment (attachment disposition, the manifest content type). Raw Response. */
  async downloadVersionAttachment(id: string, version: number, name: string): Promise<Response> {
    return this.rawDownload(this.versionAttachmentUrl(id, version, name));
  }

  /** The shared body of the streamed-download methods (the asset download's shape). */
  private async rawDownload(url: string): Promise<Response> {
    const headers: Record<string, string> = this.baseHeaders();
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      signal: this.signal('download'),
      // Browser-only field; cast keeps this isomorphic under a Node lib.
      cache: 'no-store'
    } as RequestInit);
    if (!res.ok) {
      await this.parse(res); // throws PlatformApiError with the wire shape
    }
    return res;
  }

  /** URL of the streamed AGENT.md briefing endpoint. */
  agentDocUrl(id: string, version?: number): string {
    const base = `${this.baseUrl}/api/v1/presentations/${encodeURIComponent(id)}/agent-doc`;
    return version !== undefined ? `${base}?version=${version}` : base;
  }

  /**
   * The deck's AGENT.md briefing as markdown text (current version, or a
   * pinned one). 404 agent_doc_not_found when that version ships none.
   */
  async agentDoc(id: string, version?: number): Promise<string> {
    const headers: Record<string, string> = this.baseHeaders();
    const res = await this.fetchImpl(this.agentDocUrl(id, version), {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      signal: this.signal('download'),
      // Browser-only field; cast keeps this isomorphic under a Node lib.
      cache: 'no-store'
    } as RequestInit);
    if (!res.ok) {
      await this.parse(res); // throws PlatformApiError with the wire shape
    }
    return res.text();
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

  /**
   * Per-view events of one share token, newest first (cursor-paginated):
   * when each counted open happened, the referring site's host, the `?p=`
   * placement label, and a coarse browser family. No IP, no geolocation,
   * no full referrer URLs — the server never stores them.
   */
  shareTokenViews(
    id: string,
    tokenId: string,
    params: ListParams = {}
  ): Promise<{ views: ShareTokenView[]; nextCursor: string | null }> {
    return this.request(
      'GET',
      this.pathWithQuery(
        `/presentations/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}/views`,
        params
      )
    );
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

  // ── Form responses (ADR 022) ──────────────────────────────────────────────

  private pathWithFormResponseQuery(base: string, params: FormResponseListParams): string {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.form) query.set('form', params.form);
    if (params.token) query.set('token', params.token);
    if (params.source) query.set('source', params.source);
    if (params.placement) query.set('placement', params.placement);
    if (params.since) query.set('since', params.since);
    const qs = query.toString();
    return qs ? `${base}?${qs}` : base;
  }

  /**
   * A deck's form responses, newest first (cursor-paginated), sliceable by
   * form, share link, source (link/embed), placement label, and time.
   * Payload values are the respondent's RAW input — escape before rendering.
   */
  formResponses(
    id: string,
    params: FormResponseListParams = {}
  ): Promise<{ responses: FormResponse[]; nextCursor: string | null }> {
    return this.request(
      'GET',
      this.pathWithFormResponseQuery(`/presentations/${encodeURIComponent(id)}/responses`, params)
    );
  }

  /**
   * One response with its edit history (PRDCT-2329): the current row and
   * every revision, newest first, each with the link and the moment it was
   * written through. Payload values are RAW respondent input at every
   * revision — escape before rendering.
   */
  formResponse(id: string, responseId: string): Promise<FormResponseDetail> {
    return this.request(
      'GET',
      `/presentations/${encodeURIComponent(id)}/responses/${encodeURIComponent(responseId)}`
    );
  }

  /** Grouped counts per form × link × source × placement, plus the deck total. */
  formResponsesSummary(id: string): Promise<FormResponsesSummary> {
    return this.request('GET', `/presentations/${encodeURIComponent(id)}/responses/summary`);
  }

  /** Owner moderation: delete one response (audited server-side). */
  deleteFormResponse(id: string, responseId: string): Promise<FormResponse> {
    return this.request(
      'DELETE',
      `/presentations/${encodeURIComponent(id)}/responses/${encodeURIComponent(responseId)}`
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
      signal: this.signal('download'),
      // Browser-only field; cast keeps this isomorphic under a Node lib.
      cache: 'no-store'
    } as RequestInit);
    if (!res.ok) {
      await this.parse(res); // throws PlatformApiError with the wire shape
    }
    return res;
  }
}
