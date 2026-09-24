// The billing campaign: cloud Slideless on the pair, as a person and as a
// viewer. The person signs in with Antasphere through the hub owner's
// session (the drill's headless SSO dance), works in a workspace with a key,
// uploads assets, mints share links, invites collaborators, pushes a deck
// with the CLI; the viewer answers a form through a share link.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.mjs';
import { CampaignError, CookieJar, expectStatus, idempotency, multipart, request, waitFor } from './http.mjs';

const exec = promisify(execFile);

export class Slideless {
  constructor({ hub, log = () => {} }) {
    this.cfg = config;
    this.target = config.sl;
    this.hub = hub;
    this.log = log;
    this.jar = new CookieJar();
    this.user = null;
  }

  async as(ws, method, path, body, extra = {}) {
    return request(this.target, {
      method,
      path: `/api/v1${path}`,
      jar: this.jar,
      headers: { origin: this.cfg.sl.base, ...(ws ? { 'x-workspace-id': ws } : {}), ...(method !== 'GET' ? idempotency() : {}), ...extra },
      body
    });
  }
  async must(ws, method, path, body, statuses = 200, what = `${method} ${path}`) {
    return expectStatus(await this.as(ws, method, path, body), statuses, what).json;
  }
  /** A request with an slk_ key (the CLI's credential) on one workspace. */
  withKey(key, ws, method, path, body, extra = {}) {
    return request(this.target, {
      method,
      path: `/api/v1${path}`,
      headers: { authorization: `Bearer ${key}`, ...(ws ? { 'x-workspace-id': ws } : {}), ...(method !== 'GET' ? idempotency() : {}), ...extra },
      body
    });
  }

  /**
   * "Sign in with Antasphere", headless: Slideless answers the authorize URL,
   * the hub owner's session (a registry client skips the consent screen)
   * redirects to Slideless's callback with a code, the callback sets the
   * session. The person is the hub owner (Drill Owner).
   */
  async signInWithHub() {
    this.jar.clear();
    const initiate = await this.must(null, 'POST', '/auth/sign-in/oauth2', { providerId: 'antasphere', callbackURL: '/' }, 200, 'sign-in/oauth2');
    const authz = new URL(initiate.url);
    // A browser gets a 302; a caller accepting JSON gets 200 `{ redirect: true, url }`. Both are read.
    const hop = await request(this.hub.target, { path: `${authz.pathname}${authz.search}`, jar: this.hub.jar, headers: { origin: this.cfg.hub.base, accept: 'text/html' } });
    const location = hop.headers.location ?? (hop.json?.redirect ? hop.json.url : '') ?? '';
    if (!location.startsWith(`${this.cfg.sl.base}/api/v1/auth/oauth2/callback/antasphere?`) || !location.includes('code=')) {
      throw new CampaignError('the hub did not redirect to the Slideless callback with a code', { status: hop.status, location: location.replace(/code=[^&]*/, 'code=…'), body: hop.text.slice(0, 300).replace(/code=[^&"]*/g, 'code=…') });
    }
    const cb = new URL(location);
    const done = await request(this.target, { path: `${cb.pathname}${cb.search}`, jar: this.jar });
    expectStatus(done, 302, 'the Slideless callback');
    const me = await this.must(null, 'GET', '/me');
    this.user = { id: me.user.id, email: me.user.email, workspaces: me.workspaces, canCreateWorkspace: me.canCreateWorkspace };
    return this.user;
  }
  async me() {
    return this.must(null, 'GET', '/me');
  }
  /** The local workspace projecting a hub organization (`central_account_id` = the org id), or null. */
  async workspaceOf(org) {
    const id = await this.hub.slSql(`SELECT id FROM workspaces WHERE central_account_id = '${org}'`);
    return id || null;
  }
  /** A new workspace, created AT THE HUB as the person (PRDCT-2443); answers `{ workspaceId, org }`. */
  async createWorkspace(name) {
    const created = await this.must(null, 'POST', '/workspaces', { name }, 201, `POST /workspaces ${name}`);
    const workspaceId = created.workspace.id;
    const org = await this.hub.slSql(`SELECT central_account_id FROM workspaces WHERE id = '${workspaceId}'`);
    return { workspaceId, org };
  }
  async createKey(ws, name = 'campaign key') {
    const key = await this.must(ws, 'POST', '/api-keys', { name, scopes: ['presentations:read', 'presentations:write'] }, 201, 'POST /api-keys');
    return key.key;
  }

  /** Upload one asset (text) with the session or a key; answers the response (201 with sizeBytes, 402/403/413 refusals). */
  async uploadAsset(ws, content, { key, label = 'asset' } = {}) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha = createHash('sha256').update(data).digest('hex');
    const { body, contentType } = multipart({ sha256: sha }, [{ name: 'file', filename: `${label}.txt`, contentType: 'text/plain', data }]);
    const headers = { 'content-type': contentType, 'content-length': body.length };
    if (key) return this.withKey(key, ws, 'POST', '/presentations/assets', body, headers);
    return this.as(ws, 'POST', '/presentations/assets', body, headers);
  }
  async presentations(ws) {
    return (await this.must(ws, 'GET', '/presentations')).presentations;
  }
  /** Mint a share link on a deck; `password` makes it the pro feature's act. Answers the response. */
  mintLink(ws, deckId, { name = 'campaign link', password, key } = {}) {
    const body = { name, ...(password ? { password } : {}) };
    if (key) return this.withKey(key, ws, 'POST', `/presentations/${deckId}/tokens`, body);
    return this.as(ws, 'POST', `/presentations/${deckId}/tokens`, body);
  }
  async links(ws, deckId) {
    return (await this.must(ws, 'GET', `/presentations/${deckId}/tokens?limit=100`)).shareTokens;
  }
  inviteCollaborator(ws, deckId, email) {
    return this.as(ws, 'POST', `/presentations/${deckId}/collaborators`, { email });
  }
  /** The plan refusal's shape, judged the way the drill judges it. */
  static isPlanRefusal(res, key) {
    const d = res.json?.error?.details ?? {};
    return res.status === 403 && res.json?.error?.code === 'plan_required' && d.key === key && d.plan === 'free' && d.requiredPlan === 'pro' && typeof d.upgradeUrl === 'string';
  }

  /**
   * Push a deck folder with the CLI (the product's own way in): the built
   * binary in this worktree, the key and the workspace. Answers the CLI's
   * JSON (the presentation and the version).
   */
  async push(folder, { key, ws, title, extra = [] }) {
    const bin = `${this.cfg.repo}/packages/cli/dist/bin.js`;
    const { stdout } = await exec(
      process.execPath,
      [bin, '--workspace', ws, 'push', folder, '--title', title, '--no-open', '--new', '--json', ...extra],
      { env: { ...process.env, SLIDELESS_URL: `http://127.0.0.1:${this.cfg.sl.port}`, SLIDELESS_API_KEY: key }, maxBuffer: 16 * 1024 * 1024 }
    );
    return JSON.parse(stdout);
  }

  /** A viewer's form response through a share link: cookie-less, the secret is the credential. Answers the response. */
  formResponse(secret, form, payload) {
    return request(this.target, {
      method: 'POST',
      path: `/api/v1/viewer/${secret}/forms/${form}/responses`,
      headers: { origin: this.cfg.sl.base, 'content-type': 'application/json' },
      body: { payload }
    });
  }
  /** The usage queue's pending count on Slideless (the poster drains it to the hub). */
  async usagePending() {
    return Number(await this.hub.slSql(`SELECT count(*) FROM pgboss.job WHERE name = 'usage-events' AND state NOT IN ('completed','failed','cancelled')`));
  }
  async waitUsageDrained(timeoutMs = 90_000) {
    const ok = await waitFor(async () => ((await this.usagePending()) === 0 ? true : null), { every: 1000, timeoutMs });
    if (!ok) throw new CampaignError('the usage queue did not drain to the hub', { pending: await this.usagePending() });
  }
  async metrics() {
    const res = await request(this.target, { path: '/metrics', headers: { authorization: `Bearer ${this.cfg.metricsToken}` } });
    return res.text;
  }
}
