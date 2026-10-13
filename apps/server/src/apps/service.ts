import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { workspaces, type Db } from '@antasphere/chassis-db';
import type { Principal } from '@antasphere/chassis-contract';
import type { AppsList } from '@slideless/contract';
import type { GrantAccess } from '@antasphere/chassis-server/identity';
import type { Logger } from '@antasphere/chassis-server/logger';
import {
  HUB_APP_NAME,
  appsFromFile,
  parseMeTools,
  parseToolAccess,
  safeHttpUrl,
  selectHubApps,
  type HubToolAccess
} from './select.js';

/**
 * The Apps page's list (`GET /apps`): the other tools of the person's
 * organization, and the account that signs them in.
 *
 * On the cloud edition the hub is asked AS THE PERSON, with their own grant
 * (the chassis's `HubGrantService`, the same stored grant and the same
 * cross-replica refresh lock the reconciler uses): `GET <hub>/api/v1/me`
 * lists the tools they have signed in to, and `GET
 * <hub>/api/v1/me/tool-access?tool=<slug>` says, per tool, where it opens and
 * which of their organizations let them use it. A tool is kept when the
 * workspace's hub organization (`workspaces.central_account_id`) is among
 * those. The answer is held five minutes per person and workspace. A grant
 * that is missing or dead, a hub that does not answer, or a workspace that
 * is no hub organization falls back to the operator's file, never to an
 * error: the page is a convenience, not an access decision (each tool still
 * asks the hub when it is opened).
 *
 * On a self-hosted instance the list is the operator's file (`APPS_FILE`),
 * read on every call; without one the page lists nothing.
 */

/** How long a person's hub answer is held. */
export const APPS_CACHE_TTL_MS = 5 * 60_000;
/** At most this many answers are held; the oldest goes first. */
const APPS_CACHE_MAX = 5_000;
/** Each hub read's budget: the page waits on it. */
const HUB_TIMEOUT_MS = 3_000;
/** At most this many tools are asked about (a person signed in to more is cut, and said). */
const MAX_HUB_TOOLS = 50;

/** The as-the-person token source: what the page needs of the chassis's `HubGrantService`. */
export interface HubTokens {
  accessToken(userId: string): Promise<GrantAccess>;
  refresh(userId: string): Promise<GrantAccess>;
  invalidateAccess(userId: string): void;
}

export interface AppsServiceOptions {
  db: Db;
  logger: Logger;
  edition: 'oss' | 'cloud';
  /** HUB_ISSUER_URL (cloud). */
  hubIssuerUrl?: string | undefined;
  /** APPS_FILE. */
  appsFile?: string | undefined;
  /** This tool's own slug (`IDENTITY.slug`): its card says "You are here". */
  selfSlug: string;
  /** The person's hub grant (cloud); null on a self-hosted instance. */
  tokens: HubTokens | null;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type HubRead = { kind: 'ok'; status: number; body: unknown } | { kind: 'fail' };

export class AppsService {
  private readonly cache = new Map<string, { at: number; value: AppsList }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly hubBase: string | null;

  constructor(private readonly opts: AppsServiceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.hubBase =
      opts.edition === 'cloud' && opts.hubIssuerUrl ? opts.hubIssuerUrl.replace(/\/+$/, '') : null;
  }

  /** The list for one person in one workspace. */
  async list(principal: Pick<Principal, 'userId' | 'workspaceId'>): Promise<AppsList> {
    const key = `${principal.userId}:${principal.workspaceId}`;
    const held = this.cache.get(key);
    if (held && this.now() - held.at < APPS_CACHE_TTL_MS) return held.value;

    const fromHub = await this.fromHub(principal);
    if (!fromHub) return this.fromFile();
    // Only a whole answer is held: one with a tool the hub left unanswered is asked again next time.
    if (fromHub.complete) {
      this.cache.delete(key);
      this.cache.set(key, { at: this.now(), value: fromHub.value });
      if (this.cache.size > APPS_CACHE_MAX) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    return fromHub.value;
  }

  /** The hub's card: the issuer on the cloud edition. */
  private cloudHub(): AppsList['hub'] {
    const url = this.hubBase ? safeHttpUrl(this.hubBase) : null;
    return url ? { url, name: HUB_APP_NAME } : null;
  }

  /** The operator's file; `none` without one, or when it cannot be read. */
  async fromFile(): Promise<AppsList> {
    const path = this.opts.appsFile;
    if (!path) return { apps: [], hub: this.cloudHub(), source: 'none' };
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      this.opts.logger.warn(
        { err, path },
        'APPS_FILE could not be read as JSON — the Apps page lists nothing'
      );
      return { apps: [], hub: this.cloudHub(), source: 'none' };
    }
    const file = appsFromFile(raw, this.opts.selfSlug);
    if (file.rejected.length > 0) {
      this.opts.logger.warn({ path, rejected: file.rejected }, 'APPS_FILE entries left out of the Apps page');
    }
    return { apps: file.apps, hub: file.hub ?? this.cloudHub(), source: 'file' };
  }

  /**
   * The hub's answer, or null when the hub cannot be asked for this person
   * (no grant, a dead one, a workspace that is no hub organization, a hub
   * that does not answer): the file is read instead.
   */
  private async fromHub(
    principal: Pick<Principal, 'userId' | 'workspaceId'>
  ): Promise<{ value: AppsList; complete: boolean } | null> {
    const tokens = this.opts.tokens;
    if (!this.hubBase || !tokens) return null;
    const [row] = await this.opts.db
      .select({ hubOrgId: workspaces.centralAccountId })
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId))
      .limit(1);
    const hubOrgId = row?.hubOrgId ?? null;
    if (!hubOrgId) return null;

    const access = await tokens.accessToken(principal.userId);
    if (access.kind !== 'ok') return null;
    let token = access.accessToken;
    let retried = false;

    // One forced refresh and one retry for the whole list, on the first 401/403 (the stored token
    // may be stale): the chassis's own posture (hub-user-client.ts).
    const read = async (path: string): Promise<HubRead> => {
      let res = await this.get(token, path);
      if (res.kind === 'ok' && (res.status === 401 || res.status === 403) && !retried) {
        retried = true;
        tokens.invalidateAccess(principal.userId);
        const refreshed = await tokens.refresh(principal.userId);
        if (refreshed.kind !== 'ok') return { kind: 'fail' };
        token = refreshed.accessToken;
        res = await this.get(token, path);
      }
      return res;
    };

    const me = await read('/api/v1/me');
    if (me.kind !== 'ok' || me.status !== 200) return null;
    const tools = parseMeTools(me.body);
    if (!tools) {
      this.opts.logger.warn('hub /me carried no tools list — the Apps page reads the file');
      return null;
    }
    if (tools.length > MAX_HUB_TOOLS) {
      this.opts.logger.warn(
        { tools: tools.length },
        'hub /me listed more tools than the Apps page asks about'
      );
    }

    const asked = tools.slice(0, MAX_HUB_TOOLS);
    const answers = new Map<string, HubToolAccess | null>();
    let complete = true;
    await Promise.all(
      asked.map(async (tool) => {
        const res = await read(`/api/v1/me/tool-access?tool=${encodeURIComponent(tool.slug)}`);
        // A tool the registry no longer knows (404) is simply not offered; any other doubt leaves
        // the tool out of this answer and keeps the answer out of the cache.
        if (res.kind === 'ok' && res.status === 404) return answers.set(tool.slug, null);
        const parsed = res.kind === 'ok' && res.status === 200 ? parseToolAccess(res.body) : null;
        if (!parsed) complete = false;
        answers.set(tool.slug, parsed);
      })
    );
    const value: AppsList = {
      apps: selectHubApps(asked, answers, hubOrgId, this.opts.selfSlug),
      hub: this.cloudHub(),
      source: 'hub'
    };
    if (!complete) {
      this.opts.logger.warn('hub /me/tool-access left some tools unanswered — the Apps page shows the rest');
    }
    return { value, complete };
  }

  private async get(token: string, path: string): Promise<HubRead> {
    try {
      const response = await this.fetchImpl(`${this.hubBase}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS)
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { kind: 'ok', status: response.status, body };
    } catch (err) {
      this.opts.logger.warn({ err, path }, 'hub read for the Apps page failed');
      return { kind: 'fail' };
    }
  }
}
