// The billing campaign (PRDCT-2718): plan, the Pro subscription from its Checkout through a renewal, a failed renewal, a cancellation and the downgrade, with the free limits following the plan on Slideless.
//
// Two organizations. `Campaign plan Slideless` is made through Slideless, so a
// local workspace projects it: it carries the deck, its links and the whole
// subscribe, renew, cancel, resume and downgrade path. `Campaign plan renewal`
// is made at the hub only: it carries the failed renewal.
//
// One fact about the pair shapes scenarios 7 and 8. Every Stripe customer sits
// on its own test clock, so Stripe's periods move when the campaign advances
// that clock. The hub judges "is the paid period over" against its own wall
// clock, which the campaign cannot advance. After the Stripe clock passes the
// paid end, the hub therefore still sees that end in its future and keeps Pro,
// which is the correct behaviour for real time. To prove the step after it (the
// sweep sends a lapsed plan to free), those two scenarios first judge that
// intermediate state, then move the hub row's paid end into the past by SQL,
// the same kind of move `hub.retryNow` makes on a parked retry, and say so in
// the evidence and in a report note.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CampaignError, expectStatus, sleep, waitFor } from '../lib/http.mjs';
import { CARDS } from '../lib/checkout.mjs';
import { Slideless } from '../lib/slideless.mjs';

export const group = 'plan';

const EMAIL_A = 'campaign-plan-a@drill.test';
const EMAIL_B = 'campaign-plan-b@drill.test';
const RENEWAL_ORG_NAME = 'Campaign plan renewal';
const LOCKED_PASSWORD = 'campaign-pass-1';
const DAY = 86_400;

/** The group's shared state; throws when an earlier scenario did not leave what a later one needs. */
function state(ctx, ...needed) {
  const s = ctx.shared.plan;
  if (!s) throw new CampaignError('the plan group state is missing: scenario 1 did not run', {});
  const missing = needed.filter((k) => s[k] === undefined || s[k] === null);
  if (missing.length)
    throw new CampaignError(
      `the plan group state lacks ${missing.join(', ')}: an earlier scenario did not complete`,
      { missing }
    );
  return s;
}

/** Two ISO instants (or null) name the same second. */
function sameInstant(a, b) {
  if (!a || !b) return false;
  return Math.floor(Date.parse(a) / 1000) === Math.floor(Date.parse(b) / 1000);
}

/** The account read reduced to what this group judges. */
function planView(a) {
  return {
    plan: a.plan,
    planUntil: a.planUntil ?? null,
    subscription: a.subscription ?? null,
    balance: a.balance
  };
}

/** Wait until `test(account)` holds; the account, or a CampaignError carrying the last read. */
async function waitAccount(ctx, org, test, what, timeoutMs = 90_000) {
  let last = null;
  const hit = await waitFor(
    async () => {
      last = await ctx.hub.account(org);
      return test(last) ? last : null;
    },
    { every: 1500, timeoutMs }
  );
  if (!hit)
    throw new CampaignError(`${what}: the account read never matched in ${Math.round(timeoutMs / 1000)} s`, {
      org,
      last: last ? planView(last) : null
    });
  return hit;
}

/** The hub's usage_events rows for one billing account. */
async function usageEventCount(ctx, accountId) {
  return Number(await ctx.hub.sql(`SELECT count(*) FROM usage_events WHERE account_id = '${accountId}'`));
}

/** Whether a Stripe subscription's price is the EUR Pro monthly price. */
function proPriceOf(sub) {
  const price = sub?.items?.data?.[0]?.price ?? null;
  return {
    priceId: price?.id ?? null,
    lookupKey: price?.lookup_key ?? null,
    unitAmount: price?.unit_amount ?? null,
    currency: price?.currency ?? null
  };
}

/** Whether a feature list (an array of keys, or a record of booleans) holds `key`. */
function hasFeature(features, key) {
  if (Array.isArray(features)) return features.includes(key);
  if (features && typeof features === 'object') return features[key] === true;
  return false;
}

/**
 * Move the hub row's paid end into the past, because the hub's wall clock
 * cannot follow the Stripe test clock. Only used after the scenario proved the
 * hub kept Pro exactly to a paid end that is still in the hub's future.
 */
async function bringPaidEndToNow(ctx, accountId) {
  return ctx.hub.sql(
    `UPDATE billing_accounts SET plan_until = now() - interval '1 minute', subscription_current_period_end = now() - interval '1 minute' WHERE id = '${accountId}' AND plan_until IS NOT NULL RETURNING id`
  );
}

/**
 * Run the sweep and wait for free. When the hub still holds Pro to a paid end
 * in its own future (the test clock gap), move that end to now and sweep again.
 * Answers `{ account, clockShift, beforeShift }`.
 */
async function sweepToFree(ctx, org, accountId, paidEnd, what) {
  await ctx.hub.runSweep();
  let account = await ctx.hub.account(org);
  if (account.plan === 'free') return { account, clockShift: false, beforeShift: planView(account) };
  const beforeShift = planView(account);
  const paidEndAhead = account.planUntil && Date.parse(account.planUntil) > Date.now();
  if (account.plan !== 'pro' || !paidEndAhead || !sameInstant(account.planUntil, paidEnd)) {
    throw new CampaignError(`${what}: after the sweep the account is neither free nor Pro to the paid end`, {
      org,
      paidEnd,
      account: beforeShift,
      hubNow: new Date().toISOString()
    });
  }
  const moved = await bringPaidEndToNow(ctx, accountId);
  if (!moved)
    throw new CampaignError(`${what}: the paid end could not be moved on the hub row`, { accountId });
  ctx.report.note(
    `plan: "${what}" moved the hub row's paid end (${paidEnd}) to now before the sweep, because the hub judges the paid period on its wall clock and the Stripe test clock had already passed it.`
  );
  await ctx.hub.runSweep();
  account = await ctx.hub.account(org);
  return { account, clockShift: true, beforeShift };
}

export const scenarios = [
  {
    name: 'the two organizations, a deck and its ten links on the free plan',
    path: 'Slideless + hub',
    async run(ctx) {
      const ws = await ctx.sl.createWorkspace('Campaign plan Slideless');
      if (!ws.workspaceId || !ws.org)
        throw new CampaignError('the Slideless workspace does not project a hub organization', { ws });
      const accountId = await ctx.hub.accountIdOf(ws.org);
      const start = await ctx.hub.account(ws.org);
      const key = await ctx.sl.createKey(ws.workspaceId);
      const renewalOrg = await ctx.hub.createOrg(RENEWAL_ORG_NAME);
      const renewalAccountId = await ctx.hub.accountIdOf(renewalOrg);
      ctx.shared.plan = { ws, accountId, key, renewal: { org: renewalOrg, accountId: renewalAccountId } };
      ctx.log(`plan: workspace ${ws.workspaceId} (org ${ws.org}), renewal org ${renewalOrg}`);

      await ctx.hub.patchAccount(ws.org, { billingEmail: EMAIL_A });
      await ctx.hub.patchAccount(renewalOrg, { billingEmail: EMAIL_B });
      for (const org of [ws.org, renewalOrg]) {
        const customer = await ctx.hub.customerOf(org);
        if (customer) await ctx.stripe.tagCustomer(customer);
      }

      if (start.plan !== 'free')
        throw new CampaignError('the new organization is not on the free plan', { account: planView(start) });
      if (start.balance !== 5000)
        ctx.report.note(
          `plan: the new organization started at ${start.balance} credits, not 5,000; the balance check uses the start read.`
        );

      const folder = path.join(ctx.config.out, 'decks', 'plan');
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, 'index.html'),
        '<!doctype html>\n<html><head><meta charset="utf-8"><title>Campaign plan deck</title></head>\n<body><section><h1>Campaign plan deck</h1><p>One page for the plan group.</p></section></body></html>\n'
      );
      const pushed = await ctx.sl.push(folder, { key, ws: ws.workspaceId, title: 'Campaign plan deck' });
      const deckId = pushed?.presentation?.id;
      if (!deckId) throw new CampaignError('the CLI push answered no presentation id', { pushed });
      ctx.shared.plan.deckId = deckId;

      const minted = [];
      for (let i = 1; i <= 10; i += 1) {
        const res = await ctx.sl.mintLink(ws.workspaceId, deckId, { name: `link-${i}`, key });
        expectStatus(res, 201, `mint link-${i}`);
        minted.push(res.json.shareToken.id);
      }
      const links = await ctx.sl.links(ws.workspaceId, deckId);
      const live = links.filter((t) => t.purpose === 'share' && !t.revokedAt);
      if (live.length !== 10)
        throw new CampaignError('the deck does not list exactly 10 live share links', {
          live: live.length,
          all: links.length
        });

      await ctx.sl.waitUsageDrained();
      const expected = start.balance - 50 - 5 - 10 * 20;
      let last = null;
      const settled = await waitFor(
        async () => {
          last = await ctx.hub.account(ws.org);
          return last.balance === expected ? last : null;
        },
        { every: 1500, timeoutMs: 90_000 }
      );
      if (!settled)
        throw new CampaignError(
          `the balance never read ${expected} (the start minus 50 for the deck, 5 for its page, 200 for ten links)`,
          {
            start: start.balance,
            expected,
            last: last?.balance,
            ledger: (await ctx.hub.ledger(ws.org)).slice(0, 15)
          }
        );
      return {
        workspaceId: ws.workspaceId,
        org: ws.org,
        accountId,
        renewalOrg,
        renewalAccountId,
        deckId,
        version: pushed.version?.version ?? null,
        links: minted.length,
        liveLinks: live.length,
        startBalance: start.balance,
        balance: settled.balance,
        plan: settled.plan
      };
    }
  },

  {
    name: 'free is limited: the eleventh link, a password, the fourth seat',
    path: 'Slideless + hub',
    async run(ctx) {
      const s = state(ctx, 'ws', 'key', 'deckId', 'accountId');
      const { workspaceId, org } = s.ws;
      await ctx.sl.waitUsageDrained();
      const eventsBefore = await usageEventCount(ctx, s.accountId);

      const eleventh = await ctx.sl.mintLink(workspaceId, s.deckId, { name: 'link-11', key: s.key });
      if (!Slideless.isPlanRefusal(eleventh, 'links.perDeck'))
        throw new CampaignError('the eleventh link was not refused plan_required on links.perDeck', {
          status: eleventh.status,
          body: eleventh.json ?? eleventh.text.slice(0, 400)
        });
      const locked = await ctx.sl.mintLink(workspaceId, s.deckId, {
        name: 'locked',
        password: LOCKED_PASSWORD
      });
      if (!Slideless.isPlanRefusal(locked, 'deck.password'))
        throw new CampaignError('the password link was not refused plan_required on deck.password', {
          status: locked.status,
          body: locked.json ?? locked.text.slice(0, 400)
        });

      const m2 = await ctx.hub.invite(org, 'campaign-plan-m2@drill.test');
      expectStatus(m2, 201, 'the second seat invitation');
      const m3 = await ctx.hub.invite(org, 'campaign-plan-m3@drill.test');
      expectStatus(m3, 201, 'the third seat invitation');
      const m4 = await ctx.hub.invite(org, 'campaign-plan-m4@drill.test');
      const d = m4.json?.error?.details ?? {};
      if (
        m4.status !== 403 ||
        m4.json?.error?.code !== 'plan_required' ||
        d.key !== 'workspace.members' ||
        typeof d.upgradeUrl !== 'string' ||
        !d.upgradeUrl.includes('tool=slideless-cloud')
      ) {
        throw new CampaignError(
          'the fourth seat was not refused plan_required on workspace.members with an upgrade link naming slideless-cloud',
          { status: m4.status, body: m4.json ?? m4.text.slice(0, 400) }
        );
      }

      await ctx.sl.waitUsageDrained();
      const eventsAfter = await usageEventCount(ctx, s.accountId);
      if (eventsAfter !== eventsBefore)
        throw new CampaignError('the refusals queued usage events at the hub', { eventsBefore, eventsAfter });
      return {
        eleventh: {
          status: eleventh.status,
          key: eleventh.json.error.details.key,
          requiredPlan: eleventh.json.error.details.requiredPlan
        },
        password: {
          status: locked.status,
          key: locked.json.error.details.key,
          requiredPlan: locked.json.error.details.requiredPlan
        },
        invites: { m2: m2.status, m3: m3.status, m4: m4.status },
        seatRefusal: {
          key: d.key,
          plan: d.plan,
          requiredPlan: d.requiredPlan ?? null,
          upgradeUrl: d.upgradeUrl
        },
        eventsBefore,
        eventsAfter
      };
    }
  },

  {
    name: 'subscribe: the Checkout on the pro price, the plan flips to pro',
    path: 'hosted Checkout (browser)',
    async run(ctx) {
      const s = state(ctx, 'ws', 'accountId');
      const { org } = s.ws;
      const before = await ctx.hub.account(org);
      const res = await ctx.hub.subscription(org, 'subscribe');
      expectStatus(res, 200, 'subscribe');
      if (!res.json?.url) throw new CampaignError('subscribe answered no Checkout url', { body: res.json });
      const customerId = await ctx.hub.customerOf(org);
      if (!customerId) throw new CampaignError('the hub made no Stripe customer on subscribe', { org });
      await ctx.stripe.tagCustomer(customerId);
      s.customerId = customerId;

      const paid = await ctx.payCheckout(res.json.url, {
        mode: 'subscription',
        card: CARDS.visa,
        email: EMAIL_A,
        label: 'plan-subscribe'
      });
      const account = await waitAccount(
        ctx,
        org,
        (a) =>
          a.plan === 'pro' &&
          a.subscription?.status === 'active' &&
          a.subscription?.cancelAtPeriodEnd === false &&
          a.planUntil === null,
        'the plan did not flip to a live Pro'
      );
      const heldId = await ctx.hub.sql(
        `SELECT coalesce(stripe_subscription_id, '') FROM billing_accounts WHERE id = '${s.accountId}'`
      );
      const subs = (await ctx.stripe.subscriptions(customerId)).data ?? [];
      const sub = subs.find((x) => x.id === heldId) ?? null;
      if (!sub)
        throw new CampaignError("the subscription the hub holds is not among the customer's subscriptions", {
          heldId,
          stripe: subs.map((x) => ({ id: x.id, status: x.status }))
        });
      if (subs.length !== 1)
        throw new CampaignError('the customer carries more than one subscription', {
          stripe: subs.map((x) => ({ id: x.id, status: x.status }))
        });
      const price = proPriceOf(sub);
      if (price.lookupKey !== 'antasphere-pro-monthly-eur' || price.unitAmount !== 5000)
        throw new CampaignError('the subscription is not on the EUR Pro monthly price', { price });
      s.subscriptionId = sub.id;
      s.periodEnd0 = account.subscription.currentPeriodEnd;

      const again = await ctx.hub.subscription(org, 'subscribe');
      expectStatus(again, 200, 'subscribe again');
      if (again.json?.url !== null)
        throw new CampaignError('a second subscribe opened another Checkout beside the live subscription', {
          body: again.json
        });
      return {
        customerId,
        subscriptionId: sub.id,
        stripeStatus: sub.status,
        price,
        returnedTo: paid.url,
        before: planView(before),
        after: planView(account),
        periodEnd0: s.periodEnd0,
        secondSubscribeUrl: again.json.url
      };
    }
  },

  {
    name: 'pro unlocks on Slideless: the eleventh link, the password, the fourth seat',
    path: 'Slideless + hub',
    async run(ctx) {
      const s = state(ctx, 'ws', 'key', 'deckId', 'subscriptionId');
      const { workspaceId, org } = s.ws;
      const t0 = Date.now();
      let eleventh = null;
      let refusals = 0;
      while (Date.now() - t0 < 90_000) {
        eleventh = await ctx.sl.mintLink(workspaceId, s.deckId, { name: 'link-11', key: s.key });
        if (eleventh.status === 201) break;
        if (!Slideless.isPlanRefusal(eleventh, 'links.perDeck'))
          throw new CampaignError('the eleventh link answered something other than 201 or the plan refusal', {
            status: eleventh.status,
            body: eleventh.json ?? eleventh.text.slice(0, 400)
          });
        refusals += 1;
        await sleep(3000);
      }
      if (eleventh?.status !== 201)
        throw new CampaignError('the eleventh link was still refused 90 s after the plan flipped to Pro', {
          status: eleventh?.status,
          body: eleventh?.json,
          refusals
        });
      const unlockedAfterMs = Date.now() - t0;

      const locked = await ctx.sl.mintLink(workspaceId, s.deckId, {
        name: 'locked',
        password: LOCKED_PASSWORD
      });
      expectStatus(locked, 201, 'the password link on Pro');
      if (locked.json?.shareToken?.hasPassword !== true)
        throw new CampaignError('the password link does not say hasPassword', {
          shareTokenId: locked.json?.shareToken?.id,
          hasPassword: locked.json?.shareToken?.hasPassword
        });
      s.lockedId = locked.json.shareToken.id;

      const m4 = await ctx.hub.invite(org, 'campaign-plan-m4@drill.test');
      expectStatus(m4, 201, 'the fourth seat invitation on Pro');

      const ent = await ctx.hub.entitlements(org);
      if (ent.plan !== 'pro' || !hasFeature(ent.features, 'deck.password'))
        throw new CampaignError('the hub entitlements do not read Pro with deck.password', {
          plan: ent.plan,
          features: ent.features
        });
      return {
        eleventhId: eleventh.json.shareToken.id,
        refusalsBeforeUnlock: refusals,
        unlockedAfterMs,
        lockedId: s.lockedId,
        hasPassword: true,
        fourthSeat: m4.status,
        entitlements: { plan: ent.plan, features: ent.features }
      };
    }
  },

  {
    name: 'a test-clock month renews the subscription and the paid period moves',
    path: 'Stripe API + hub',
    async run(ctx) {
      const s = state(ctx, 'ws', 'customerId', 'subscriptionId', 'periodEnd0');
      const { org } = s.ws;
      const t0 = Date.now();
      const clock = await ctx.stripe.advanceClock(s.customerId, 32 * DAY);
      const paidEvent = await ctx.relay.waitProcessed(
        (r) => r.type === 'invoice.paid' && r.body.includes(s.subscriptionId) && r.receivedAt > t0
      );
      if (!paidEvent) {
        throw new CampaignError('no processed invoice.paid for the renewal reached the relay in 90 s', {
          subscriptionId: s.subscriptionId,
          seen: ctx.relay.records
            .filter((r) => r.receivedAt > t0 && r.body.includes(s.subscriptionId))
            .map((r) => ({ type: r.type, outcome: r.outcome, status: r.status }))
        });
      }
      const account = await waitAccount(
        ctx,
        org,
        (a) => {
          const end = a.subscription?.currentPeriodEnd;
          if (!end) return false;
          const days = (Date.parse(end) - Date.parse(s.periodEnd0)) / 1000 / DAY;
          return days >= 28 && days <= 32;
        },
        'the paid period did not move by about a month'
      );
      if (account.plan !== 'pro' || account.planUntil !== null)
        throw new CampaignError('the renewed account is not a live Pro', { account: planView(account) });
      const sub = await ctx.stripe.subscription(s.subscriptionId);
      if (sub.status !== 'active')
        throw new CampaignError('the Stripe subscription is not active after the renewal', {
          status: sub.status
        });
      const latestId = typeof sub.latest_invoice === 'object' ? sub.latest_invoice?.id : sub.latest_invoice;
      const latest = latestId ? await ctx.stripe.invoice(latestId) : null;
      if (latest?.status !== 'paid')
        throw new CampaignError("the subscription's latest invoice is not paid", {
          latestId,
          status: latest?.status
        });
      s.periodEnd1 = account.subscription.currentPeriodEnd;
      return {
        clockFrozenTime: clock.frozen_time,
        eventId: paidEvent.id,
        invoiceId: latestId,
        invoiceStatus: latest.status,
        periodEnd0: s.periodEnd0,
        periodEnd1: s.periodEnd1,
        movedDays: Number(((Date.parse(s.periodEnd1) - Date.parse(s.periodEnd0)) / 1000 / DAY).toFixed(2)),
        after: planView(account),
        stripeStatus: sub.status
      };
    }
  },

  {
    name: 'cancel keeps pro until the paid period ends; resume takes it back',
    path: 'hub routes',
    async run(ctx) {
      const s = state(ctx, 'ws', 'subscriptionId');
      const { org } = s.ws;
      const cancel = await ctx.hub.subscription(org, 'cancel');
      expectStatus(cancel, 200, 'cancel');
      if (cancel.json?.subscription?.cancelAtPeriodEnd !== true)
        throw new CampaignError('cancel did not answer a pending cancellation', { body: cancel.json });
      const cancelled = await ctx.hub.account(org);
      if (
        cancelled.plan !== 'pro' ||
        !sameInstant(cancelled.planUntil, cancelled.subscription?.currentPeriodEnd)
      ) {
        throw new CampaignError('after cancel the account is not Pro until the paid period end', {
          account: planView(cancelled)
        });
      }
      const stripeCancelled = await ctx.stripe.subscription(s.subscriptionId);
      if (stripeCancelled.cancel_at_period_end !== true)
        throw new CampaignError('Stripe does not carry the pending cancellation', {
          cancelAtPeriodEnd: stripeCancelled.cancel_at_period_end
        });

      const resume = await ctx.hub.subscription(org, 'resume');
      expectStatus(resume, 200, 'resume');
      if (resume.json?.subscription?.cancelAtPeriodEnd !== false)
        throw new CampaignError('resume did not clear the pending cancellation', { body: resume.json });
      const resumed = await ctx.hub.account(org);
      if (resumed.plan !== 'pro' || resumed.planUntil !== null)
        throw new CampaignError('after resume the account is not a live Pro', { account: planView(resumed) });
      const stripeResumed = await ctx.stripe.subscription(s.subscriptionId);
      if (stripeResumed.cancel_at_period_end !== false)
        throw new CampaignError('Stripe still carries the cancellation after resume', {
          cancelAtPeriodEnd: stripeResumed.cancel_at_period_end
        });
      return {
        subscriptionId: s.subscriptionId,
        afterCancel: planView(cancelled),
        afterResume: planView(resumed),
        stripe: {
          afterCancel: stripeCancelled.cancel_at_period_end,
          afterResume: stripeResumed.cancel_at_period_end
        }
      };
    }
  },

  {
    name: 'a failed renewal keeps pro to the paid end, then drops to free',
    path: 'Stripe API + hub',
    async run(ctx) {
      const s = state(ctx, 'renewal');
      const { org, accountId } = s.renewal;
      if (!org || !accountId)
        throw new CampaignError('the renewal organization is missing: scenario 1 did not complete', {
          renewal: s.renewal
        });
      const subject = `The Pro renewal for ${RENEWAL_ORG_NAME} did not go through`;
      const tStart = Date.now() - 1000;

      const res = await ctx.hub.subscription(org, 'subscribe');
      expectStatus(res, 200, 'subscribe (renewal org)');
      if (!res.json?.url)
        throw new CampaignError('subscribe answered no Checkout url (renewal org)', { body: res.json });
      const customerId = await ctx.hub.customerOf(org);
      if (!customerId)
        throw new CampaignError('the hub made no Stripe customer on subscribe (renewal org)', { org });
      await ctx.stripe.tagCustomer(customerId);
      await ctx.payCheckout(res.json.url, {
        mode: 'subscription',
        card: CARDS.visa,
        email: EMAIL_B,
        label: 'plan-renewal-subscribe'
      });
      const pro = await waitAccount(
        ctx,
        org,
        (a) => a.plan === 'pro' && a.subscription?.status === 'active' && a.planUntil === null,
        'the renewal organization did not become a live Pro'
      );
      const paidEnd = pro.subscription.currentPeriodEnd;
      const subId = await ctx.hub.sql(
        `SELECT coalesce(stripe_subscription_id, '') FROM billing_accounts WHERE id = '${accountId}'`
      );
      if (!subId)
        throw new CampaignError('the hub holds no subscription id for the renewal organization', {
          accountId
        });

      const pm = await ctx.stripe.attachTestCard(customerId, 'pm_card_chargeCustomerFail');
      await ctx.stripe.updateSubscription(subId, { default_payment_method: pm.id });

      const t1 = Date.now();
      await ctx.stripe.advanceClock(customerId, 32 * DAY);
      const failed = await ctx.relay.waitProcessed(
        (r) => r.type === 'invoice.payment_failed' && r.body.includes(subId) && r.receivedAt > t1
      );
      if (!failed) {
        throw new CampaignError(
          'no processed invoice.payment_failed for the renewal reached the relay in 90 s',
          {
            subId,
            seen: ctx.relay.records
              .filter((r) => r.receivedAt > t1 && r.body.includes(subId))
              .map((r) => ({ type: r.type, outcome: r.outcome, status: r.status }))
          }
        );
      }
      const pastDue = await waitAccount(
        ctx,
        org,
        (a) => a.plan === 'pro' && sameInstant(a.planUntil, paidEnd) && a.subscription?.status === 'past_due',
        'after the refused renewal the account is not Pro to the paid end and past_due'
      );
      const firstMail = await ctx.mail.waitFor({ to: EMAIL_B, subject, after: tStart }, 60_000);
      if (!firstMail)
        throw new CampaignError('the failed renewal mail did not arrive', { to: EMAIL_B, subject });

      // A few more days on the clock let Stripe retry; a retry is the same event kind and must send no second mail.
      const t2 = Date.now();
      await ctx.stripe.advanceClock(customerId, 3 * DAY);
      const retry = await ctx.relay.waitProcessed(
        (r) => r.type === 'invoice.payment_failed' && r.body.includes(subId) && r.receivedAt > t2,
        { timeoutMs: 30_000 }
      );
      await sleep(5000);
      const mails = await ctx.mail.find({ to: EMAIL_B, subject, after: tStart });
      if (mails.length !== 1)
        throw new CampaignError('the failed renewal mail did not arrive exactly once', {
          count: mails.length,
          ids: mails.map((m) => m.ID),
          retryEvent: retry?.id ?? null
        });

      await ctx.stripe.advanceClock(customerId, 40 * DAY);
      const stripeSub = await ctx.stripe.subscription(subId);
      const { account, clockShift, beforeShift } = await sweepToFree(
        ctx,
        org,
        accountId,
        paidEnd,
        'a failed renewal keeps pro to the paid end, then drops to free'
      );
      const free =
        account.plan === 'free' && account.planUntil === null
          ? account
          : await waitAccount(
              ctx,
              org,
              (a) => a.plan === 'free' && a.planUntil === null,
              'the lapsed renewal did not drop to free'
            );
      return {
        customerId,
        subscriptionId: subId,
        failingPaymentMethod: pm.id,
        paidEnd,
        failedEventId: failed.id,
        retryEventId: retry?.id ?? null,
        pastDue: planView(pastDue),
        mailId: firstMail.ID,
        mailCount: mails.length,
        stripeStatusAfterDunning: stripeSub.status,
        beforeSweep: beforeShift,
        clockShift,
        after: planView(free)
      };
    }
  },

  {
    name: 'downgrade: after the paid period a canceled subscription is free',
    path: 'Stripe API + hub',
    async run(ctx) {
      const s = state(ctx, 'ws', 'accountId', 'customerId', 'subscriptionId', 'key', 'deckId', 'lockedId');
      const { workspaceId, org } = s.ws;
      const cancel = await ctx.hub.subscription(org, 'cancel');
      expectStatus(cancel, 200, 'cancel before the downgrade');
      const cancelled = await ctx.hub.account(org);
      if (
        cancelled.plan !== 'pro' ||
        !cancelled.planUntil ||
        !sameInstant(cancelled.planUntil, cancelled.subscription?.currentPeriodEnd)
      ) {
        throw new CampaignError('after cancel the account is not Pro until the paid period end', {
          account: planView(cancelled)
        });
      }
      const paidEnd = cancelled.planUntil;

      const t0 = Date.now();
      await ctx.stripe.advanceClock(s.customerId, 35 * DAY);
      const deleted = await ctx.relay.waitProcessed(
        (r) =>
          r.type === 'customer.subscription.deleted' && r.body.includes(s.subscriptionId) && r.receivedAt > t0
      );
      if (!deleted) {
        throw new CampaignError('no processed customer.subscription.deleted reached the relay in 90 s', {
          subscriptionId: s.subscriptionId,
          seen: ctx.relay.records
            .filter((r) => r.receivedAt > t0 && r.body.includes(s.subscriptionId))
            .map((r) => ({ type: r.type, outcome: r.outcome, status: r.status }))
        });
      }
      const stripeSub = await ctx.stripe.subscription(s.subscriptionId);
      if (stripeSub.status !== 'canceled')
        throw new CampaignError('the Stripe subscription is not canceled after its period', {
          status: stripeSub.status
        });
      const { account, clockShift, beforeShift } = await sweepToFree(
        ctx,
        org,
        s.accountId,
        paidEnd,
        'downgrade: after the paid period a canceled subscription is free'
      );
      const free =
        account.plan === 'free' && account.subscription === null
          ? account
          : await waitAccount(
              ctx,
              org,
              (a) => a.plan === 'free' && a.subscription === null,
              'the canceled subscription did not leave a free account without a subscription'
            );

      const t1 = Date.now();
      let twelfth = null;
      let mintedMeanwhile = 0;
      while (Date.now() - t1 < 90_000) {
        twelfth = await ctx.sl.mintLink(workspaceId, s.deckId, { name: 'link-12', key: s.key });
        if (Slideless.isPlanRefusal(twelfth, 'links.perDeck')) break;
        if (twelfth.status === 201) mintedMeanwhile += 1;
        else
          throw new CampaignError('the twelfth link answered something other than 201 or the plan refusal', {
            status: twelfth.status,
            body: twelfth.json ?? twelfth.text.slice(0, 400)
          });
        await sleep(3000);
      }
      if (!Slideless.isPlanRefusal(twelfth, 'links.perDeck'))
        throw new CampaignError('Slideless still minted links 90 s after the downgrade', {
          status: twelfth?.status,
          mintedMeanwhile
        });

      const links = await ctx.sl.links(workspaceId, s.deckId);
      const locked = links.find((t) => t.id === s.lockedId);
      if (!locked || locked.hasPassword !== true || locked.revokedAt)
        throw new CampaignError('the password link minted on Pro is not still live with its password', {
          lockedId: s.lockedId,
          found: locked ? { hasPassword: locked.hasPassword, revokedAt: locked.revokedAt } : null
        });
      return {
        subscriptionId: s.subscriptionId,
        paidEnd,
        deletedEventId: deleted.id,
        stripeStatus: stripeSub.status,
        beforeSweep: beforeShift,
        clockShift,
        after: planView(free),
        refusedAfterMs: Date.now() - t1,
        mintedMeanwhile,
        twelfth: { status: twelfth.status, key: twelfth.json.error.details.key },
        lockedLink: { id: locked.id, hasPassword: locked.hasPassword, revokedAt: locked.revokedAt ?? null },
        liveLinks: links.filter((t) => t.purpose === 'share' && !t.revokedAt).length
      };
    }
  }
];
