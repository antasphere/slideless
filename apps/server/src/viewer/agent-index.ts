import type { Context } from 'hono';
import { attachmentsOf, isAttachmentPath, type ManifestEntry } from '@slideless/contract';

/**
 * THE AGENT INDEX OF A SHARE LINK (PRDCT-2670).
 *
 * The same share URL `/v/{secret}/` serves two readers. A person's browser
 * asks for HTML and gets the deck, exactly as before. An agent (curl, an SDK,
 * an LLM tool fetching a URL it was handed) asks for anything else and gets a
 * small self-describing index of the link instead: what the deck is, what the
 * link allows, the entry document, every file with its absolute URL, the
 * deck's AGENT.md briefing inlined, and how to fetch more.
 *
 * TRUST: the index states nothing the link does not already hand out. Every
 * URL it lists is one the same secret already opens (the asset route, the
 * attachment routes); the downloads section appears ONLY when the link's
 * `can_download` is on, so a link with downloads off never learns the names
 * of the attachments. It never names the owner, the workspace, other links
 * or other versions. The route counts a read as an AGENT read
 * (`share_tokens.agent_read_count`), never as a view, and sets no cookie.
 */

/** How much of AGENT.md is inlined into the index. */
export const AGENT_DOC_INLINE_CAP = 64 * 1024;

/**
 * Which index, if any, this request asks for. `?raw` / `?format=html` are the
 * byte-exact deck (null). An explicit `?format=` wins over the Accept header;
 * without one, a request that accepts `text/html` is a browser (null), a
 * JSON-only Accept gets the JSON twin, and everything else (no header,
 * `*\/*`, `text/markdown`, `text/plain`) gets the markdown.
 */
export function agentIndexRequested(c: Context): 'md' | 'json' | null {
  if (c.req.query('raw') !== undefined) return null;
  const format = c.req.query('format');
  if (format === 'html') return null;
  if (format === 'agent' || format === 'md' || format === 'markdown') return 'md';
  if (format === 'json') return 'json';
  const accept = (c.req.header('accept') ?? '').toLowerCase();
  if (accept.includes('text/html')) return null;
  if (accept.includes('application/json') && !accept.includes('text/markdown')) return 'json';
  return 'md';
}

export interface AgentIndexInput {
  deck: { title: string; kind: string };
  version: { number: number; mode: 'latest' | 'pinned' };
  link: {
    canDownload: boolean;
    canAnnotate: boolean;
    canSubmitForms: boolean;
    canExportPdf: boolean;
    expiresAt: Date | null;
  };
  manifest: ReadonlyArray<ManifestEntry>;
  entryPath: string;
  /** AGENT.md's text (already capped by the caller), or null when the version has none. */
  agentDoc: string | null;
  /** True when the caller cut AGENT.md at the inline cap. */
  agentDocTruncated: boolean;
  /** Absolute URL of the link, with its trailing slash: `https://host/v/<secret>/`. */
  baseUrl: string;
}

export interface AgentIndexJson {
  deck: { title: string; kind: string };
  version: { number: number; mode: 'latest' | 'pinned' };
  link: {
    canDownload: boolean;
    canAnnotate: boolean;
    canSubmitForms: boolean;
    canExportPdf: boolean;
    expiresAt: string | null;
  };
  agentDoc: string | null;
  entry: { path: string; sizeBytes: number; contentType: string; url: string; rawUrl: string };
  files: Array<{ path: string; sizeBytes: number; contentType: string; url: string }>;
  downloads: Array<{ name: string; sizeBytes: number; contentType: string; url: string }> | null;
  zipUrl: string | null;
  index: { markdown: string; json: string };
}

/** A manifest path as a URL path: each segment percent-encoded. */
const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** `1.2 MB`-style human size (binary units). */
export function humanSize(bytes: number): string {
  const units = ['KB', 'MB', 'GB', 'TB'];
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Bytes plus the human form, e.g. `1258291 bytes (1.2 MB)`; small sizes stay `42 bytes`. */
export function sizeLabel(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${bytes} bytes (${humanSize(bytes)})`;
}

/** One line of markdown: no newline can break out of a heading or a table cell. */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();
const cell = (s: string): string => oneLine(s).replace(/\|/g, '\\|');

/**
 * Cuts a UTF-8 buffer at `cap` bytes without splitting a character.
 */
export function capUtf8(buf: Buffer, cap: number): { text: string; truncated: boolean } {
  if (buf.length <= cap) return { text: buf.toString('utf8'), truncated: false };
  let end = cap;
  // Back off continuation bytes (10xxxxxx) so the cut lands on a boundary.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

export function buildAgentIndex(input: AgentIndexInput): { markdown: string; json: AgentIndexJson } {
  const base = input.baseUrl.endsWith('/') ? input.baseUrl : `${input.baseUrl}/`;
  const urlOf = (path: string) => `${base}${encodePath(path)}`;
  const markdownUrl = `${base}?format=agent`;
  const jsonUrl = `${base}?format=json`;
  const rawUrl = `${base}?raw`;

  const entryRow = input.manifest.find((e) => e.path === input.entryPath);
  const entry = {
    path: input.entryPath,
    sizeBytes: entryRow?.sizeBytes ?? 0,
    contentType: entryRow?.contentType ?? 'text/html',
    url: base,
    rawUrl
  };

  const files = input.manifest
    .filter((e) => !isAttachmentPath(e.path))
    .map((e) => ({ path: e.path, sizeBytes: e.sizeBytes, contentType: e.contentType, url: urlOf(e.path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const attachments = attachmentsOf(input.manifest);
  const downloadsOn = input.link.canDownload && attachments.length > 0;
  const downloads = downloadsOn
    ? attachments.map((a) => ({
        name: a.name,
        sizeBytes: a.sizeBytes,
        contentType: a.contentType,
        url: urlOf(a.path)
      }))
    : null;
  const zipUrl = downloadsOn ? `${base}downloads.zip` : null;

  const expiresAt = input.link.expiresAt?.toISOString() ?? null;
  const yesNo = (b: boolean) => (b ? 'yes' : 'no');
  const versionPhrase =
    input.version.mode === 'latest'
      ? 'follows the latest version'
      : `pinned to version ${input.version.number}`;

  const lines: string[] = [];
  lines.push(`# ${oneLine(input.deck.title)}`, '');
  lines.push(
    `A Slideless deck shared through a link. Version ${input.version.number}, ${versionPhrase}. ` +
      `Kind: ${input.deck.kind}. This is the machine-readable index of the link; a person opening the ` +
      'same URL in a browser gets the deck.',
    ''
  );

  lines.push('## What this link allows', '');
  lines.push(`- Downloads: ${yesNo(input.link.canDownload)}`);
  lines.push(`- Annotations (notes on the deck): ${yesNo(input.link.canAnnotate)}`);
  lines.push(`- Form submissions: ${yesNo(input.link.canSubmitForms)}`);
  lines.push(
    `- PDF export: ${input.link.canExportPdf ? 'yes (an Export PDF action in the viewer prints it from a browser)' : 'no'}`
  );
  lines.push(`- Expires: ${expiresAt ?? 'never'}`, '');

  lines.push('## The presentation', '');
  lines.push(
    `- Entry document: ${entry.path} (${sizeLabel(entry.sizeBytes)}, ${entry.contentType}). ` +
      `Fetch it byte-exact at ${rawUrl}`
  );
  lines.push(`- Every file of the deck is served at ${base}<path>`, '');

  lines.push('## Briefing for agents (AGENT.md)', '');
  if (input.agentDoc !== null) {
    lines.push(input.agentDoc.replace(/\s+$/, ''), '');
    if (input.agentDocTruncated) lines.push(`Truncated; the whole file is at ${urlOf('AGENT.md')}`, '');
  } else {
    lines.push('This deck carries no AGENT.md.', '');
  }

  lines.push(`## Files (${files.length})`, '');
  lines.push('| Path | Size | Type | URL |', '| --- | --- | --- | --- |');
  for (const f of files) {
    lines.push(`| ${cell(f.path)} | ${sizeLabel(f.sizeBytes)} | ${cell(f.contentType)} | ${f.url} |`);
  }
  lines.push('');

  if (downloads) {
    lines.push(`## Downloads (${downloads.length})`, '');
    lines.push('| File | Size | Type | URL |', '| --- | --- | --- | --- |');
    for (const d of downloads) {
      lines.push(`| ${cell(d.name)} | ${sizeLabel(d.sizeBytes)} | ${cell(d.contentType)} | ${d.url} |`);
    }
    lines.push('', `All files as one zip: ${zipUrl}`, '');
  }

  lines.push('## Fetching', '');
  lines.push(`- Markdown index: ${markdownUrl}`);
  lines.push(`- JSON index: ${jsonUrl}`);
  lines.push(
    '- A password-protected link answers 401 with password_required; send the password in the x-viewer-password header.'
  );

  const markdown = `${lines.join('\n')}\n`;
  const json: AgentIndexJson = {
    deck: { title: input.deck.title, kind: input.deck.kind },
    version: { number: input.version.number, mode: input.version.mode },
    link: {
      canDownload: input.link.canDownload,
      canAnnotate: input.link.canAnnotate,
      canSubmitForms: input.link.canSubmitForms,
      canExportPdf: input.link.canExportPdf,
      expiresAt
    },
    agentDoc: input.agentDoc,
    entry,
    files,
    downloads,
    zipUrl,
    index: { markdown: markdownUrl, json: jsonUrl }
  };
  return { markdown, json };
}
