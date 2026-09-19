import {
  ChassisClient,
  idempotencyHeader,
  type IdempotentRequestOptions,
  type ListParams
} from '@antasphere/chassis-sdk';
import type {
  Annotation,
  AnnotationCreate,
  AnnotationStatus,
  AnnotationUpdate,
  AssetPrecheckResponse,
  AssetUploaded,
  Collaborator,
  CollaboratorClaim,
  CollaboratorClaimed,
  CollaboratorInvite,
  CollaboratorInvited,
  CollaboratorLookup,
  FormResponse,
  FormResponseSourceValue,
  FormResponseDetail,
  FormResponsesSummary,
  Presentation,
  PresentationDuplicate,
  PresentationsListType,
  PresentationUpdate,
  PresentationVersionSummary,
  PresentationVersionDetail,
  PreviewTokenCreate,
  ReferenceType,
  Scope,
  ShareToken,
  ShareTokenCreate,
  ShareTokenCreated,
  ShareTokenSend,
  ShareTokenSent,
  ShareTokenUpdate,
  ShareTokenView,
  UploadSession,
  UploadSessionCommit,
  VersionCommit,
  VersionCommitted
} from '@slideless/contract';

/**
 * The generic half of the client (errors, options, the list and audit params,
 * the idempotency options, the deadlines) lives in `@antasphere/chassis-sdk`.
 * This explicit list keeps the public surface of `@slideless/sdk` exactly what
 * it was before the split (PRDCT-2530); it is the only re-export of the change.
 */
export {
  PlatformApiError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  type ClientOptions,
  type ListParams,
  type AuditListResponse,
  type AuditListParams,
  type InvitationAccepted,
  type FileUploaded,
  type IdempotentRequestOptions
} from '@antasphere/chassis-sdk';

/** Cursor pagination + the presentations list's reference filters. */
export interface PresentationListParams extends ListParams {
  /**
   * Absent lists ORDINARY decks only (references leave the default listing);
   * `brand` or `template` lists the references of that type; `reference`
   * lists every reference.
   */
  type?: PresentationsListType;
  /**
   * `true` keeps only the workspace's default references (at most one per
   * type). Without `type` the server reads it as `type=reference`.
   */
  default?: boolean;
}

/** Params of {@link PlatformClient.references}: the list's page plus a reference type. */
export interface ReferenceListParams extends ListParams {
  /** `brand`, `template`, or `reference` for every type (the default). */
  type?: PresentationsListType;
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

/** Filters of the whole-deck form-files zip (PRDCT-2403): the listing's own, minus the paging. */
export interface FormResponseFilesZipParams {
  /** Only files of this form's responses (the data-slideless-form name). */
  form?: string;
  /** Only files of responses that came through this share link (token id). */
  token?: string;
  /** Only files of direct-link or embedded submissions. */
  source?: FormResponseSourceValue;
  /** Only files of responses whose serving document carried this ?p= label. */
  placement?: string;
  /** ISO datetime — only files of responses created or edited at or after this instant. */
  since?: string;
}

/**
 * Thin typed client over /api/v1: the generic calls come from the chassis client,
 * instantiated with the Slideless scopes; the deck calls are declared here.
 */
export class PlatformClient extends ChassisClient<Scope> {
  // ── Presentations ─────────────────────────────────────────────────────────

  /**
   * Without `type` this lists ORDINARY decks only; `type` lists references
   * instead (`brand`, `template`, or `reference` for all of them), and
   * `default: true` keeps only the workspace's default references.
   */
  presentations(
    params: PresentationListParams = {}
  ): Promise<{ presentations: Presentation[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.type) query.set('type', params.type);
    if (params.default) query.set('default', 'true');
    const qs = query.toString();
    return this.request('GET', qs ? `/presentations?${qs}` : '/presentations');
  }

  /**
   * The references this credential can read: its own, plus the ones
   * published to the workspace. `type` defaults to `reference` (every type).
   */
  references(
    params: ReferenceListParams = {}
  ): Promise<{ presentations: Presentation[]; nextCursor: string | null }> {
    const { type = 'reference', ...page } = params;
    return this.presentations({ ...page, type });
  }

  /**
   * The workspace's default reference of a type, or null when none is set
   * (or this credential may not read it). Nothing is applied by the server:
   * read the reference's briefing with {@link agentDoc} and follow it.
   */
  async defaultReference(type: ReferenceType): Promise<Presentation | null> {
    const { presentations } = await this.presentations({ type, default: true, limit: 1 });
    return presentations[0] ?? null;
  }

  presentation(id: string): Promise<Presentation> {
    return this.request('GET', `/presentations/${encodeURIComponent(id)}`);
  }

  /**
   * Update mutable deck properties. `metadata` replaces the stored object
   * wholesale — read-modify-write to merge. On a reference, `audience`
   * (`private` | `workspace`) sets who reads it and `defaultReference` makes
   * it the workspace's default of its type: 422 `not_a_reference` on an
   * ordinary deck, 409 `audience_private` when the default is asked of a
   * private reference, 409 `default_reference` when the standing default is
   * made private, 403 `forbidden` when the caller reads the deck but may not
   * change that property.
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

  /** Pin/unpin version, rename, the per-link switches (annotate, forms, downloads, bar, remembering, file uploads), expiry, password (null clears). */
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

  // The files of form responses (PRDCT-2403): what respondents uploaded into
  // a form's file fields. `FormResponse.files` lists them (RAW respondent
  // input: escape `field` and `name`, never join `name` into a filesystem
  // path); these three calls fetch the bytes. Same return shape as every
  // streamed download here: the raw Response, PlatformApiError on a non-2xx.

  /** URL of one uploaded file of one response (attachment + nosniff, Range supported). */
  formResponseFileUrl(id: string, responseId: string, fileId: string): string {
    return (
      `${this.baseUrl}/api/v1/presentations/${encodeURIComponent(id)}/responses/` +
      `${encodeURIComponent(responseId)}/files/${encodeURIComponent(fileId)}`
    );
  }

  /**
   * Downloads one file a respondent uploaded. Raw Response so callers can
   * stream it; verify the bytes against the wire's `sizeBytes` and `sha256`
   * before keeping them.
   */
  async downloadFormResponseFile(id: string, responseId: string, fileId: string): Promise<Response> {
    return this.rawDownload(this.formResponseFileUrl(id, responseId, fileId));
  }

  /** URL of one response's files as one zip (`<field>/<file>`). */
  formResponseFilesZipUrl(id: string, responseId: string): string {
    return (
      `${this.baseUrl}/api/v1/presentations/${encodeURIComponent(id)}/responses/` +
      `${encodeURIComponent(responseId)}/files.zip`
    );
  }

  /**
   * Downloads one response's uploaded files as a streamed store-only zip (the
   * Content-Disposition carries its name). 404 no_files when it holds none.
   */
  async downloadFormResponseFilesZip(id: string, responseId: string): Promise<Response> {
    return this.rawDownload(this.formResponseFilesZipUrl(id, responseId));
  }

  /** URL of the whole deck's form-files zip, with its filters. */
  formResponsesFilesZipUrl(id: string, params: FormResponseFilesZipParams = {}): string {
    const query = new URLSearchParams();
    if (params.form) query.set('form', params.form);
    if (params.token) query.set('token', params.token);
    if (params.source) query.set('source', params.source);
    if (params.placement) query.set('placement', params.placement);
    if (params.since) query.set('since', params.since);
    const qs = query.toString();
    const base = `${this.baseUrl}/api/v1/presentations/${encodeURIComponent(id)}/responses/files.zip`;
    return qs ? `${base}?${qs}` : base;
  }

  /**
   * Downloads every uploaded file of the deck's responses as a streamed
   * store-only zip (`<form>/<response>/<field>/<file>`), sliceable like the
   * listing (form, share link, source, placement, time). 404 no_files when
   * nothing matches.
   */
  async downloadFormResponsesFilesZip(
    id: string,
    params: FormResponseFilesZipParams = {}
  ): Promise<Response> {
    return this.rawDownload(this.formResponsesFilesZipUrl(id, params));
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
}
