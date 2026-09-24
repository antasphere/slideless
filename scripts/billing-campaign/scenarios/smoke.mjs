// The billing campaign (PRDCT-2718): smoke, the library proved on the pair
// before any scenario group runs. Not in the orchestrator's GROUPS: run it
// with `--groups smoke`. Five facts: the owner's session and the tool's
// machine token, the SSO sign-in at Slideless, one webhook end to end on a
// purchase made through the Stripe API, the retry sweep queued by hand, and
// a headless setup-mode Checkout.
import { CampaignError, expectStatus, waitFor } from '../lib/http.mjs';
import { CARDS } from '../lib/checkout.mjs';

export const group = 'smoke';

let org = null;
let accountId = null;
let customerId = null;

export const scenarios = [
  {
    name: 'the owner is signed in at the hub and the tool holds a machine token',
    path: 'hub routes',
    async run(ctx) {
      if (!ctx.hub.user?.id) throw new CampaignError('the hub client has no signed-in user', {});
      const token = await ctx.hub.machine();
      if (typeof token !== 'string' || token.length < 20) throw new CampaignError('the machine token is not a token', { length: token?.length });
      const check = await ctx.hub.usageCheck(ctx.drillOrg, 'files.upload', 1_048_576);
      if (typeof check.allowed !== 'boolean' || check.credits !== 5) {
        throw new CampaignError('the usage check did not price one MiB at 5 credits', { check });
      }
      const settings = await ctx.hub.settings();
      if (!settings.settings?.packs) throw new CampaignError('the staff settings read carries no packs', { settings });
      return { userId: ctx.hub.user.id, drillOrg: ctx.drillOrg, tokenLength: token.length, check, packs: settings.settings.packs };
    }
  },
  {
    name: 'the same person is signed in at Slideless through the hub, in the Drill Workspace',
    path: 'Slideless + hub',
    async run(ctx) {
      if (!ctx.sl.user?.id) throw new CampaignError('the Slideless client has no signed-in user', {});
      const ws = await ctx.sl.workspaceOf(ctx.drillOrg);
      if (!ws) throw new CampaignError('no local workspace projects the Drill Workspace', { drillOrg: ctx.drillOrg });
      const me = await ctx.sl.me();
      const listed = (me.workspaces ?? []).find((w) => w.id === ws);
      if (!listed) throw new CampaignError('GET /me does not list the projected workspace', { ws, workspaces: me.workspaces?.map((w) => w.id) });
      const decks = await ctx.sl.presentations(ws);
      return { slUserId: ctx.sl.user.id, email: ctx.sl.user.email, workspaceId: ws, hubOrigin: listed.hubOrigin ?? null, role: listed.role ?? null, decks: decks.length };
    }
  },
  {
    name: 'a purchase paid through the Stripe API lands once on the ledger through the webhook door',
    path: 'Stripe API (test payment method)',
    async run(ctx) {
      org = await ctx.hub.createOrg('Campaign smoke webhook');
      accountId = await ctx.hub.accountIdOf(org);
      if (!accountId) throw new CampaignError('the new organization has no billing account', { org });
      await ctx.hub.patchAccount(org, { billingEmail: 'campaign-smoke@drill.test' });
      // Lane A is not merged: the hub makes no Stripe customer on the PATCH,
      // so the smoke makes one itself and writes it on the account row.
      customerId = await ctx.hub.customerOf(org);
      let customerPath = 'the hub made it on the PATCH';
      if (!customerId) {
        const customer = await ctx.stripe.post('/v1/customers', {
          email: 'campaign-smoke@drill.test',
          name: 'Campaign smoke webhook',
          metadata: { accountId, workspaceId: org, lane: ctx.config.lane }
        });
        customerId = customer.id;
        await ctx.hub.sql(`UPDATE billing_accounts SET stripe_customer_id = '${customerId}' WHERE id = '${accountId}'`);
        customerPath = 'made by the campaign and written on the row';
      } else {
        await ctx.stripe.tagCustomer(customerId);
      }
      const before = await ctx.hub.account(org);
      const t0 = Date.now();
      const intent = await ctx.stripe.purchaseIntent({
        customerId,
        amountMinor: 2000,
        currency: 'EUR',
        metadata: { kind: 'purchase', accountId, workspaceId: org, userId: ctx.hub.user.id, credits: '20000', currency: 'EUR' }
      });
      if (intent.status !== 'succeeded') throw new CampaignError('the payment intent did not succeed at once', { id: intent.id, status: intent.status });
      const record = await ctx.relay.waitProcessed((r) => r.type === 'payment_intent.succeeded' && r.body.includes(intent.id) && r.receivedAt >= t0);
      if (!record) {
        throw new CampaignError('no processed payment_intent.succeeded for the intent reached the relay in 90 s', {
          intentId: intent.id,
          seen: ctx.relay.ofObject(intent.id).map((r) => ({ type: r.type, outcome: r.outcome, status: r.status }))
        });
      }
      const entry = await ctx.hub.waitLedger(org, { kind: 'purchase', sourceRef: intent.id });
      if (!entry) throw new CampaignError('no purchase entry for the intent on the ledger', { intentId: intent.id, ledger: await ctx.hub.ledger(org) });
      if (entry.amount !== 20000) throw new CampaignError('the purchase amount is not the metadata credits', { entry });
      const entries = await ctx.hub.entriesOf(org, intent.id);
      if (entries.length !== 1) throw new CampaignError('more than one entry for the intent', { entries });
      const rows = await ctx.hub.eventRows(intent.id);
      if (!rows.length || rows.some((r) => !r.processed)) throw new CampaignError('the stripe_events rows of the intent are not all processed', { rows });
      const agrees = await ctx.hub.balanceAgrees(org);
      if (!agrees.agrees || agrees.balance !== before.balance + 20000) throw new CampaignError('the balance does not read the grant plus the purchase', { before: before.balance, agrees });
      return { org, accountId, customerId, customerPath, intentId: intent.id, eventId: record.id, webhookMs: record.lastDeliveredAt - t0, entryId: entry.id, balance: agrees.balance, eventRows: rows };
    }
  },
  {
    name: 'the retry sweep queued by hand runs to completion',
    path: 'hub routes',
    async run(ctx) {
      const t0 = Date.now();
      const jobId = await ctx.hub.runSweep();
      const state = await ctx.hub.sql(`SELECT state || '|' || coalesce(output::text, '') FROM pgboss.job WHERE id = '${jobId}'`);
      return { jobId, state, sweepMs: Date.now() - t0 };
    }
  },
  {
    name: 'a headless setup-mode Checkout saves a card the account then shows',
    path: 'hosted Checkout (browser)',
    async run(ctx) {
      if (!org) throw new CampaignError('the smoke organization is missing: the webhook scenario did not run', {});
      const setup = await ctx.hub.paymentMethodSetup(org);
      if (!setup.url || !setup.sessionId) throw new CampaignError('the setup session carries no url', { setup });
      const paid = await ctx.payCheckout(setup.url, { mode: 'setup', card: CARDS.visa, label: 'smoke-setup' });
      const account = await waitFor(
        async () => {
          const a = await ctx.hub.account(org);
          return a.paymentMethod?.last4 === '4242' ? a : null;
        },
        { every: 1500, timeoutMs: 60_000 }
      );
      if (!account) throw new CampaignError('the account never showed the saved card', { sessionId: setup.sessionId, account: await ctx.hub.account(org), url: paid.url });
      const session = await ctx.stripe.checkoutSession(setup.sessionId);
      expectStatus({ status: session.status === 'complete' ? 200 : 0, json: session, text: '' }, 200, 'the setup session is complete');
      return { sessionId: setup.sessionId, returnedTo: paid.url, paymentMethod: account.paymentMethod, shots: paid.shots.length };
    }
  }
];
