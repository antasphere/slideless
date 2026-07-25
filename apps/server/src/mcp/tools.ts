import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { badgePositionSchema } from '@slideless/contract';
import { ApiToolError, deny, jsonText, wrapToolErrors, type ToolTextResult } from './errors.js';
import {
  callApi,
  checkScope,
  fetchApiRaw,
  forWorkspace,
  pageQuery,
  type McpToolContext
} from './tool-kit.js';

/**
 * The slideless_ tool set: the product surface (decks, versions, sharing,
 * collaborators, annotations) exposed as MCP tools. Every tool is a thin
 * shim over the instance's own /api/v1 called in-process with the caller's
 * bearer forwarded verbatim — identity always comes from the verified
 * credential, never from a tool parameter, and the API's fail-closed scope
 * allowlist plus ADR 013 deck-read privacy apply unchanged (a tool can never
 * read a deck the caller can't).
 *
 * Conventions (the chassis patterns in server.ts):
 *  - reads: `readOnlyHint: true` + presentations:read pre-check
 *  - writes: confirm-first description + presentations:write
 *    (+ `destructiveHint: true` for deletes/revokes)
 *  - one JSON text block out; API failures map to code + `Next:` hints
 *    through wrapToolErrors (errors.ts).
 *
 * Inline upload/download caps: the /mcp transport rejects request bodies
 * over 1 MiB, so inline uploads are capped at 768 KiB of decoded content
 * (base64 inflation keeps anything larger from ever fitting) and version
 * downloads inline at most 256 KiB per text file / 1 MiB total. Anything
 * bigger belongs to the CLI (`slideless push` / `slideless pull`).
 */

const INLINE_UPLOAD_TOTAL_MAX = 768 * 1024;
const INLINE_DOWNLOAD_FILE_MAX = 256 * 1024;
const INLINE_DOWNLOAD_TOTAL_MAX = 1024 * 1024;
const CLI_HINT = 'use the slideless CLI (`slideless push` / `slideless pull`) for large decks';

// ── Wire shapes the flows below need (subset of the contract) ───────────────

interface PresentationWire {
  id: string;
  title: string;
  currentVersion: number;
  entryPath: string;
}

interface VersionDetailWire {
  version: number;
  entryPath: string;
  manifest: Array<{ path: string; sha256: string; sizeBytes: number; contentType: string }>;
}

interface ShareTokenWire {
  id: string;
  name: string;
  revokedAt: string | null;
}

// ── Content-type + entry heuristics (the CLI's manifest.ts, inline flavor) ──

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.wasm': 'application/wasm'
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function isTextual(contentType: string): boolean {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'application/javascript' ||
    base === 'image/svg+xml' ||
    base.endsWith('+json') ||
    base.endsWith('+xml')
  );
}

/** index.html at the root, else the single .html — the CLI's detectEntry. */
function detectEntry(paths: string[], explicit?: string): string {
  if (explicit) {
    const normalized = explicit.replace(/^\.\//, '');
    if (!paths.includes(normalized)) {
      throw new InlineUploadError(`entryPath "${explicit}" is not among the uploaded files`);
    }
    return normalized;
  }
  if (paths.includes('index.html')) return 'index.html';
  const htmls = paths.filter((p) => p.endsWith('.html') || p.endsWith('.htm'));
  if (htmls.length === 1) return htmls[0]!;
  if (htmls.length === 0) {
    throw new InlineUploadError('No HTML entry found — a deck needs at least one .html file');
  }
  throw new InlineUploadError(
    `Multiple HTML files and no index.html — pass entryPath to pick one (${htmls.slice(0, 5).join(', ')})`
  );
}

/** Caller-fixable inline-upload problems, surfaced as clean tool errors. */
class InlineUploadError extends Error {}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

interface InlineFileInput {
  path: string;
  contentText?: string | undefined;
  contentBase64?: string | undefined;
  contentType?: string | undefined;
}

interface DecodedFile {
  path: string;
  bytes: Buffer;
  contentType: string;
  sha256: string;
}

function decodeInlineFiles(files: InlineFileInput[]): DecodedFile[] {
  const seen = new Set<string>();
  const decoded: DecodedFile[] = [];
  let total = 0;
  for (const f of files) {
    if (seen.has(f.path)) throw new InlineUploadError(`Duplicate path "${f.path}" in files`);
    seen.add(f.path);
    if ((f.contentText === undefined) === (f.contentBase64 === undefined)) {
      throw new InlineUploadError(`File "${f.path}": provide exactly one of contentText or contentBase64`);
    }
    let bytes: Buffer;
    if (f.contentText !== undefined) {
      bytes = Buffer.from(f.contentText, 'utf8');
    } else {
      const compact = f.contentBase64!.replace(/\s+/g, '');
      if (!BASE64_RE.test(compact)) {
        throw new InlineUploadError(`File "${f.path}": contentBase64 is not valid base64`);
      }
      bytes = Buffer.from(compact, 'base64');
    }
    if (bytes.length === 0) throw new InlineUploadError(`File "${f.path}" is empty`);
    total += bytes.length;
    if (total > INLINE_UPLOAD_TOTAL_MAX) {
      throw new InlineUploadError(
        `Inline content exceeds the ${Math.floor(INLINE_UPLOAD_TOTAL_MAX / 1024)} KiB limit ` +
          `(the /mcp transport caps request bodies at 1 MiB) — ${CLI_HINT}.`
      );
    }
    decoded.push({
      path: f.path,
      bytes,
      contentType: f.contentType ?? contentTypeFor(f.path),
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
  }
  return decoded;
}

/** First <title> text of an HTML entry, as the default deck title. */
function titleFromHtml(html: string): string | null {
  const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html);
  const t = m?.[1]?.trim();
  return t ? t : null;
}

// ── The 3-step push protocol (precheck → upload missing → commit) ───────────

interface PushOptions {
  title?: string | undefined;
  kind?: 'presentation' | 'app' | 'plan' | undefined;
  interactive?: boolean | undefined;
  entryPath?: string | undefined;
  /** Set = commit a new version onto this existing deck instead of creating one. */
  presentationId?: string | undefined;
}

async function pushInlineDeck(
  c: McpToolContext,
  files: DecodedFile[],
  opts: PushOptions
): Promise<ToolTextResult> {
  const entryPath = detectEntry(
    files.map((f) => f.path),
    opts.entryPath
  );
  const manifest = files.map((f) => ({
    path: f.path,
    sha256: f.sha256,
    sizeBytes: f.bytes.length,
    contentType: f.contentType
  }));

  // Step 1 — precheck: which blobs does the workspace still miss?
  const { missing } = (await callApi(c, '/api/v1/presentations/precheck', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sha256: [...new Set(files.map((f) => f.sha256))] })
  })) as { missing: string[] };

  // Step 2 — upload exactly the missing blobs (one representative per hash).
  const missingSet = new Set(missing);
  const queue = [
    ...new Map(files.filter((f) => missingSet.has(f.sha256)).map((f) => [f.sha256, f])).values()
  ];
  for (const file of queue) {
    const form = new FormData();
    form.set('sha256', file.sha256);
    form.set(
      'file',
      new File([new Uint8Array(file.bytes)], file.path.split('/').pop() ?? file.path, {
        type: file.contentType
      })
    );
    await fetchApiRaw(c, '/api/v1/presentations/assets', { method: 'POST', body: form });
  }

  // Step 3 — commit: a new version on an existing deck, or session + deck.
  let committed: unknown;
  if (opts.presentationId) {
    const deck = (await callApi(
      c,
      `/api/v1/presentations/${encodeURIComponent(opts.presentationId)}`
    )) as PresentationWire;
    committed = await callApi(c, `/api/v1/presentations/${encodeURIComponent(deck.id)}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedBaseVersion: deck.currentVersion,
        entryPath,
        manifest,
        ...(opts.title ? { title: opts.title } : {})
      })
    });
  } else {
    const entryFile = files.find((f) => f.path === entryPath);
    const title =
      opts.title ??
      (entryFile && isTextual(entryFile.contentType)
        ? titleFromHtml(entryFile.bytes.toString('utf8'))
        : null) ??
      'Untitled presentation';
    const { uploadSession } = (await callApi(c, '/api/v1/presentations/uploads', { method: 'POST' })) as {
      uploadSession: { id: string };
    };
    committed = await callApi(
      c,
      `/api/v1/presentations/uploads/${encodeURIComponent(uploadSession.id)}/commit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          kind: opts.kind ?? 'presentation',
          interactive: opts.interactive ?? false,
          entryPath,
          manifest
        })
      }
    );
  }
  const result = committed as { presentation: unknown; version: unknown };
  return jsonText({
    presentation: result.presentation,
    version: result.version,
    uploadedBlobs: queue.length,
    deduplicatedBlobs: files.length - queue.length
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerSlidelessTools(server: McpServer, ctx: McpToolContext): void {
  // Every tool threads its optional `workspace` argument through these
  // wrappers into forWorkspace, so the selection rides the ONE header the
  // whole platform authorizes (the in-process re-entry, tool-kit.ts) — a
  // tool argument can never reach a workspace the caller's own memberships
  // do not grant.
  const read = (
    workspace: string | undefined,
    fn: (c: McpToolContext) => Promise<ToolTextResult>
  ): Promise<ToolTextResult> | ToolTextResult => {
    const denied = checkScope(ctx.principal, 'presentations:read');
    if (denied) return denied;
    return wrapToolErrors(() => fn(forWorkspace(ctx, workspace)));
  };
  const write = (
    workspace: string | undefined,
    fn: (c: McpToolContext) => Promise<ToolTextResult>
  ): Promise<ToolTextResult> | ToolTextResult => {
    const denied = checkScope(ctx.principal, 'presentations:write');
    if (denied) return denied;
    return wrapToolErrors(async () => {
      try {
        return await fn(forWorkspace(ctx, workspace));
      } catch (e) {
        if (e instanceof InlineUploadError) return deny(e.message);
        throw e;
      }
    });
  };

  const deckIdInput = z.uuid().describe('Presentation (deck) id.');
  const workspaceInput = z
    .uuid()
    .optional()
    .describe('Target organization (workspace id). Omit to use your default org — see slideless_whoami.');
  const cursorInput = z.string().optional().describe('nextCursor from a previous page.');
  const limitInput = z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Page size (server max 100). Default 50.');

  // ── Identity ───────────────────────────────────────────────────────────────

  server.registerTool(
    'slideless_whoami',
    {
      description:
        'Who is connected: the user this MCP connection acts as, plus ALL their organizations ' +
        '(workspaces) with per-entry role/default/suspended flags. Returns { user: { id, email, ' +
        'name }, workspace, role, via, scopes, workspaces: [...], activeWorkspaceId }. The ' +
        'credential is the USER; the organization is a PER-CALL parameter: every tool accepts an ' +
        'optional `workspace` (an id from `workspaces[]`) — omitted, the entry flagged `default: ' +
        'true` is used (else the oldest membership). Call this first to discover the ids.',
      inputSchema: { workspace: workspaceInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace }) => read(workspace, async (c) => jsonText(await callApi(c, '/api/v1/me')))
  );

  // ── Decks: reads ───────────────────────────────────────────────────────────

  server.registerTool(
    'slideless_list_presentations',
    {
      description:
        'List the presentations (decks) this credential can read, newest first — deck reads are ' +
        'private: owners and workspace admins see the workspace, others see owned decks plus active ' +
        'collaborations. Returns { presentations: [...], nextCursor }; when nextCursor is non-null, ' +
        'call again with cursor set to it.',
      inputSchema: { workspace: workspaceInput, cursor: cursorInput, limit: limitInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, cursor, limit }) =>
      read(workspace, async (c) =>
        jsonText(await callApi(c, pageQuery('/api/v1/presentations', { cursor, limit })))
      )
  );

  server.registerTool(
    'slideless_get_presentation',
    {
      description:
        'One presentation by id: title, kind, currentVersion, entryPath, owner, timestamps. ' +
        'Answers not_found for decks this credential cannot read.',
      inputSchema: { workspace: workspaceInput, presentationId: deckIdInput },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, presentationId }) =>
      read(workspace, async (c) =>
        jsonText(await callApi(c, `/api/v1/presentations/${encodeURIComponent(presentationId)}`))
      )
  );

  server.registerTool(
    'slideless_list_versions',
    {
      description:
        "A deck's immutable version history, newest first (metadata only — file lists come from " +
        'slideless_get_version). Returns { versions: [...], nextCursor }.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        cursor: cursorInput,
        limit: limitInput
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, presentationId, cursor, limit }) =>
      read(workspace, async (c) =>
        jsonText(
          await callApi(
            c,
            pageQuery(`/api/v1/presentations/${encodeURIComponent(presentationId)}/versions`, {
              cursor,
              limit
            })
          )
        )
      )
  );

  server.registerTool(
    'slideless_get_version',
    {
      description:
        'One deck version INCLUDING its full manifest (path, sha256, sizeBytes, contentType per ' +
        'file). Omit version for the latest. Use slideless_download_version to also get file contents.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        version: z.number().int().min(1).optional().describe('Version number; omitted = the latest version.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, presentationId, version }) =>
      read(workspace, async (c) => {
        const v = version ?? (await currentVersionOf(c, presentationId));
        return jsonText(
          await callApi(c, `/api/v1/presentations/${encodeURIComponent(presentationId)}/versions/${v}`)
        );
      })
  );

  server.registerTool(
    'slideless_download_version',
    {
      description:
        'Download a deck version: the manifest plus the CONTENT of its text files inlined (up to ' +
        `${Math.floor(INLINE_DOWNLOAD_FILE_MAX / 1024)} KiB per file / 1 MiB total). Binary or oversized files ` +
        'come back as metadata with a note — pull those with the CLI (`slideless pull <deckId>`). ' +
        'Omit version for the latest.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        version: z.number().int().min(1).optional().describe('Version number; omitted = the latest version.')
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, presentationId, version }) =>
      read(workspace, async (c) => {
        const id = encodeURIComponent(presentationId);
        const v = version ?? (await currentVersionOf(c, presentationId));
        const detail = (await callApi(c, `/api/v1/presentations/${id}/versions/${v}`)) as VersionDetailWire;
        let budget = INLINE_DOWNLOAD_TOTAL_MAX;
        const files: Array<Record<string, unknown>> = [];
        for (const entry of detail.manifest) {
          const base = {
            path: entry.path,
            sha256: entry.sha256,
            sizeBytes: entry.sizeBytes,
            contentType: entry.contentType
          };
          if (!isTextual(entry.contentType)) {
            files.push({ ...base, inlined: false, note: `binary content — ${CLI_HINT}` });
            continue;
          }
          if (entry.sizeBytes > INLINE_DOWNLOAD_FILE_MAX) {
            files.push({
              ...base,
              inlined: false,
              note: `exceeds the ${Math.floor(INLINE_DOWNLOAD_FILE_MAX / 1024)} KiB inline cap — ${CLI_HINT}`
            });
            continue;
          }
          if (entry.sizeBytes > budget) {
            files.push({ ...base, inlined: false, note: `total inline budget exhausted — ${CLI_HINT}` });
            continue;
          }
          const res = await fetchApiRaw(c, `/api/v1/presentations/${id}/assets/${entry.sha256}`);
          const content = await res.text();
          budget -= entry.sizeBytes;
          files.push({ ...base, inlined: true, content });
        }
        return jsonText({
          presentationId,
          version: detail.version,
          entryPath: detail.entryPath,
          files
        });
      })
  );

  // ── Decks: writes ──────────────────────────────────────────────────────────

  server.registerTool(
    'slideless_upload_html_presentation',
    {
      description:
        'Create a NEW deck from a single self-contained HTML document (uploaded as index.html). ' +
        'Returns { presentation, version } — share it next with slideless_add_share_token. Inline ' +
        `uploads are capped at ${Math.floor(INLINE_UPLOAD_TOTAL_MAX / 1024)} KiB; ${CLI_HINT}. ` +
        'Always confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        html: z.string().min(1).describe('The complete HTML document.'),
        title: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe("Deck title. Default: the HTML's <title>, else 'Untitled presentation'."),
        kind: z
          .enum(['presentation', 'app', 'plan'])
          .optional()
          .describe("Deck kind (default 'presentation')."),
        interactive: z.boolean().optional().describe('Mark the deck as embedding interactive content.')
      }
    },
    async ({ workspace, html, title, kind, interactive }) =>
      write(workspace, async (c) => {
        const files = decodeInlineFiles([
          { path: 'index.html', contentText: html, contentType: 'text/html' }
        ]);
        return pushInlineDeck(c, files, { title, kind, interactive });
      })
  );

  server.registerTool(
    'slideless_upload_presentation_files',
    {
      description:
        'Upload a multi-file deck from inline content: each file carries contentText (UTF-8) or ' +
        'contentBase64 (binary). Without presentationId this creates a NEW deck; with it, it commits ' +
        'the files as a NEW VERSION of that deck (full snapshot — list every file the version should ' +
        `contain). Inline uploads are capped at ${Math.floor(INLINE_UPLOAD_TOTAL_MAX / 1024)} KiB total; ` +
        `${CLI_HINT}. Returns { presentation, version }. Always confirm with the user before calling.`,
      inputSchema: {
        workspace: workspaceInput,
        files: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .max(1024)
                .describe('Relative path inside the deck, e.g. "index.html" or "assets/logo.png".'),
              contentText: z.string().optional().describe('UTF-8 text content (exactly one of the two).'),
              contentBase64: z.string().optional().describe('Base64-encoded binary content.'),
              contentType: z
                .string()
                .min(1)
                .max(255)
                .optional()
                .describe('MIME type; inferred from the extension when omitted.')
            })
          )
          .min(1)
          .max(100)
          .describe('The complete file set of the version.'),
        title: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe('Deck title (new decks) or retitle (new versions). Default: entry <title>.'),
        entryPath: z
          .string()
          .optional()
          .describe('Entry document (default: index.html, or the only .html file).'),
        kind: z
          .enum(['presentation', 'app', 'plan'])
          .optional()
          .describe("Deck kind, new decks only (default 'presentation')."),
        interactive: z.boolean().optional().describe('Interactive-content flag, new decks only.'),
        presentationId: z
          .uuid()
          .optional()
          .describe('Existing deck id — commit these files as its next version instead of creating a deck.')
      }
    },
    async ({ workspace, files, title, entryPath, kind, interactive, presentationId }) =>
      write(workspace, async (c) =>
        pushInlineDeck(c, decodeInlineFiles(files), { title, entryPath, kind, interactive, presentationId })
      )
  );

  server.registerTool(
    'slideless_delete_presentation',
    {
      description:
        'DELETE a presentation: the deck, its versions and its share links stop resolving ' +
        '(soft delete — not undoable through the API). Only the deck owner or a workspace admin ' +
        'may delete. Always confirm with the user before calling.',
      inputSchema: { workspace: workspaceInput, presentationId: deckIdInput },
      annotations: { destructiveHint: true }
    },
    async ({ workspace, presentationId }) =>
      write(workspace, async (c) =>
        jsonText(
          await callApi(c, `/api/v1/presentations/${encodeURIComponent(presentationId)}`, {
            method: 'DELETE'
          })
        )
      )
  );

  // ── Sharing ────────────────────────────────────────────────────────────────

  server.registerTool(
    'slideless_add_share_token',
    {
      description:
        'Create a share link for a deck: returns { shareToken, secret, url } where url is the ' +
        'public viewer link to hand to the recipient — the secret appears ONLY in this response. ' +
        'Supports a per-recipient name label, pinning to a version (default: follow the latest), ' +
        'reviewer annotations, expiry, and a viewer password. Always confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        name: z
          .string()
          .min(1)
          .max(200)
          .describe('Recipient label, e.g. "Alice (VC intro)" — owner-facing, never shown to the recipient.'),
        pinnedVersion: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Freeze the recipient on this version; omitted = they always see the latest.'),
        canAnnotate: z.boolean().optional().describe('Let the recipient leave annotations (default false).'),
        badgePosition: badgePositionSchema
          .optional()
          .describe(
            'Annotation badge slot (4 corners + 4 edge centers, e.g. "top-left", "bottom"); an ' +
              "explicit choice is remembered as the deck's default for future links. Omitted = " +
              'inherit the deck default (else bottom-right).'
          ),
        expiresAt: z.iso.datetime().optional().describe('ISO 8601 expiry; omitted = never expires.'),
        password: z.string().min(4).max(256).optional().describe('Viewer password gate (optional).')
      }
    },
    async ({ workspace, presentationId, name, pinnedVersion, canAnnotate, badgePosition, expiresAt, password }) =>
      write(workspace, async (c) =>
        jsonText(
          await callApi(c, `/api/v1/presentations/${encodeURIComponent(presentationId)}/tokens`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name,
              versionMode: pinnedVersion !== undefined ? 'pinned' : 'latest',
              ...(pinnedVersion !== undefined ? { pinnedVersion } : {}),
              canAnnotate: canAnnotate ?? false,
              ...(badgePosition !== undefined ? { badgePosition } : {}),
              ...(expiresAt !== undefined ? { expiresAt } : {}),
              ...(password !== undefined ? { password } : {})
            })
          })
        )
      )
  );

  server.registerTool(
    'slideless_list_share_tokens',
    {
      description:
        "A deck's share tokens with access stats (name, versionMode, pinnedVersion, expiry, " +
        'hasPassword, revokedAt, accessCount). accessCount is de-duplicated opens — repeat opens ' +
        'from one browser within the configured window count once, not raw request hits. Secrets ' +
        'are never retrievable — only creation returns them. Returns { shareTokens: [...], nextCursor }.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        cursor: cursorInput,
        limit: limitInput
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, presentationId, cursor, limit }) =>
      read(workspace, async (c) =>
        jsonText(
          await callApi(
            c,
            pageQuery(`/api/v1/presentations/${encodeURIComponent(presentationId)}/tokens`, { cursor, limit })
          )
        )
      )
  );

  server.registerTool(
    'slideless_set_token_version_mode',
    {
      description:
        "Switch a share token between following the deck's latest version and being pinned to one " +
        "('pinned' requires pinnedVersion). Always confirm with the user before calling.",
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        tokenId: z.uuid().describe('Share token id (from creation or slideless_list_share_tokens).'),
        mode: z.enum(['latest', 'pinned']).describe("'latest' follows the deck; 'pinned' freezes a version."),
        pinnedVersion: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The version to pin (required for 'pinned').")
      }
    },
    async ({ workspace, presentationId, tokenId, mode, pinnedVersion }) =>
      write(workspace, async (c) => {
        if (mode === 'pinned' && pinnedVersion === undefined) {
          return deny("pinnedVersion is required when mode is 'pinned'.");
        }
        return jsonText(
          await callApi(
            c,
            `/api/v1/presentations/${encodeURIComponent(presentationId)}/tokens/${encodeURIComponent(tokenId)}`,
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                mode === 'latest' ? { versionMode: 'latest' } : { versionMode: 'pinned', pinnedVersion }
              )
            }
          )
        );
      })
  );

  server.registerTool(
    'slideless_unshare_presentation',
    {
      description:
        'Revoke share access: with tokenId, revokes that one token; without it, revokes EVERY ' +
        'active share token of the deck. Revoked links stop resolving immediately and cannot be ' +
        're-enabled (mint new ones instead). Always confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        tokenId: z.uuid().optional().describe('One token to revoke; omitted = revoke ALL active tokens.')
      },
      annotations: { destructiveHint: true }
    },
    async ({ workspace, presentationId, tokenId }) =>
      write(workspace, async (c) => {
        const id = encodeURIComponent(presentationId);
        if (tokenId) {
          return jsonText(
            await callApi(c, `/api/v1/presentations/${id}/tokens/${encodeURIComponent(tokenId)}`, {
              method: 'DELETE'
            })
          );
        }
        const revoked: Array<{ id: string; name: string }> = [];
        let cursor: string | undefined;
        do {
          const page = (await callApi(
            c,
            pageQuery(`/api/v1/presentations/${id}/tokens`, { cursor, limit: 100 })
          )) as {
            shareTokens: ShareTokenWire[];
            nextCursor: string | null;
          };
          for (const token of page.shareTokens) {
            if (token.revokedAt !== null) continue;
            await callApi(c, `/api/v1/presentations/${id}/tokens/${encodeURIComponent(token.id)}`, {
              method: 'DELETE'
            });
            revoked.push({ id: token.id, name: token.name });
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return jsonText({ presentationId, revokedCount: revoked.length, revoked });
      })
  );

  server.registerTool(
    'slideless_share_via_email',
    {
      description:
        "Email a share token's viewer link to a recipient. NOTE: secrets are stored hashed, so a " +
        'delivered send ROTATES the token onto a fresh link (the old URL stops working); when the ' +
        'instance has no email driver, nothing is sent and emailSent is false — hand over the ' +
        'create-time url instead. Always confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        tokenId: z.uuid().describe('The share token to send.'),
        email: z.email().describe('Recipient email address.'),
        message: z.string().max(2000).optional().describe('Personal note included in the email.')
      }
    },
    async ({ workspace, presentationId, tokenId, email, message }) =>
      write(workspace, async (c) =>
        jsonText(
          await callApi(
            c,
            `/api/v1/presentations/${encodeURIComponent(presentationId)}/tokens/${encodeURIComponent(tokenId)}/send`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email, ...(message !== undefined ? { message } : {}) })
            }
          )
        )
      )
  );

  // ── Collaborators ──────────────────────────────────────────────────────────

  server.registerTool(
    'slideless_list_collaborators',
    {
      description:
        "A deck's collaborator grants (email, status pending/active/revoked, claimedAt). Visible " +
        'to the deck owner, workspace admins, and active collaborators. Returns ' +
        '{ collaborators: [...], nextCursor }.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        cursor: cursorInput,
        limit: limitInput
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, presentationId, cursor, limit }) =>
      read(workspace, async (c) =>
        jsonText(
          await callApi(
            c,
            pageQuery(`/api/v1/presentations/${encodeURIComponent(presentationId)}/collaborators`, {
              cursor,
              limit
            })
          )
        )
      )
  );

  server.registerTool(
    'slideless_invite_collaborator',
    {
      description:
        'Invite an email address as a dev collaborator on ONE deck (they can push versions and ' +
        'manage sharing of that deck only). Returns { collaborator, claimUrl, emailSent } — the ' +
        'claimUrl is always returned; hand it to the invitee when emailSent is false. Only the deck ' +
        'owner or a workspace admin can invite. Always confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        email: z.email().describe("The invitee's email address.")
      }
    },
    async ({ workspace, presentationId, email }) =>
      write(workspace, async (c) =>
        jsonText(
          await callApi(c, `/api/v1/presentations/${encodeURIComponent(presentationId)}/collaborators`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email })
          })
        )
      )
  );

  server.registerTool(
    'slideless_uninvite_collaborator',
    {
      description:
        "Revoke a collaborator's grant on a deck — their content access and push rights stop " +
        'immediately (pending invites die too). Not undoable; re-invite to restore access. Always ' +
        'confirm with the user before calling.',
      inputSchema: {
        workspace: workspaceInput,
        presentationId: deckIdInput,
        collaboratorId: z.uuid().describe('Collaborator grant id (from slideless_list_collaborators).')
      },
      annotations: { destructiveHint: true }
    },
    async ({ workspace, presentationId, collaboratorId }) =>
      write(workspace, async (c) =>
        jsonText(
          await callApi(
            c,
            `/api/v1/presentations/${encodeURIComponent(presentationId)}/collaborators/${encodeURIComponent(collaboratorId)}`,
            { method: 'DELETE' }
          )
        )
      )
  );

  // ── Annotations ────────────────────────────────────────────────────────────

  server.registerTool(
    'slideless_list_annotations',
    {
      description:
        "Reviewer annotations: with presentationId, one deck's notes; without it, the " +
        'workspace-wide inbox of every deck this credential can read. Filter by version and/or ' +
        "status ('open' | 'resolved'). Returns { annotations: [...], nextCursor }.",
      inputSchema: {
        workspace: workspaceInput,
        presentationId: z.uuid().optional().describe('One deck; omitted = the cross-deck inbox.'),
        version: z.number().int().min(1).optional().describe('Only notes anchored to this deck version.'),
        status: z.enum(['open', 'resolved']).optional().describe('Only notes with this status.'),
        cursor: cursorInput,
        limit: limitInput
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace, presentationId, version, status, cursor, limit }) =>
      read(workspace, async (c) => {
        const base = presentationId
          ? `/api/v1/presentations/${encodeURIComponent(presentationId)}/annotations`
          : '/api/v1/annotations';
        const query = new URLSearchParams();
        if (cursor) query.set('cursor', cursor);
        if (limit !== undefined) query.set('limit', String(limit));
        if (version !== undefined) query.set('version', String(version));
        if (status) query.set('status', status);
        const qs = query.toString();
        return jsonText(await callApi(c, qs ? `${base}?${qs}` : base));
      })
  );
}

/** currentVersion of a deck (for the "omitted = latest" version params). */
async function currentVersionOf(c: McpToolContext, presentationId: string): Promise<number> {
  const deck = (await callApi(
    c,
    `/api/v1/presentations/${encodeURIComponent(presentationId)}`
  )) as PresentationWire;
  if (deck.currentVersion < 1) {
    throw new ApiToolError(400, 'invalid_version', 'This deck has no committed versions yet');
  }
  return deck.currentVersion;
}
