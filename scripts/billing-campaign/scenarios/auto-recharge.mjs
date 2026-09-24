// The billing campaign (PRDCT-2718): auto-recharge, a card on file buys credits by itself under the threshold,
// once even when two tools debit at the same moment, stops at the monthly cap, and on a declined card retries
// once a day later, then switches itself off with the reason shown and mailed.
//
// Three organizations of their own, each with a card saved through the setup Checkout. No scenario buys
// through POST /billing/checkout, so none needs lane A. The debits are usage events posted on the tool's
// machine channel, the way Slideless posts them.
import { CampaignError, expectStatus, sleep, waitFor } from '../lib/http.mjs';
import { CARDS } from '../lib/checkout.mjs';

export const group = 'auto-recharge';

// The three organizations, filled by the first scenario and read by every later one.
const ORGS = {
  once: { name: 'Campaign recharge once', email: 'campaign-ar-once@drill.test', card: CARDS.visa, last4: '4242' },
  cap: { name: 'Campaign recharge cap', email: 'campaign-ar-cap@drill.test', card: CARDS.visa, last4: '4242' },
  decline: { name: 'Campaign recharge decline', email: 'campaign-ar-decline@drill.test', card: CARDS.chargeFails, last4: '0341' }
};
// Per organization: `{ org, accountId, customerId, sessionId }` once the setup scenario ran.
const made = {};
// The decline organization's parked run and the time its story started (the mail window).
let declineRun = null;
let declineT0 = 0;

/** The organization a scenario needs, or a clear error when the setup scenario did not make it. */
function need(key) {
  const m = made[key];
  if (!m?.org || !m?.customerId) {
    throw new CampaignError(`the organization "${ORGS[key].name}" is missing: the first scenario (the card setups) did not complete`, { key });
  }
  return m;
}

/** The error code of a refusal, read where the hub puts it. */
const codeOf = (res) => res.json?.error?.code ?? res.json?.code ?? null;

/** PATCH /billing/auto-recharge expecting 200; answers the account read. */
async function setAutoRecharge(ctx, org, body, what) {
  const res = await ctx.hub.autoRecharge(org, body);
  return expectStatus(res, 200, what).json;
}

/** Post one batch of events and require every event of it accepted; answers the hub's body. */
async function postAccepted(ctx, events, what) {
  const out = await ctx.hub.postUsage(events);
  const bad = (out.results ?? []).filter((r) => r.status !== 'accepted');
  if (bad.length || out.accepted !== events.length) {
    throw new CampaignError(`${what}: not every event was accepted`, { results: out.results, accepted: out.accepted, sent: events.length });
  }
  return out;
}

/** A debit of `credits`, posted alone; answers the accepted result, whose credits must equal the debit. */
async function debit(ctx, org, credits) {
  const out = await postAccepted(ctx, [ctx.hub.debitEvent(org, credits)], `the debit of ${credits}`);
  const r = out.results[0];
  if (r.credits !== credits) throw new CampaignError(`the debit of ${credits} was priced ${r.credits}`, { result: r });
  return r;
}

/** Wait until the account read satisfies `test`; the read, or null after `timeoutMs`. */
function waitAccount(ctx, org, test, timeoutMs = 90_000) {
  return waitFor(
    async () => {
      const a = await ctx.hub.account(org);
      return test(a) ? a : null;
    },
    { every: 1500, timeoutMs }
  );
}

/** Wait until the ledger holds at least `n` purchase entries; the entries (newest first), or null. */
function waitPurchases(ctx, org, n, timeoutMs = 90_000) {
  return waitFor(
    async () => {
      const p = await ctx.hub.ledger(org, 'purchase');
      return p.length >= n ? p : null;
    },
    { every: 1500, timeoutMs }
  );
}

/** A psql timestamptz text (`2026-09-26 10:00:00.123+00`) as epoch milliseconds, or NaN. */
function pgTime(text) {
  if (!text) return NaN;
  const iso = text.trim().replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00');
  return Date.parse(iso);
}

/** The succeeded auto-recharge payment intents of a customer at Stripe. */
async function succeededRechargeIntents(ctx, customerId) {
  const list = await ctx.stripe.get('/v1/payment_intents', { customer: customerId, limit: 20 });
  return (list.data ?? []).filter((pi) => pi.status === 'succeeded' && pi.metadata?.kind === 'auto_recharge');
}

/** The mails to `to` whose subject contains `subject`, created at or after `after` (summaries). */
const mailsOf = (ctx, to, subject, after) => ctx.mail.find({ to, subject, after });

export const scenarios = [
  {
    name: 'three organizations, a card on file on each',
    path: 'hosted Checkout (browser)',
    async run(ctx) {
      const evidence = {};
      for (const [key, spec] of Object.entries(ORGS)) {
        const org = await ctx.hub.createOrg(spec.name);
        const accountId = await ctx.hub.accountIdOf(org);
        if (!accountId) throw new CampaignError(`the organization "${spec.name}" has no billing account`, { org });
        await ctx.hub.patchAccount(org, { billingEmail: spec.email });
        const setup = await ctx.hub.paymentMethodSetup(org);
        if (!setup.url || !setup.sessionId) throw new CampaignError(`the setup session of "${spec.name}" carries no url`, { org, sessionId: setup.sessionId ?? null });
        ctx.log(`auto-recharge: ${spec.name} (${org}) saves a card ending ${spec.last4} through setup session ${setup.sessionId}`);
        const paid = await ctx.payCheckout(setup.url, { mode: 'setup', card: spec.card, email: spec.email, label: `ar-setup-${key}` });
        const account = await waitAccount(ctx, org, (a) => a.paymentMethod?.last4 === spec.last4, 90_000);
        if (!account) {
          throw new CampaignError(`the account of "${spec.name}" never showed the card ending ${spec.last4}`, {
            org,
            sessionId: setup.sessionId,
            returnedTo: paid.url,
            paymentMethod: (await ctx.hub.account(org)).paymentMethod
          });
        }
        const customerId = await ctx.hub.customerOf(org);
        if (!customerId) throw new CampaignError(`the hub holds no Stripe customer for "${spec.name}" after the setup`, { org, sessionId: setup.sessionId });
        await ctx.stripe.tagCustomer(customerId);
        const pm = await ctx.stripe.defaultPaymentMethod(customerId);
        if (pm?.card?.last4 !== spec.last4) {
          throw new CampaignError(`the Stripe customer of "${spec.name}" has no default card ending ${spec.last4}`, { customerId, defaultLast4: pm?.card?.last4 ?? null });
        }
        made[key] = { org, accountId, customerId, sessionId: setup.sessionId };
        evidence[key] = { org, accountId, customerId, sessionId: setup.sessionId, paymentMethod: account.paymentMethod, startBalance: account.balance };
      }
      return evidence;
    }
  },
  {
    name: 'under the threshold it buys once: one intent, one purchase, the balance back up',
    path: 'hub routes',
    async run(ctx) {
      const { org, customerId } = need('once');
      const t0 = Date.now();
      const set = await setAutoRecharge(ctx, org, { enabled: true, threshold: 4000, credits: 20000, monthlyCap: 60000 }, 'turning auto-recharge on');
      const ar = set.autoRecharge;
      if (ar?.enabled !== true || ar.threshold !== 4000 || ar.credits !== 20000 || ar.monthlyCap !== 60000) {
        throw new CampaignError('the account read does not echo the auto-recharge settings', { autoRecharge: ar });
      }
      const start = set.balance;
      if (start - 1500 >= 4000) throw new CampaignError('the starting balance is too high for a debit of 1,500 to cross the threshold', { start });
      const debited = await debit(ctx, org, 1500);
      const purchase = await ctx.hub.waitLedger(org, { kind: 'purchase', amount: 20000 });
      if (!purchase) throw new CampaignError('no purchase of 20,000 landed within 90 s of the debit', { debitId: debited.id, runs: await ctx.hub.runs(org), ledger: await ctx.hub.ledger(org) });
      const runs = await waitFor(
        async () => {
          const r = await ctx.hub.runs(org);
          return r.length && r.every((x) => x.state !== 'pending') ? r : null;
        },
        { every: 1500, timeoutMs: 30_000 }
      );
      if (!runs || runs.length !== 1 || runs[0].state !== 'succeeded') {
        throw new CampaignError('the account does not hold exactly one succeeded run', { runs: runs ?? (await ctx.hub.runs(org)) });
      }
      const run = runs[0];
      if (run.paymentIntentId !== purchase.sourceRef) {
        throw new CampaignError('the run and the purchase name different payment intents', { runPaymentIntentId: run.paymentIntentId, purchaseSourceRef: purchase.sourceRef });
      }
      const intent = await ctx.stripe.paymentIntent(run.paymentIntentId);
      const intentFacts = { id: intent.id, status: intent.status, amount: intent.amount, currency: intent.currency, kind: intent.metadata?.kind, credits: intent.metadata?.credits, runId: intent.metadata?.runId ?? null, customer: intent.customer };
      if (intent.status !== 'succeeded' || intent.amount !== 2000 || intent.currency !== 'eur' || intent.metadata?.kind !== 'auto_recharge' || intent.metadata?.credits !== '20000') {
        throw new CampaignError('the Stripe intent of the run is not a succeeded EUR 20.00 auto-recharge of 20,000 credits', { intent: intentFacts });
      }
      if (intent.customer !== customerId) throw new CampaignError('the intent was charged to another customer', { intent: intentFacts, customerId });
      const purchases = await ctx.hub.ledger(org, 'purchase');
      if (purchases.length !== 1) throw new CampaignError('the ledger holds more than one purchase', { purchases });
      const expected = start - 1500 + 20000;
      const account = await ctx.hub.account(org);
      if (account.balance !== expected) throw new CampaignError(`the balance reads ${account.balance}, expected ${expected}`, { start, balance: account.balance });
      if (expected !== 23500) ctx.report.note(`auto-recharge: the once organization started at ${start}, not 5,000; the balance was judged against ${expected}.`);
      if (account.autoRecharge?.rechargedThisMonth !== 20000) {
        throw new CampaignError('rechargedThisMonth does not read 20,000', { autoRecharge: account.autoRecharge });
      }
      const agrees = await ctx.hub.balanceAgrees(org);
      if (!agrees.agrees) throw new CampaignError('the balance is not the sum of the ledger', { agrees });
      // The low-balance pass runs beside the recharge: give its mail time to go out before judging none did.
      await sleep(5000);
      const lowMails = [
        ...(await mailsOf(ctx, null, `${ORGS.once.name} is running low on credits`, t0)),
        ...(await mailsOf(ctx, null, `${ORGS.once.name} has used up its credits`, t0))
      ];
      if (lowMails.length) throw new CampaignError('a low-balance mail went out although auto-recharge answered', { mails: lowMails.map((m) => ({ id: m.ID, subject: m.Subject })) });
      ctx.shared.arOnceBalance = account.balance;
      return {
        org,
        customerId,
        debitEventId: debited.id,
        runId: run.id,
        paymentIntentId: run.paymentIntentId,
        purchaseEntryId: purchase.id,
        intent: intentFacts,
        startBalance: start,
        balance: account.balance,
        rechargedThisMonth: account.autoRecharge.rechargedThisMonth,
        lowBalanceMails: 0
      };
    }
  },
  {
    name: 'two tools debiting at once charge once (the advisory lock)',
    path: 'hub routes',
    async run(ctx) {
      const { org, customerId } = need('once');
      const runsBefore = await ctx.hub.runs(org);
      const purchasesBefore = await ctx.hub.ledger(org, 'purchase');
      if (runsBefore.length !== 1 || purchasesBefore.length !== 1) {
        throw new CampaignError('the previous scenario did not leave exactly one run and one purchase', { runs: runsBefore, purchases: purchasesBefore.length });
      }
      const set = await setAutoRecharge(ctx, org, { threshold: 30000 }, 'raising the threshold to 30,000');
      if (set.autoRecharge?.threshold !== 30000) throw new CampaignError('the account read does not echo the threshold 30,000', { autoRecharge: set.autoRecharge });
      const start = set.balance;
      if (start >= 30000) throw new CampaignError('the balance is not under the raised threshold', { balance: start });
      const [a, b] = await Promise.all([
        postAccepted(ctx, [ctx.hub.debitEvent(org, 5)], 'the first concurrent debit'),
        postAccepted(ctx, [ctx.hub.debitEvent(org, 5)], 'the second concurrent debit')
      ]);
      // A second charge, if the lock failed, would come within seconds; wait long enough to see it.
      await sleep(20_000);
      const purchases = await waitPurchases(ctx, org, 2);
      if (!purchases) throw new CampaignError('no second purchase landed after the two debits', { runs: await ctx.hub.runs(org), balance: (await ctx.hub.account(org)).balance });
      const runs = await ctx.hub.runs(org);
      const succeeded = runs.filter((r) => r.state === 'succeeded');
      if (runs.length !== 2 || succeeded.length !== 2) throw new CampaignError('the account does not hold exactly two runs, both succeeded', { runs });
      if (purchases.length !== 2) throw new CampaignError('the ledger holds more than two purchases', { purchases: purchases.map((p) => ({ id: p.id, amount: p.amount, sourceRef: p.sourceRef })) });
      const intents = await succeededRechargeIntents(ctx, customerId);
      if (intents.length !== 2) {
        throw new CampaignError('Stripe does not hold exactly two succeeded auto-recharge intents for the customer', { customerId, intents: intents.map((pi) => ({ id: pi.id, amount: pi.amount, runId: pi.metadata?.runId })) });
      }
      const newRun = runs.find((r) => r.id !== runsBefore[0].id);
      const newPurchase = purchases.find((p) => p.id !== purchasesBefore[0].id);
      if (newRun.paymentIntentId !== newPurchase.sourceRef) {
        throw new CampaignError('the new run and the new purchase name different payment intents', { run: newRun, purchaseSourceRef: newPurchase.sourceRef });
      }
      const expected = start - 10 + 20000;
      const account = await ctx.hub.account(org);
      if (account.balance !== expected) throw new CampaignError(`the balance reads ${account.balance}, expected ${expected}`, { start, balance: account.balance });
      if (expected !== 43490) ctx.report.note(`auto-recharge: the concurrent-debit scenario started at ${start}, not 23,500; the balance was judged against ${expected}.`);
      const agrees = await ctx.hub.balanceAgrees(org);
      if (!agrees.agrees) throw new CampaignError('the balance is not the sum of the ledger', { agrees });
      return {
        org,
        debitEventIds: [a.results[0].id, b.results[0].id],
        runIds: runs.map((r) => r.id),
        newRunId: newRun.id,
        newPaymentIntentId: newRun.paymentIntentId,
        stripeIntentIds: intents.map((pi) => pi.id),
        purchases: purchases.length,
        startBalance: start,
        balance: account.balance,
        rechargedThisMonth: account.autoRecharge?.rechargedThisMonth ?? null
      };
    }
  },
  {
    name: 'the monthly cap stops it, with a mail, and the next month admits it',
    path: 'hub routes',
    async run(ctx) {
      const { org, customerId } = need('cap');
      const t0 = Date.now();
      const set = await setAutoRecharge(ctx, org, { enabled: true, threshold: 4900, credits: 20000, monthlyCap: 20000 }, 'turning auto-recharge on with a cap of one recharge');
      const ar = set.autoRecharge;
      if (ar?.enabled !== true || ar.threshold !== 4900 || ar.credits !== 20000 || ar.monthlyCap !== 20000) {
        throw new CampaignError('the account read does not echo the auto-recharge settings', { autoRecharge: ar });
      }
      const start = set.balance;
      if (start - 500 >= 4900) throw new CampaignError('the starting balance is too high for a debit of 500 to cross the threshold', { start });
      await debit(ctx, org, 500);
      const first = await ctx.hub.waitLedger(org, { kind: 'purchase', amount: 20000 });
      if (!first) throw new CampaignError('the first recharge did not land within 90 s', { runs: await ctx.hub.runs(org) });
      const afterFirst = await waitAccount(ctx, org, (a) => a.balance === start - 500 + 20000, 30_000);
      if (!afterFirst) throw new CampaignError(`the balance does not read ${start - 500 + 20000} after the first recharge`, { balance: (await ctx.hub.account(org)).balance });

      const raised = await setAutoRecharge(ctx, org, { threshold: 30000 }, 'raising the threshold to 30,000');
      if (raised.autoRecharge?.threshold !== 30000) throw new CampaignError('the account read does not echo the threshold 30,000', { autoRecharge: raised.autoRecharge });
      await debit(ctx, org, 5);
      const paused = await waitAccount(ctx, org, (a) => a.autoRecharge?.disabledReason === 'monthly_cap');
      if (!paused) throw new CampaignError('the account never read disabledReason monthly_cap', { autoRecharge: (await ctx.hub.account(org)).autoRecharge, runs: await ctx.hub.runs(org) });
      if (paused.autoRecharge.enabled !== true) throw new CampaignError('the cap switched auto-recharge off instead of pausing it', { autoRecharge: paused.autoRecharge });
      await sleep(15_000);
      const purchasesPaused = await ctx.hub.ledger(org, 'purchase');
      const runsPaused = await ctx.hub.runs(org);
      const succeededPaused = runsPaused.filter((r) => r.state === 'succeeded');
      if (purchasesPaused.length !== 1 || succeededPaused.length !== 1) {
        throw new CampaignError('the cap did not hold: a second recharge happened', { purchases: purchasesPaused.length, runs: runsPaused });
      }
      const capSubject = `Auto-recharge paused for ${ORGS.cap.name}: the monthly cap is reached`;
      const capMail = await ctx.mail.waitFor({ to: ORGS.cap.email, subject: capSubject, after: t0 }, 60_000);
      if (!capMail) throw new CampaignError('no cap mail reached the billing email', { to: ORGS.cap.email, subject: capSubject });

      const reopened = await setAutoRecharge(ctx, org, { monthlyCap: 60000 }, 'raising the cap to 60,000');
      if (reopened.autoRecharge?.monthlyCap !== 60000) throw new CampaignError('the account read does not echo the cap 60,000', { autoRecharge: reopened.autoRecharge });
      await debit(ctx, org, 5);
      const purchases = await waitPurchases(ctx, org, 2);
      if (!purchases) throw new CampaignError('no second recharge landed after the cap was raised', { runs: await ctx.hub.runs(org), autoRecharge: (await ctx.hub.account(org)).autoRecharge });
      const second = purchases.find((p) => p.id !== first.id);
      if (second.amount !== 20000) throw new CampaignError('the second purchase is not 20,000', { second });
      const cleared = await waitAccount(ctx, org, (a) => a.autoRecharge?.disabledReason === null, 30_000);
      if (!cleared) throw new CampaignError('disabledReason did not clear after the admitted recharge', { autoRecharge: (await ctx.hub.account(org)).autoRecharge });
      const runs = await ctx.hub.runs(org);
      const succeeded = runs.filter((r) => r.state === 'succeeded');
      if (purchases.length !== 2 || succeeded.length !== 2) throw new CampaignError('the account does not hold exactly two purchases and two succeeded runs', { purchases: purchases.length, runs });
      const expected = start - 500 - 5 - 5 + 20000 + 20000;
      if (cleared.balance !== expected) throw new CampaignError(`the balance reads ${cleared.balance}, expected ${expected}`, { balance: cleared.balance });
      const intents = await succeededRechargeIntents(ctx, customerId);
      if (intents.length !== 2) throw new CampaignError('Stripe does not hold exactly two succeeded auto-recharge intents for the customer', { intents: intents.map((pi) => pi.id) });
      return {
        org,
        runIds: runs.map((r) => r.id),
        paymentIntentIds: runs.map((r) => r.paymentIntentId),
        firstPurchaseId: first.id,
        secondPurchaseId: second.id,
        pausedAutoRecharge: paused.autoRecharge,
        capMailId: capMail.ID,
        capMailSubject: capMail.Subject,
        startBalance: start,
        balance: cleared.balance,
        rechargedThisMonth: cleared.autoRecharge.rechargedThisMonth
      };
    }
  },
  {
    name: 'a declined card: parked for one retry 24 hours later, the reason shown and mailed',
    path: 'hub routes',
    async run(ctx) {
      const { org, customerId } = need('decline');
      declineT0 = Date.now();
      const set = await setAutoRecharge(ctx, org, { enabled: true, threshold: 4000, credits: 20000, monthlyCap: 40000 }, 'turning auto-recharge on');
      if (set.autoRecharge?.enabled !== true || set.autoRecharge.threshold !== 4000) throw new CampaignError('the account read does not echo the auto-recharge settings', { autoRecharge: set.autoRecharge });
      if (set.balance - 1500 >= 4000) throw new CampaignError('the starting balance is too high for a debit of 1,500 to cross the threshold', { start: set.balance });
      await debit(ctx, org, 1500);
      const parked = await waitAccount(ctx, org, (a) => a.autoRecharge?.disabledReason === 'declined_retrying');
      if (!parked) throw new CampaignError('the account never read disabledReason declined_retrying', { autoRecharge: (await ctx.hub.account(org)).autoRecharge, runs: await ctx.hub.runs(org) });
      if (parked.autoRecharge.enabled !== true) throw new CampaignError('the first decline switched auto-recharge off instead of parking a retry', { autoRecharge: parked.autoRecharge });
      const runs = await ctx.hub.runs(org);
      if (runs.length !== 1 || runs[0].state !== 'retry') throw new CampaignError('the account does not hold exactly one run in state retry', { runs });
      const run = runs[0];
      if (!run.reason) throw new CampaignError('the parked run carries no reason', { run });
      const retryAt = pgTime(run.retryAt);
      const hours = (retryAt - Date.now()) / 3_600_000;
      if (!Number.isFinite(hours) || hours < 23 || hours > 25) throw new CampaignError('the retry is not set between 23 and 25 hours from now', { retryAt: run.retryAt, hours });
      const mail = await ctx.mail.waitFor({ to: ORGS.decline.email, subject: 'Auto-recharge', after: declineT0 }, 60_000);
      if (!mail) throw new CampaignError('no auto-recharge mail reached the billing email', { to: ORGS.decline.email });
      // The hub's words: "one more try tomorrow" in the subject, "We try once more on <date>" in the text.
      if (!/one more try|try once more|retry|try again/i.test(`${mail.Subject}\n${mail.Text ?? ''}`)) throw new CampaignError('the auto-recharge mail does not name a retry', { mailId: mail.ID, subject: mail.Subject, text: (mail.Text ?? '').slice(0, 400) });
      const purchases = await ctx.hub.ledger(org, 'purchase');
      if (purchases.length) throw new CampaignError('the ledger holds a purchase although the card was declined', { purchases });
      let intentStatus = null;
      if (run.paymentIntentId) {
        const intent = await ctx.stripe.paymentIntent(run.paymentIntentId);
        intentStatus = intent.status;
        if (intent.status === 'succeeded') throw new CampaignError('the Stripe intent of the declined run succeeded', { paymentIntentId: intent.id });
      } else {
        ctx.report.note('auto-recharge: the declined run records no payment intent id; the check fell back to the customer having no succeeded auto-recharge intent.');
      }
      const succeeded = await succeededRechargeIntents(ctx, customerId);
      if (succeeded.length) throw new CampaignError('Stripe holds a succeeded auto-recharge intent for the declined customer', { intents: succeeded.map((pi) => pi.id) });
      declineRun = run;
      return {
        org,
        customerId,
        runId: run.id,
        state: run.state,
        reason: run.reason,
        retryAt: run.retryAt,
        retryInHours: Number(hours.toFixed(2)),
        paymentIntentId: run.paymentIntentId || null,
        intentStatus,
        disabledReason: parked.autoRecharge.disabledReason,
        mailId: mail.ID,
        mailSubject: mail.Subject
      };
    }
  },
  {
    name: 'the retry, run by hand, declines again and switches it off with the reason',
    path: 'hub routes',
    async run(ctx) {
      const { org } = need('decline');
      if (!declineRun) throw new CampaignError('the parked run is missing: the declined-card scenario did not complete', {});
      const moved = await ctx.hub.retryNow(org);
      if (!moved.split('\n').includes(declineRun.id)) throw new CampaignError('the parked run could not be brought forward', { runId: declineRun.id, moved });
      const jobId = await ctx.hub.runSweep();
      const off = await waitAccount(ctx, org, (a) => a.autoRecharge?.enabled === false && a.autoRecharge?.disabledReason === 'declined');
      if (!off) throw new CampaignError('auto-recharge did not switch off with the reason declined', { jobId, autoRecharge: (await ctx.hub.account(org)).autoRecharge, runs: await ctx.hub.runs(org) });
      const runs = await ctx.hub.runs(org);
      const theRun = runs.find((r) => r.id === declineRun.id);
      if (theRun?.state !== 'failed') throw new CampaignError('the parked run is not failed after the retry', { runs });
      const live = runs.filter((r) => r.state !== 'failed');
      if (live.length) throw new CampaignError('a run other than a failed one is left on the account', { runs });
      const offSubject = `Auto-recharge is off for ${ORGS.decline.name}`;
      const offMail = await ctx.mail.waitFor({ to: ORGS.decline.email, subject: offSubject, after: declineT0 }, 60_000);
      if (!offMail) throw new CampaignError('no switched-off mail reached the billing email', { to: ORGS.decline.email, subject: offSubject });
      const allMails = await mailsOf(ctx, ORGS.decline.email, 'Auto-recharge', declineT0);
      if (allMails.length !== 2) throw new CampaignError('the billing email did not receive exactly two auto-recharge mails', { mails: allMails.map((m) => ({ id: m.ID, subject: m.Subject })) });
      if ((await ctx.hub.ledger(org, 'purchase')).length) throw new CampaignError('the ledger holds a purchase after the second decline', {});
      const runsBefore = runs.length;
      const late = await debit(ctx, org, 5);
      await sleep(10_000);
      const runsAfter = await ctx.hub.runs(org);
      const purchasesAfter = await ctx.hub.ledger(org, 'purchase');
      if (runsAfter.length !== runsBefore || purchasesAfter.length) {
        throw new CampaignError('a debit after the switch-off started a recharge', { runsBefore, runsAfter, purchases: purchasesAfter.length });
      }
      return {
        org,
        sweepJobId: jobId,
        runId: theRun.id,
        state: theRun.state,
        reason: theRun.reason,
        autoRecharge: off.autoRecharge,
        offMailId: offMail.ID,
        mailIds: allMails.map((m) => m.ID),
        mailSubjects: allMails.map((m) => m.Subject),
        lateDebitEventId: late.id,
        runs: runsAfter.length
      };
    }
  },
  {
    name: 'removing the card switches auto-recharge off with no_payment_method',
    path: 'hub routes',
    async run(ctx) {
      const { org, customerId } = need('once');
      const removed = expectStatus(await ctx.hub.paymentMethodRemove(org), 200, 'DELETE /billing/payment-method').json;
      if (removed.paymentMethod !== null) throw new CampaignError('the account read still shows a card', { paymentMethod: removed.paymentMethod });
      if (removed.autoRecharge?.enabled !== false || removed.autoRecharge?.disabledReason !== 'no_payment_method') {
        throw new CampaignError('auto-recharge is not off with no_payment_method', { autoRecharge: removed.autoRecharge });
      }
      const again = await ctx.hub.autoRecharge(org, { enabled: true });
      if (again.status !== 409 || codeOf(again) !== 'payment_method_missing') {
        throw new CampaignError('turning auto-recharge on without a card was not refused 409 payment_method_missing', { status: again.status, body: again.json ?? again.text.slice(0, 400) });
      }
      const pm = await ctx.stripe.defaultPaymentMethod(customerId);
      if (pm !== null) throw new CampaignError('the Stripe customer still has a default payment method', { customerId, paymentMethodId: pm.id });
      return { org, customerId, autoRecharge: removed.autoRecharge, refusal: { status: again.status, code: codeOf(again) }, stripeDefaultPaymentMethod: null };
    }
  },
  {
    name: 'the settings refuse a cap under one recharge and a recharge under the floor',
    path: 'hub routes',
    async run(ctx) {
      const { org } = need('cap');
      const capRes = await ctx.hub.autoRecharge(org, { credits: 20000, monthlyCap: 10000 });
      if (capRes.status !== 400 || codeOf(capRes) !== 'validation_error' || !capRes.text.includes('monthlyCap')) {
        throw new CampaignError('a cap under one recharge was not refused 400 validation_error naming monthlyCap', { status: capRes.status, body: capRes.json ?? capRes.text.slice(0, 400) });
      }
      const floor = (await ctx.hub.settings()).settings?.customMinCredits;
      const creditsRes = await ctx.hub.autoRecharge(org, { credits: 1 });
      const evidence = {
        org,
        capRefusal: { status: capRes.status, code: codeOf(capRes) },
        floor: floor ?? null,
        creditsAnswer: { status: creditsRes.status, code: codeOf(creditsRes) }
      };
      if (typeof floor !== 'number' || floor <= 1) {
        ctx.report.note(`auto-recharge: the recharge floor reads ${floor ?? 'nothing'} (customMinCredits), so a recharge of 1 credit is not below it; the floor refusal was not judged.`);
        evidence.floorJudged = false;
        return evidence;
      }
      if (creditsRes.status !== 400 || codeOf(creditsRes) !== 'validation_error' || !creditsRes.text.includes('credits')) {
        throw new CampaignError(`a recharge of 1 credit (under the floor ${floor}) was not refused 400 validation_error naming credits`, { status: creditsRes.status, body: creditsRes.json ?? creditsRes.text.slice(0, 400) });
      }
      const after = await ctx.hub.account(org);
      if (after.autoRecharge?.credits === 1 || after.autoRecharge?.monthlyCap === 10000) {
        throw new CampaignError('a refused setting was stored anyway', { autoRecharge: after.autoRecharge });
      }
      evidence.floorJudged = true;
      evidence.storedAutoRecharge = { credits: after.autoRecharge.credits, monthlyCap: after.autoRecharge.monthlyCap };
      return evidence;
    }
  }
];
