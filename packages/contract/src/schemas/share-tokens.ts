import { z } from 'zod';
import { plainText } from '@antasphere/chassis-contract';
import { versionNumberSchema } from './versions.js';

/**
 * Per-recipient share tokens: each recipient gets their own 48-byte secret
 * (returned once at creation, only its sha256 stored), so access is
 * observable and revocable per person. `versionMode` 'latest' follows the
 * deck; 'pinned' freezes the recipient on `pinnedVersion`. `expiresAt` and
 * `password` are the v2 improvements over the legacy model.
 */

export const shareTokenVersionModeSchema = z.enum(['latest', 'pinned']);
export type ShareTokenVersionMode = z.infer<typeof shareTokenVersionModeSchema>;

/**
 * Where the annotation overlay's floating badge sits for this link: the 4
 * corners plus the 4 edge centers (a bare edge name means that edge's
 * center). The badge floats over unknown deck content, so no automatic
 * placement can know what it covers — this is the one deliberately
 * user-controllable slot. Null on a token = inherit the deck's remembered
 * position (set by the last explicit choice), else bottom-right.
 */
export const badgePositionSchema = z.enum([
  'top-left',
  'top',
  'top-right',
  'right',
  'bottom-right',
  'bottom',
  'bottom-left',
  'left'
]);
export type BadgePositionValue = z.infer<typeof badgePositionSchema>;

/**
 * SERVER-SET token purpose. 'preview' rows are the dashboard's own transient
 * iframe tokens (ADR 012 Surface D): hidden from the share-links panel,
 * excluded from view stats, minted ONLY through the dedicated preview-token
 * endpoint (deck owner / workspace admin, 1 h expiry), and immutable once
 * minted. SECURITY: every preview behavior keys on this column — never on
 * the token NAME, which is client input (keying concealment on the name let
 * any deck writer, dev collaborators included, mint stat-silent hidden
 * links). The public token-create endpoint always mints 'share'.
 */
export const shareTokenPurposeSchema = z.enum(['share', 'preview']);
export type ShareTokenPurpose = z.infer<typeof shareTokenPurposeSchema>;

/**
 * Default display label the SERVER gives preview tokens it mints. Purely
 * cosmetic (audit metadata, admin tooling): a user may freely name a normal
 * share token "Dashboard preview" and it behaves like any other token —
 * visible in the panel, counted in stats. Nothing keys on this string; the
 * marker is the `purpose` column above.
 */
export const PREVIEW_SHARE_TOKEN_NAME = 'Dashboard preview';

/**
 * The exact iframe `sandbox` attribute set for embedding the viewer — ADR
 * 012 Surface D. Single source of truth: the dashboard's deck preview, the
 * official embed loader (`GET /embed.js`), the copyable embed snippets, and
 * the docs all carry exactly this string. SECURITY: this must NEVER gain
 * `allow-same-origin` (that one token re-opens full session theft, ADR 012
 * Surface C) or `allow-top-navigation*` (framebusting).
 * `allow-popups-to-escape-sandbox` (PRDCT-2268) is deliberate: it lifts the
 * sandbox on windows the deck OPENS (window.open, target=_blank), never on
 * the deck itself — without it an opened application runs in an opaque
 * origin and cannot boot. Pinned by decks.test.ts (dashboard) and
 * embed.test.ts (server).
 */
export const VIEWER_IFRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

export const shareTokenSchema = z.object({
  id: z.string(),
  presentationId: z.string(),
  /** Owner-facing recipient label — never shown to the recipient. */
  name: z.string(),
  /** 'share' (normal, visible, counted) or 'preview' (dashboard plumbing). */
  purpose: shareTokenPurposeSchema,
  versionMode: shareTokenVersionModeSchema,
  /** The frozen version — null while versionMode is 'latest'. */
  pinnedVersion: z.number().int().nullable(),
  canAnnotate: z.boolean(),
  /** Whether viewers of this link may submit the deck's embedded forms. */
  canSubmitForms: z.boolean(),
  /**
   * Whether viewers of this link may download the version's attachments
   * (the `downloads/` folder, PRDCT-2278). Off = the attachment routes 404
   * and the recipient list is empty; the deck itself still shows.
   */
  canDownload: z.boolean(),
  /**
   * Whether the recipient top bar rides this link (PRDCT-2281): the strip
   * over the deck with its title, its version and its attachments to
   * download. Off = a bare deck. Top-level navigations only: embeds and
   * frames are bare whatever this says.
   */
  showBar: z.boolean(),
  /**
   * Whether this link REMEMBERS its respondent's form answers (PRDCT-2328):
   * reopening the link plainly brings the answers back, and every submit
   * through it updates the one remembered answer per form instead of
   * creating a new response. Whoever holds the link can then read and
   * change those answers — the sharing surfaces say so. Never true on a
   * preview token.
   */
  remembersResponses: z.boolean(),
  /**
   * Whether respondents on this link may upload files into the deck's form
   * file fields (PRDCT-2403). Needs `canSubmitForms` too. Off = the upload
   * route answers 403 and the runtime shows the file field as unavailable;
   * the rest of the form still submits. Never true on a preview token.
   */
  canUploadFiles: z.boolean(),
  /** Per-link badge slot; null = deck default (then bottom-right). */
  badgePosition: badgePositionSchema.nullable(),
  expiresAt: z.string().nullable(),
  /** Whether a viewer password is set (the hash never leaves the server). */
  hasPassword: z.boolean(),
  revokedAt: z.string().nullable(),
  accessCount: z.number().int(),
  lastAccessedAt: z.string().nullable(),
  /**
   * Attachment downloads through this link: one per file taken, one per
   * whole-set zip. Never a view, never de-duplicated; owner previews and
   * HEAD requests never count.
   */
  downloadCount: z.number().int().min(0),
  createdAt: z.string()
});
export type ShareToken = z.infer<typeof shareTokenSchema>;

export const shareTokensListSchema = z.object({
  shareTokens: z.array(shareTokenSchema),
  nextCursor: z.string().nullable()
});

const pinnedVersionConsistent = (v: {
  versionMode?: 'latest' | 'pinned' | undefined;
  pinnedVersion?: number | null | undefined;
}) => v.versionMode !== 'pinned' || typeof v.pinnedVersion === 'number';

export const shareTokenCreateSchema = z
  .object({
    name: plainText(1, 200),
    versionMode: shareTokenVersionModeSchema.default('latest'),
    /** Required when versionMode is 'pinned'. */
    pinnedVersion: versionNumberSchema.optional(),
    canAnnotate: z.boolean().default(false),
    /**
     * Forms submit ON by default — a deck's embedded form is its intended
     * interaction (unlike the opt-in annotation layer), so push + share
     * yields a working form with zero flags. Opt out per link.
     */
    canSubmitForms: z.boolean().default(true),
    /**
     * Downloads ON by default (PRDCT-2278): a link exposes the version's
     * attachments unless the owner switches it off — the files were put in
     * `downloads/` to be handed out. Opt out per link.
     */
    canDownload: z.boolean().default(true),
    /**
     * The recipient top bar ON by default (PRDCT-2281): a recipient should
     * know what they are looking at. Opt out per link for a bare deck.
     */
    showBar: z.boolean().default(true),
    /**
     * The link remembers its answers, ON by default (PRDCT-2328; Romain,
     * 2026-09-14: "by default a link is a form"): a link minted for one
     * named recipient IS that person's response. Switch it off for a link
     * many people will open (a public post, an embed page's direct URL) —
     * every submit then creates its own response, as before. Embedded
     * frames never remember, whatever this says.
     */
    remembersResponses: z.boolean().default(true),
    /**
     * File uploads ON by default for a NEW link (PRDCT-2403): a file field
     * is the deck's own intended interaction, like the form around it, so
     * push + share yields a working drop panel with zero flags. Opt out per
     * link. Links minted before the switch existed stay OFF until their
     * owner turns them on — a link already in circulation never gains a
     * public write capability by itself.
     */
    canUploadFiles: z.boolean().default(true),
    /**
     * Explicit badge slot for this link. Also becomes the deck's remembered
     * default for future links. Omitted = inherit the deck's remembered
     * position.
     */
    badgePosition: badgePositionSchema.optional(),
    expiresAt: z.iso.datetime().optional(),
    /** Optional viewer password (stored hashed, shown as hasPassword). */
    password: z.string().min(4).max(256).optional()
  })
  .refine(pinnedVersionConsistent, {
    message: 'pinnedVersion is required when versionMode is "pinned"'
  });
/**
 * The CLIENT-facing shape: the schema's INPUT, so every field the server
 * defaults (versionMode, canAnnotate, canSubmitForms, canDownload, showBar, …) is
 * optional to a caller. A client that had to spell out every default would
 * break at typecheck each time the contract gained one (PRDCT-2278 did);
 * the server validates against the schema and reads the output type.
 */
export type ShareTokenCreate = z.input<typeof shareTokenCreateSchema>;

/**
 * Body of the dedicated preview-token endpoint (owner/admin only). The
 * server fixes everything else: purpose 'preview', the display name, a 1 h
 * expiry, no annotations, no password. `version` pins the preview; omitted
 * = follow latest.
 */
export const previewTokenCreateSchema = z.object({
  /** Pin the preview to this version; omitted = latest. */
  version: versionNumberSchema.optional()
});
export type PreviewTokenCreate = z.infer<typeof previewTokenCreateSchema>;

/**
 * The secret appears ONLY here (like API keys): store `url`, hand it to the
 * recipient — it is never retrievable again.
 */
export const shareTokenCreatedSchema = z.object({
  shareToken: shareTokenSchema,
  /** The recipient secret, base64url. Shown once. */
  secret: z.string(),
  /** The full viewer URL carrying the secret (path-based — no ?token=). */
  url: z.string()
});
export type ShareTokenCreated = z.infer<typeof shareTokenCreatedSchema>;

/** Patch semantics: omitted = unchanged; explicit null clears (expiry/password). */
export const shareTokenUpdateSchema = z
  .object({
    name: plainText(1, 200).optional(),
    versionMode: shareTokenVersionModeSchema.optional(),
    /** Required alongside versionMode 'pinned'; ignored for 'latest'. */
    pinnedVersion: versionNumberSchema.optional(),
    canAnnotate: z.boolean().optional(),
    canSubmitForms: z.boolean().optional(),
    canDownload: z.boolean().optional(),
    showBar: z.boolean().optional(),
    remembersResponses: z.boolean().optional(),
    canUploadFiles: z.boolean().optional(),
    /**
     * Explicit slot (also updates the deck's remembered default) or null to
     * fall back to the deck default again.
     */
    badgePosition: badgePositionSchema.nullable().optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
    password: z.string().min(4).max(256).nullable().optional()
  })
  .refine(pinnedVersionConsistent, {
    message: 'pinnedVersion is required when versionMode is "pinned"'
  });
export type ShareTokenUpdate = z.infer<typeof shareTokenUpdateSchema>;

export const shareTokenSendSchema = z.object({
  email: z.email(),
  /** Optional personal note included in the share email. */
  message: z.string().max(2000).optional()
});
export type ShareTokenSend = z.infer<typeof shareTokenSendSchema>;

export const shareTokenSentSchema = z.object({
  shareToken: shareTokenSchema,
  /** False when the instance has no delivering email driver. */
  emailSent: z.boolean()
});
export type ShareTokenSent = z.infer<typeof shareTokenSentSchema>;

/**
 * One counted view of a share link (PRDCT-1313). Recorded under exactly the
 * gate that increments accessCount — dedupe-window repeats, preview tokens,
 * asset fetches, and HEAD never produce an event. Privacy posture (fixed):
 * NO IP, NO geolocation, NO full referrer URL — host, sanitized placement
 * label, and coarse browser family only.
 */
export const shareTokenViewSchema = z.object({
  id: z.string(),
  /** The deck version the recipient was served. */
  version: z.number().int(),
  occurredAt: z.string(),
  /** Host of the referring site (e.g. "docs.example.com"); null = direct/unknown. */
  referrerHost: z.string().nullable(),
  /** The entry URL's sanitized `?p=` label (≤64 chars, [A-Za-z0-9._-]); null when absent/illegal. */
  placement: z.string().nullable(),
  /** Coarse browser family: chrome, firefox, safari, edge, bot, or other; null when no UA. */
  uaFamily: z.string().nullable()
});
export type ShareTokenView = z.infer<typeof shareTokenViewSchema>;

export const shareTokenViewsListSchema = z.object({
  views: z.array(shareTokenViewSchema),
  nextCursor: z.string().nullable()
});
export type ShareTokenViewsList = z.infer<typeof shareTokenViewsListSchema>;
