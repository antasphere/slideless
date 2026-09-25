// The billing campaign: the pair's HUB as the scenarios drive it. Drill Owner's
// browser session (the password set again through the hub's reset mail in
// Mailpit, the way every pair seed does it), the organizations, the owner's
// billing routes, the staff routes (Drill Owner is staff on the pair), the
// tool's machine token and the usage ingest, the hub's database through
// `docker compose exec`, and the two things a scenario does to the hub
// itself: run the retry sweep by hand and restart the container.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.mjs';
import {
  CampaignError,
  CookieJar,
  expectStatus,
  idempotency,
  request,
  sleep,
  ulid,
  waitFor
} from './http.mjs';

/**
 * An id the pair or Stripe minted, checked before it is written into an SQL
 * literal. UUIDs, ULIDs, Stripe ids and the hub's ids use only these
 * characters; anything else is refused with the id in the evidence. The ONE
 * guard: every scenario that builds SQL imports it from here.
 */
export function sqlId(value, what = 'an id') {
  const s = String(value ?? '');
  if (!/^[A-Za-z0-9_.:-]+$/.test(s))
    throw new CampaignError(`${what} is not an id this campaign will put into SQL`, {
      value: s.slice(0, 80)
    });
  return s;
}

/** A Postgres timestamp as psql prints it (`2026-09-25 01:07:11.123456+00`) to epoch milliseconds; NaN when empty. */
export function pgTime(text) {
  if (!text) return NaN;
  let iso = text.trim().replace(' ', 'T');
  iso = iso.replace(/(\.\d{3})\d+/, '$1');
  iso = iso.replace(/([+-]\d\d)$/, '$1:00');
  return Date.parse(iso);
}

const exec = promisify(execFile);

export class Hub {
  constructor({ mail, log = () => {} }) {
    this.cfg = config;
    this.target = config.hub;
    this.mail = mail;
    this.log = log;
    this.jar = new CookieJar();
    this.user = null; // { id, email }
    this.password = null;
    this.machineToken = null;
    this.machineTokenAt = 0;
  }

  // ── plain requests ────────────────────────────────────────────────────────
  /** A request as the signed-in owner on one organization (`org` = the hub workspace id). */
  async as(org, method, path, body, extra = {}) {
    return request(this.target, {
      method,
      path: `/api/v1${path}`,
      jar: this.jar,
      headers: {
        origin: this.cfg.hub.base,
        ...(org ? { 'x-workspace-id': org } : {}),
        ...(method !== 'GET' ? idempotency() : {}),
        ...extra
      },
      body
    });
  }
  /** The same, refusing any status but `statuses`; answers the JSON body. */
  async must(org, method, path, body, statuses = 200, what = `${method} ${path}`) {
    const res = await this.as(org, method, path, body);
    return expectStatus(res, statuses, what).json;
  }
  /** A request with a bearer (an API key, an OAuth token, the machine token). */
  bearer(token, method, path, body, extra = {}) {
    return request(this.target, {
      method,
      path: `/api/v1${path}`,
      headers: { authorization: `Bearer ${token}`, ...extra },
      body
    });
  }

  // ── the owner's session ───────────────────────────────────────────────────
  async signIn(password) {
    const res = await request(this.target, {
      method: 'POST',
      path: '/api/v1/auth/sign-in/email',
      jar: this.jar,
      headers: { origin: this.cfg.hub.base },
      body: { email: this.cfg.owner.email, password }
    });
    return res.status;
  }
  /**
   * Drill Owner's session. The drill minted a random password and kept it
   * nowhere, so the campaign sets one through the hub's reset mail (read in
   * Mailpit) and keeps it in `$OUT/.owner-password`; a run whose reset the
   * wall refuses (five per address per ten minutes) signs in with the kept one.
   */
  async signInOwner(pwFile) {
    const { readFileSync, writeFileSync } = await import('node:fs');
    let kept = null;
    try {
      kept = readFileSync(pwFile, 'utf8').trim() || null;
    } catch {
      kept = null;
    }
    if (kept && (await this.signIn(kept)) === 200) {
      this.password = kept;
    } else {
      const fresh = `drill-owner-campaign-${randomBytes(6).toString('hex')}`;
      const before = Date.now() - 1000;
      const req = await request(this.target, {
        method: 'POST',
        path: '/api/v1/auth/request-password-reset',
        headers: { origin: this.cfg.hub.base },
        body: { email: this.cfg.owner.email, redirectTo: `${this.cfg.hub.base}/reset-password` }
      });
      if (req.status === 429 && kept) {
        this.password = kept;
      } else {
        expectStatus(req, 200, 'the hub password reset request');
        const mail = await this.mail.waitFor({ to: this.cfg.owner.email, after: before }, 60_000);
        if (!mail) throw new CampaignError('no reset mail for Drill Owner in Mailpit', {});
        const token = (mail.Text.match(/reset-password\/([A-Za-z0-9_-]+)/) ??
          mail.Text.match(/[?&]token=([A-Za-z0-9_-]+)/))?.[1];
        if (!token)
          throw new CampaignError('the reset mail carries no token', { text: mail.Text.slice(0, 400) });
        const reset = await request(this.target, {
          method: 'POST',
          path: '/api/v1/auth/reset-password',
          headers: { origin: this.cfg.hub.base },
          body: { newPassword: fresh, token }
        });
        expectStatus(reset, 200, 'the hub password reset');
        writeFileSync(pwFile, fresh, { mode: 0o600 });
        this.password = fresh;
      }
      const status = await this.signIn(this.password);
      if (status !== 200) throw new CampaignError(`the hub refused Drill Owner's sign-in (${status})`, {});
    }
    const me = await this.must(null, 'GET', '/me');
    this.user = { id: me.user.id, email: me.user.email };
    return this.user;
  }

  // ── organizations ─────────────────────────────────────────────────────────
  async orgs() {
    return (await this.must(null, 'GET', '/orgs')).orgs;
  }
  /** The Drill Workspace the federation drill made (the projected organization). */
  async drillOrg() {
    const org = (await this.orgs()).find((o) => o.name === 'Drill Workspace' && o.role === 'owner');
    if (!org)
      throw new CampaignError(
        'the hub lists no Drill Workspace owned by Drill Owner (has the drill run?)',
        {}
      );
    return org.id;
  }
  /** One more organization of the owner, with its own billing account; answers its id. */
  async createOrg(name) {
    const created = await this.must(null, 'POST', '/orgs', { name }, 201, `POST /orgs ${name}`);
    return created.org?.id ?? created.workspace?.id ?? created.id;
  }

  // ── the owner's billing surface ───────────────────────────────────────────
  account(org) {
    return this.must(org, 'GET', '/billing/account');
  }
  patchAccount(org, body) {
    return this.must(org, 'PATCH', '/billing/account', body);
  }
  async ledger(org, kind) {
    const all = [];
    let cursor = null;
    for (;;) {
      const page = await this.must(
        org,
        'GET',
        `/billing/ledger?limit=100${kind ? `&kind=${kind}` : ''}${cursor ? `&cursor=${cursor}` : ''}`
      );
      all.push(...page.entries);
      if (!page.nextCursor || all.length > 5000) return all;
      cursor = page.nextCursor;
    }
  }
  /** The ledger entries of one payment intent (its purchase and its refunds). */
  async entriesOf(org, sourceRef) {
    return (await this.ledger(org)).filter((e) => e.sourceRef === sourceRef);
  }
  /** Wait for a ledger entry of `kind` and `amount` (and `sourceRef` when given); the entry or null. */
  waitLedger(org, { kind, amount, sourceRef }, timeoutMs = 90_000) {
    return waitFor(
      async () =>
        (await this.ledger(org, kind)).find(
          (e) => (amount === undefined || e.amount === amount) && (!sourceRef || e.sourceRef === sourceRef)
        ) ?? null,
      { every: 1500, timeoutMs }
    );
  }
  /** Balance = the ledger's sum, checked from the ledger itself (the invariant every load scenario ends on). */
  async balanceAgrees(org) {
    const [account, entries] = await Promise.all([this.account(org), this.ledger(org)]);
    const sum = entries.reduce((s, e) => s + e.amount, 0);
    return { balance: account.balance, sum, agrees: account.balance === sum, entries: entries.length };
  }
  checkout(org, body) {
    return this.as(org, 'POST', '/billing/checkout', body);
  }
  invoices(org) {
    return this.must(org, 'GET', '/billing/invoices?limit=50');
  }
  referral(org, code) {
    return this.as(org, 'POST', '/billing/referral', { code });
  }
  paymentMethodSetup(org) {
    return this.must(org, 'POST', '/billing/payment-method', {});
  }
  paymentMethodRemove(org) {
    return this.as(org, 'DELETE', '/billing/payment-method');
  }
  subscription(org, action) {
    return this.as(org, 'POST', '/billing/subscription', { action });
  }
  autoRecharge(org, body) {
    return this.as(org, 'PATCH', '/billing/auto-recharge', body);
  }
  usage(org) {
    return this.must(org, 'GET', '/billing/usage');
  }

  // ── staff (Drill Owner is on SUPERADMIN_EMAILS in the drill overlay) ──────
  grant(accountId, credits, reason) {
    return this.must(
      null,
      'POST',
      `/admin/billing/accounts/${accountId}/grant`,
      { credits, reason },
      201,
      'staff grant'
    );
  }
  settings() {
    return this.must(null, 'GET', '/admin/billing/settings');
  }
  patchSettings(body) {
    return this.must(null, 'PATCH', '/admin/billing/settings', body);
  }
  prices() {
    return this.must(null, 'GET', `/admin/billing/prices?toolSlug=${this.cfg.toolClient.slug}`);
  }
  seedPrices() {
    return this.must(null, 'POST', '/admin/billing/prices/seed', { toolSlug: this.cfg.toolClient.slug });
  }
  invite(org, email) {
    return this.as(org, 'POST', '/invitations', { email, role: 'member' });
  }

  // ── the tool's machine channel ────────────────────────────────────────────
  /** The tool's client-credentials token (`usage:write`), cached a few minutes. */
  async machine() {
    if (this.machineToken && Date.now() - this.machineTokenAt < 5 * 60_000) return this.machineToken;
    // One mint at a time: twenty callers meeting an expired token would each
    // post to the hub's token wall, the one people's sign-ins share.
    if (!this.machineMint) {
      this.machineMint = this.mintMachine().finally(() => {
        this.machineMint = null;
      });
    }
    return this.machineMint;
  }
  async mintMachine() {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'usage:write',
      resource: `${this.cfg.hub.base}/mcp`
    });
    const res = await request(this.target, {
      method: 'POST',
      path: '/api/v1/auth/oauth2/token',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.cfg.toolClient.id}:${this.cfg.toolClient.secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    expectStatus(res, 200, 'the machine token mint');
    this.machineToken = res.json.access_token;
    this.machineTokenAt = Date.now();
    return this.machineToken;
  }
  /** One usage event as Slideless would post it: `files.upload` of `bytes`, or any action key with a quantity. */
  event(org, { actionKey = 'files.upload', quantity, unit = 'bytes', via = 'api_key', userId } = {}) {
    return {
      id: ulid(),
      actionKey,
      quantity,
      unit,
      workspaceId: org,
      accountRef: org,
      via,
      ...(userId ? { userId } : {}),
      occurredAt: new Date().toISOString(),
      source: { instanceId: `campaign-${this.cfg.lane}`, edition: 'cloud', version: '0' }
    };
  }
  /** A debit of `credits` on `files.upload` (5 credits per MiB) as one event. */
  debitEvent(org, credits, extra = {}) {
    return this.event(org, { quantity: (credits / 5) * 1_048_576, ...extra });
  }
  /** Post a batch of events with the machine token; answers the hub's body. */
  async postUsage(events) {
    const res = await this.bearer(await this.machine(), 'POST', '/usage/events', { events });
    return expectStatus(res, 200, 'POST /usage/events').json;
  }
  async usageCheck(org, actionKey, quantity) {
    const res = await this.bearer(await this.machine(), 'POST', '/usage/check', {
      accountRef: org,
      actionKey,
      quantity
    });
    return expectStatus(res, 200, 'POST /usage/check').json;
  }
  async entitlements(org) {
    const res = await this.bearer(await this.machine(), 'GET', `/usage/entitlements?accountRef=${org}`);
    return expectStatus(res, 200, 'GET /usage/entitlements').json;
  }

  // ── the hub itself ────────────────────────────────────────────────────────
  compose(args, opts = {}) {
    const env = {
      ...process.env,
      FEDERATION_DRILL_SETUP_TOKEN: process.env.FEDERATION_DRILL_SETUP_TOKEN ?? 'claimed-already'
    };
    if (this.cfg.compose.dockerConfig) env.DOCKER_CONFIG = this.cfg.compose.dockerConfig;
    const files = this.cfg.compose.files.flatMap((f) => ['-f', f]);
    return exec('docker', ['compose', '-p', this.cfg.project, ...files, ...args], {
      env,
      maxBuffer: 64 * 1024 * 1024,
      ...opts
    });
  }
  /** One SQL statement on the hub's database; the rows as `|`-separated lines (psql -Atc). */
  async sql(statement) {
    const { stdout } = await this.compose([
      'exec',
      '-T',
      'hub-db',
      'psql',
      '-U',
      'antasphere',
      '-d',
      'antasphere',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      statement
    ]);
    return stdout.trim();
  }
  /** The same on Slideless's database. */
  async slSql(statement) {
    const { stdout } = await this.compose([
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'slideless',
      '-d',
      'slideless',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atc',
      statement
    ]);
    return stdout.trim();
  }
  async accountIdOf(org) {
    return this.sql(`SELECT central_account_id FROM workspaces WHERE id = '${sqlId(org)}'`);
  }
  async customerOf(org) {
    return this.sql(
      `SELECT coalesce(stripe_customer_id, '') FROM billing_accounts WHERE id = (SELECT central_account_id FROM workspaces WHERE id = '${sqlId(org)}')`
    );
  }
  /** The runs of an account, oldest first: `{ id, state, credits, paymentIntentId, reason, retryAt, retryAtMs }` (`retryAtMs` epoch ms, NaN when unset). */
  async runs(org) {
    const out = await this.sql(
      `SELECT id || '|' || state || '|' || credits || '|' || coalesce(payment_intent_id,'') || '|' || coalesce(reason,'') || '|' || coalesce(retry_at::text,'') FROM auto_recharge_runs WHERE account_id = (SELECT central_account_id FROM workspaces WHERE id = '${sqlId(org)}') ORDER BY created_at`
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [id, state, credits, paymentIntentId, reason, retryAt] = l.split('|');
        return {
          id,
          state,
          credits: Number(credits),
          paymentIntentId,
          reason,
          retryAt,
          retryAtMs: pgTime(retryAt)
        };
      });
  }
  /** Bring a parked retry forward: its time to now (lane B's `retry-now`). */
  retryNow(org) {
    return this.sql(
      `UPDATE auto_recharge_runs SET retry_at = now() - interval '1 minute' WHERE state = 'retry' AND account_id = (SELECT central_account_id FROM workspaces WHERE id = '${sqlId(org)}') RETURNING id`
    );
  }
  /**
   * Run the retry sweep BY HAND (the ticket's "the retry job run by hand"): one
   * job queued on the hub's own pg-boss queue `billing-auto-recharge-retry`,
   * the very handler the fifteen-minute schedule runs (the retries due, then
   * the lapsed Pro plans), and wait until pg-boss completed it.
   */
  async runSweep(timeoutMs = 90_000) {
    const id = await this.sql(
      `INSERT INTO pgboss.job (name, data) VALUES ('billing-auto-recharge-retry', '{"campaign":true}') RETURNING id`
    );
    const done = await waitFor(
      async () => {
        const state = await this.sql(`SELECT state FROM pgboss.job WHERE id = '${sqlId(id)}'`);
        return state === 'completed' ? state : state === 'failed' ? 'failed' : null;
      },
      { every: 1000, timeoutMs }
    );
    if (done !== 'completed')
      throw new CampaignError(`the retry sweep job ${id} did not complete (${done ?? 'timeout'})`, {});
    return id;
  }
  /** The stripe_events rows of one object id (a payment intent, an invoice…): `{ eventId, type, processed }`. */
  async eventRows(objectId) {
    const out = await this.sql(
      `SELECT event_id || '|' || type || '|' || (processed_at IS NOT NULL)::int FROM stripe_events WHERE payload->'data'->'object'->>'id' = '${sqlId(objectId)}' ORDER BY received_at`
    );
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [eventId, type, processed] = l.split('|');
        return { eventId, type, processed: processed === '1' };
      });
  }
  /** Restart the hub container and wait until it answers again. */
  async restart() {
    await this.compose(['restart', 'hub']);
    const ok = await waitFor(
      async () => {
        try {
          const res = await request(this.target, { path: '/healthz', timeoutMs: 3000 });
          return res.status === 200 ? true : null;
        } catch {
          return null;
        }
      },
      { every: 1000, timeoutMs: 180_000 }
    );
    if (!ok) throw new CampaignError('the hub did not come back after the restart', {});
    await sleep(2000);
  }
}
