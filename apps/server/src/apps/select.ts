import type { AppEntry } from '@slideless/contract';

/**
 * The Apps page's selection rules, pure so the unit tests hold them without a
 * hub or a file (`test/unit/apps.test.ts`): which URL may be served, what an
 * operator's file may list, and which of the person's hub tools the
 * workspace's organization lets them open. `./service.ts` does the reading.
 */

/** The name the hub's card carries. */
export const HUB_APP_NAME = 'Antasphere Account';

/** The slugs a file entry names the account with: that entry is the hub's card, not a tool's. */
const HUB_SLUGS = new Set(['hub', 'account']);

/** A registry slug, as the hub spells one (lowercase letters, digits, dashes). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * An http(s) URL with no credentials in it, normalised; null for anything
 * else (a `javascript:` or `data:` URL, a relative path, a blank, a non-string).
 * Every URL the route serves passes here first.
 */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

const text = (raw: unknown, max: number): string | null =>
  typeof raw === 'string' && raw.trim() !== '' && raw.length <= max ? raw.trim() : null;

/** What an operator's file yields: the tools, the hub's card when an entry names it, the entries left out. */
export interface FileApps {
  apps: AppEntry[];
  hub: { url: string; name: string } | null;
  /** The entries left out, each with why (the log says them). */
  rejected: { index: number; reason: string }[];
}

/**
 * The operator's list (`APPS_FILE`): `[{ slug, name, launchUrl, description? }]`.
 * An entry without a slug, a name or an http(s) `launchUrl` is left out, and
 * so is a second entry of the same slug; an entry whose slug is `hub` or
 * `account` is the account's card. `current` marks this tool's own slug.
 */
export function appsFromFile(raw: unknown, selfSlug: string): FileApps {
  const out: FileApps = { apps: [], hub: null, rejected: [] };
  if (!Array.isArray(raw)) {
    out.rejected.push({ index: -1, reason: 'the file is not a JSON array' });
    return out;
  }
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const slug = typeof entry.slug === 'string' && SLUG.test(entry.slug) ? entry.slug : null;
    const name = text(entry.name, 120);
    const launchUrl = safeHttpUrl(entry.launchUrl);
    if (!slug) return out.rejected.push({ index, reason: 'no valid slug' });
    if (!name) return out.rejected.push({ index, reason: 'no name' });
    if (!launchUrl) return out.rejected.push({ index, reason: 'launchUrl is not an http(s) URL' });
    if (seen.has(slug)) return out.rejected.push({ index, reason: `slug ${slug} listed twice` });
    seen.add(slug);
    if (HUB_SLUGS.has(slug)) {
      out.hub = { url: launchUrl, name };
      return;
    }
    out.apps.push({
      slug,
      name,
      launchUrl,
      description: text(entry.description, 300),
      connected: false,
      firstUsedAt: null,
      lastUsedAt: null,
      current: slug === selfSlug
    });
  });
  return out;
}

/** One tool of the hub's `GET /me` (`tools[]`): a tool the person has signed in to. */
export interface HubMeTool {
  slug: string;
  name: string;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
}

/** The part of the hub's `GET /me/tool-access?tool=` the page reads: where the tool opens, and the organizations that let the person use it. */
export interface HubToolAccess {
  launchUrl: string;
  granted: string[];
}

/** `GET /me`'s `tools`, or null when the body does not carry the list (an entry without a slug is dropped). */
export function parseMeTools(body: unknown): HubMeTool[] | null {
  const raw = (body as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(raw)) return null;
  const tools: HubMeTool[] = [];
  for (const item of raw) {
    const tool = (item ?? {}) as Record<string, unknown>;
    if (typeof tool.slug !== 'string' || !SLUG.test(tool.slug)) continue;
    tools.push({
      slug: tool.slug,
      name: text(tool.name, 120) ?? tool.slug,
      firstUsedAt: typeof tool.firstUsedAt === 'string' ? tool.firstUsedAt : null,
      lastUsedAt: typeof tool.lastUsedAt === 'string' ? tool.lastUsedAt : null
    });
  }
  return tools;
}

/** `GET /me/tool-access`'s launch URL and granted organization ids, or null when the body is not that answer. */
export function parseToolAccess(body: unknown): HubToolAccess | null {
  const b = (body ?? {}) as { tool?: { launchUrl?: unknown }; granted?: unknown };
  if (typeof b.tool?.launchUrl !== 'string' || !Array.isArray(b.granted)) return null;
  const granted = b.granted
    .map((org) => (org as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
  return { launchUrl: b.tool.launchUrl, granted };
}

/**
 * The person's hub tools this workspace's organization lets them open: a
 * tool is kept when its access answer names `hubOrgId` among the granted
 * organizations and its launch URL is http(s). `current` marks this tool's own
 * slug; the hub's order (oldest first) is kept.
 */
export function selectHubApps(
  tools: HubMeTool[],
  access: ReadonlyMap<string, HubToolAccess | null>,
  hubOrgId: string,
  selfSlug: string
): AppEntry[] {
  const apps: AppEntry[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.slug)) continue;
    const answer = access.get(tool.slug);
    if (!answer || !answer.granted.includes(hubOrgId)) continue;
    const launchUrl = safeHttpUrl(answer.launchUrl);
    if (!launchUrl) continue;
    seen.add(tool.slug);
    apps.push({
      slug: tool.slug,
      name: tool.name,
      launchUrl,
      description: null,
      connected: true,
      firstUsedAt: tool.firstUsedAt,
      lastUsedAt: tool.lastUsedAt,
      current: tool.slug === selfSlug
    });
  }
  return apps;
}
