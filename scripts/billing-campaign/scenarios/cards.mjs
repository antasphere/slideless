// The billing campaign (PRDCT-2718): cards, what each test card does on the hosted Checkout and off session.
// Every failure must leave the ledger untouched and say why: on the page for the hosted cases, and in the
// account read's autoRecharge.disabledReason for the off-session cases. Org A buys through Checkout, org B
// saves a card and lets the hub charge it by itself.
import { CampaignError, expectStatus, sleep, waitFor } from '../lib/http.mjs';
import { CARDS } from '../lib/checkout.mjs';

export const group = 'cards';

const ORG_A_NAME = 'Campaign cards checkout';
const ORG_B_NAME = 'Campaign cards saved card';
const EMAIL_A = 'campaign-cards-a@drill.test';
const EMAIL_B = 'campaign-cards-b@drill.test';
const HOUR_MS = 60 * 60 * 1000;

/** The group's shared state, created on first use. */
function state(ctx) {
  if (!ctx.shared.cards) ctx.shared.cards = { intents: {}, tagged: [] };
  return ctx.shared.cards;
}

/** A value an earlier scenario had to leave; a clear red when it is missing. */
function need(ctx, key, from) {
  const value = state(ctx)[key];
  if (!value) throw new CampaignError(`${key} is missing: the scenario "${from}" did not run or did not finish`, { have: Object.keys(state(ctx)) });
  return value;
}

/** Tag the Stripe customer the hub made for an organization, once; answers its id or ''. */
async function tagCustomerOf(ctx, org, fallback = '') {
  const s = state(ctx);
  const customerId = (await ctx.hub.customerOf(org)) || fallback || '';
  if (customerId && !s.tagged.includes(customerId)) {
    await ctx.stripe.tagCustomer(customerId);
    s.tagged.push(customerId);
  }
  return customerId;
}

/** A Postgres timestamptz as text (`2026-09-26 10:00:00.123456+00`) to epoch ms, or NaN. */
function pgTime(text) {
  if (!text) return NaN;
  let iso = text.trim().replace(' ', 'T');
  iso = iso.replace(/(\.\d{3})\d+/, '$1');
  iso = iso.replace(/([+-]\d\d)$/, '$1:00');
  return Date.parse(iso);
}

/** The payment intent id of a Checkout session read from Stripe (expanded or not), or null. */
function intentOf(session) {
  const pi = session?.payment_intent;
  if (!pi) return null;
  return typeof pi === 'object' ? pi.id : pi;
}

/** One 20,000 pack Checkout on an organization; answers `{ url, sessionId }`. */
async function openCheckout(ctx, org, what) {
  const res = await ctx.hub.checkout(org, { pack: 20000 });
  expectStatus(res, 200, `POST /billing/checkout (${what})`);
  if (!res.json?.url || !res.json?.sessionId) throw new CampaignError(`the checkout answer for ${what} carries no url or session id`, { body: res.json });
  return res.json;
}

/**
 * A Checkout paid with a card that must be refused. Proves the page says so, the ledger ids did not move,
 * no payment_intent.succeeded of this customer reached the relay after the click, and the session is unpaid.
 */
async function refusedCheckout(ctx, { card, label, textMatches, what }) {
  const orgA = need(ctx, 'orgA', 'the two organizations');
  const s = state(ctx);
  const idsBefore = (await ctx.hub.ledger(orgA)).map((e) => e.id);
  const checkout = await openCheckout(ctx, orgA, what);
  const t0 = Date.now();
  const paid = await ctx.payCheckout(checkout.url, { card, expect: 'declined', mode: 'payment', email: EMAIL_A, label });
  if (paid.outcome !== 'declined') throw new CampaignError(`the page did not show a refusal for ${what}`, { sessionId: checkout.sessionId, outcome: paid.outcome, url: paid.url });
  if (!textMatches.test(paid.text)) {
    throw new CampaignError(`the page's refusal does not say why (${textMatches})`, { sessionId: checkout.sessionId, text: paid.text });
  }
  await sleep(8000);
  const idsAfter = (await ctx.hub.ledger(orgA)).map((e) => e.id);
  const sameLedger = idsBefore.length === idsAfter.length && idsBefore.every((id, i) => idsAfter[i] === id);
  if (!sameLedger) {
    throw new CampaignError(`the ledger moved after ${what}`, { sessionId: checkout.sessionId, before: idsBefore, after: idsAfter });
  }
  const session = await ctx.stripe.checkoutSession(checkout.sessionId);
  const customerId = await tagCustomerOf(ctx, orgA, typeof session.customer === 'object' ? session.customer?.id : session.customer);
  const intentId = intentOf(session);
  const ids = [customerId, intentId].filter(Boolean);
  if (!ids.length) throw new CampaignError('neither a customer nor a payment intent is known for the session, so the relay cannot be judged', { sessionId: checkout.sessionId });
  // A purchase this group made earlier is not this session's success: its intent ids are left out.
  const earlier = new Set(Object.values(s.intents));
  const succeeded = ctx.relay.records.filter(
    (r) => r.type === 'payment_intent.succeeded' && r.receivedAt > t0 && ids.some((id) => r.body.includes(id)) && !earlier.has(r.objectId)
  );
  if (succeeded.length) {
    throw new CampaignError(`a payment_intent.succeeded reached the relay after ${what}`, {
      sessionId: checkout.sessionId,
      records: succeeded.map((r) => ({ id: r.id, objectId: r.objectId, outcome: r.outcome }))
    });
  }
  if (session.payment_status !== 'unpaid') {
    throw new CampaignError(`the session is not unpaid after ${what}`, { sessionId: checkout.sessionId, paymentStatus: session.payment_status, status: session.status });
  }
  return {
    org: orgA,
    sessionId: checkout.sessionId,
    customerId,
    intentId,
    intentStatus: typeof session.payment_intent === 'object' ? session.payment_intent?.status ?? null : null,
    pageText: paid.text,
    ledgerEntries: idsAfter.length,
    succeededAtRelay: 0,
    paymentStatus: session.payment_status
  };
}

/** Swap org B's default card at Stripe for a test payment method; answers the method's id. */
async function swapCard(ctx, testPm) {
  const customerB = need(ctx, 'customerB', 'a card saved through the setup session');
  const pm = await ctx.stripe.attachTestCard(customerB, testPm);
  const now = await ctx.stripe.defaultPaymentMethod(customerB);
  if (now?.id !== pm.id) throw new CampaignError(`the customer's default card is not ${testPm} after the swap`, { customerB, attached: pm.id, default: now?.id ?? null });
  return pm.id;
}

/** Turn org B's auto-recharge on; answers the account read the route returned. */
async function enable(ctx, orgB, body) {
  const res = await ctx.hub.autoRecharge(orgB, body);
  expectStatus(res, 200, 'PATCH /billing/auto-recharge');
  const ar = res.json?.autoRecharge;
  if (ar?.enabled !== true || ar?.disabledReason !== null) {
    throw new CampaignError('auto-recharge is not on with no reason after the owner turned it on', { autoRecharge: ar });
  }
  return res.json;
}

/** Post one debit on org B and require the hub accepted it; answers the result row. */
async function debit(ctx, orgB, credits) {
  const out = await ctx.hub.postUsage([ctx.hub.debitEvent(orgB, credits)]);
  const row = out.results?.[0];
  if (out.accepted !== 1 || row?.status !== 'accepted') throw new CampaignError(`the hub did not accept the ${credits}-credit debit`, { out });
  return row;
}

/** The ledger's purchases of an organization; red when there is any. */
async function noPurchase(ctx, org, what) {
  const purchases = await ctx.hub.ledger(org, 'purchase');
  if (purchases.length) throw new CampaignError(`the ledger holds a purchase ${what}`, { purchases });
  return 0;
}

export const scenarios = [
  {
    name: 'the two organizations',
    path: 'hub routes',
    async run(ctx) {
      const s = state(ctx);
      s.orgA = await ctx.hub.createOrg(ORG_A_NAME);
      s.orgB = await ctx.hub.createOrg(ORG_B_NAME);
      const a = await ctx.hub.patchAccount(s.orgA, { billingEmail: EMAIL_A });
      const b = await ctx.hub.patchAccount(s.orgB, { billingEmail: EMAIL_B });
      s.accountA = a.accountId;
      s.accountB = b.accountId;
      if (!s.accountA || !s.accountB) throw new CampaignError('an organization has no billing account', { a, b });
      // With lane A merged the PATCH makes the Stripe customers; before it, there is none yet.
      const customerA = await tagCustomerOf(ctx, s.orgA);
      const customerB = await tagCustomerOf(ctx, s.orgB);
      if (customerB) s.customerB = customerB;
      ctx.log(`cards: org A ${s.orgA}, org B ${s.orgB}`);
      return { orgA: s.orgA, orgB: s.orgB, accountA: s.accountA, accountB: s.accountB, balanceA: a.balance, balanceB: b.balance, customerA, customerB };
    }
  },
  {
    name: 'a card that succeeds',
    path: 'hosted Checkout (browser)',
    needs: ['checkout'],
    async run(ctx) {
      const orgA = need(ctx, 'orgA', 'the two organizations');
      const s = state(ctx);
      const before = await ctx.hub.account(orgA);
      const checkout = await openCheckout(ctx, orgA, 'the visa card');
      const paid = await ctx.payCheckout(checkout.url, { card: CARDS.visa, expect: 'paid', mode: 'payment', email: EMAIL_A, label: 'cards-visa' });
      if (paid.outcome !== 'paid') throw new CampaignError('the visa Checkout was not paid', { sessionId: checkout.sessionId, outcome: paid.outcome, text: paid.text });
      const session = await ctx.stripe.checkoutSession(checkout.sessionId);
      const intentId = intentOf(session);
      if (!intentId) throw new CampaignError('the paid session carries no payment intent', { sessionId: checkout.sessionId, paymentStatus: session.payment_status });
      const customerId = await tagCustomerOf(ctx, orgA, typeof session.customer === 'object' ? session.customer?.id : session.customer);
      const entry = await ctx.hub.waitLedger(orgA, { kind: 'purchase', sourceRef: intentId });
      if (!entry) throw new CampaignError('no purchase for the intent on the ledger in 90 s', { intentId, relay: ctx.relay.ofObject(intentId).map((r) => ({ type: r.type, outcome: r.outcome })) });
      if (entry.amount !== 20000) throw new CampaignError('the purchase is not 20,000 credits', { entry });
      const entries = await ctx.hub.entriesOf(orgA, intentId);
      if (entries.length !== 1) throw new CampaignError('the intent has more than one ledger entry', { intentId, entries });
      const after = await ctx.hub.account(orgA);
      if (after.balance !== before.balance + 20000) throw new CampaignError('the balance did not grow by the purchase', { before: before.balance, after: after.balance });
      s.intents.visa = intentId;
      s.customerA = customerId;
      return { org: orgA, sessionId: checkout.sessionId, intentId, customerId, entryId: entry.id, amount: entry.amount, balanceBefore: before.balance, balance: after.balance };
    }
  },
  {
    name: 'a declined card leaves the ledger untouched',
    path: 'hosted Checkout (browser)',
    needs: ['checkout'],
    async run(ctx) {
      return refusedCheckout(ctx, { card: CARDS.declined, label: 'cards-declined', textMatches: /declined/i, what: 'the declined card' });
    }
  },
  {
    name: 'insufficient funds leaves the ledger untouched',
    path: 'hosted Checkout (browser)',
    needs: ['checkout'],
    async run(ctx) {
      return refusedCheckout(ctx, { card: CARDS.insufficientFunds, label: 'cards-insufficient', textMatches: /insufficient funds|declined/i, what: 'the insufficient-funds card' });
    }
  },
  {
    name: '3-D Secure required on session: the challenge completed, the purchase lands',
    path: 'hosted Checkout (browser)',
    needs: ['checkout'],
    async run(ctx) {
      const orgA = need(ctx, 'orgA', 'the two organizations');
      const s = state(ctx);
      const before = await ctx.hub.account(orgA);
      const checkout = await openCheckout(ctx, orgA, 'the 3-D Secure card');
      const paid = await ctx.payCheckout(checkout.url, { card: CARDS.authenticationRequired, expect: '3ds', mode: 'payment', email: EMAIL_A, label: 'cards-3ds' });
      if (paid.outcome !== 'paid') throw new CampaignError('the 3-D Secure Checkout was not paid', { sessionId: checkout.sessionId, outcome: paid.outcome, text: paid.text });
      const challengeShown = paid.challengeShown === true;
      const session = await ctx.stripe.checkoutSession(checkout.sessionId);
      const intentId = intentOf(session);
      if (!intentId) throw new CampaignError('the paid session carries no payment intent', { sessionId: checkout.sessionId, paymentStatus: session.payment_status });
      const entry = await ctx.hub.waitLedger(orgA, { kind: 'purchase', sourceRef: intentId });
      if (!entry) throw new CampaignError('no purchase for the 3-D Secure intent on the ledger in 90 s', { intentId, challengeShown });
      if (entry.amount !== 20000) throw new CampaignError('the purchase is not 20,000 credits', { entry });
      const entries = await ctx.hub.entriesOf(orgA, intentId);
      if (entries.length !== 1) throw new CampaignError('the intent has more than one ledger entry', { intentId, entries });
      const after = await ctx.hub.account(orgA);
      if (after.balance !== before.balance + 20000) throw new CampaignError('the balance did not grow by the purchase', { before: before.balance, after: after.balance });
      s.intents.threeDs = intentId;
      const evidence = { org: orgA, sessionId: checkout.sessionId, intentId, entryId: entry.id, challengeShown, balance: after.balance };
      if (!challengeShown) evidence.note = 'the page never showed a challenge and the payment still landed';
      return evidence;
    }
  },
  {
    name: 'a card saved through the setup session',
    path: 'hosted Checkout (browser)',
    async run(ctx) {
      const orgB = need(ctx, 'orgB', 'the two organizations');
      const s = state(ctx);
      const setup = await ctx.hub.paymentMethodSetup(orgB);
      if (!setup.url || !setup.sessionId) throw new CampaignError('the setup session carries no url', { setup });
      const saved = await ctx.payCheckout(setup.url, { mode: 'setup', card: CARDS.visa, email: EMAIL_B, label: 'cards-setup' });
      if (saved.outcome !== 'paid') throw new CampaignError('the setup Checkout did not complete', { sessionId: setup.sessionId, outcome: saved.outcome, text: saved.text });
      const account = await waitFor(
        async () => {
          const a = await ctx.hub.account(orgB);
          return a.paymentMethod?.brand === 'visa' && a.paymentMethod?.last4 === '4242' ? a : null;
        },
        { every: 1500, timeoutMs: 60_000 }
      );
      if (!account) throw new CampaignError('the account never showed the saved visa 4242', { sessionId: setup.sessionId, paymentMethod: (await ctx.hub.account(orgB)).paymentMethod });
      const customerB = await tagCustomerOf(ctx, orgB);
      if (!customerB) throw new CampaignError('the account shows a card but the hub holds no Stripe customer', { orgB });
      s.customerB = customerB;
      return { org: orgB, sessionId: setup.sessionId, customerId: customerB, paymentMethod: account.paymentMethod };
    }
  },
  {
    name: '3-D Secure required off session: the recharge is refused and switched off with the reason',
    path: 'Stripe API (test payment method) + hub routes',
    async run(ctx) {
      const orgB = need(ctx, 'orgB', 'the two organizations');
      const s = state(ctx);
      const pmId = await swapCard(ctx, 'pm_card_authenticationRequired');
      await enable(ctx, orgB, { enabled: true, threshold: 4000, credits: 20000, monthlyCap: 40000 });
      const before = await ctx.hub.account(orgB);
      if (before.balance - 1500 >= 4000) throw new CampaignError('the debit would not bring org B under the threshold', { balance: before.balance });
      const t0 = Date.now();
      const row = await debit(ctx, orgB, 1500);
      const account = await waitFor(
        async () => {
          const a = await ctx.hub.account(orgB);
          return a.autoRecharge?.enabled === false && a.autoRecharge?.disabledReason === 'authentication_required' ? a : null;
        },
        { every: 1500, timeoutMs: 60_000 }
      );
      if (!account) throw new CampaignError('auto-recharge was not switched off with authentication_required', { autoRecharge: (await ctx.hub.account(orgB)).autoRecharge, runs: await ctx.hub.runs(orgB) });
      const runs = await ctx.hub.runs(orgB);
      if (runs.length !== 1 || runs[0].state !== 'failed' || !/authentication/i.test(runs[0].reason)) {
        throw new CampaignError('org B does not hold exactly one failed run whose reason names authentication', { runs });
      }
      await noPurchase(ctx, orgB, 'after an off-session charge that needed authentication');
      const mail = await ctx.mail.waitFor({ to: EMAIL_B, subject: 'Auto-recharge', after: t0 }, 60_000);
      if (!mail) throw new CampaignError('no Auto-recharge mail to org B after the batch', { to: EMAIL_B, after: t0 });
      s.runIds = runs.map((r) => r.id);
      return {
        org: orgB,
        paymentMethod: pmId,
        eventId: row.id,
        debited: row.credits ?? null,
        balance: account.balance,
        disabledReason: account.autoRecharge.disabledReason,
        runId: runs[0].id,
        runReason: runs[0].reason,
        runIntentId: runs[0].paymentIntentId || null,
        purchases: 0,
        mailSubject: mail.Subject
      };
    }
  },
  {
    name: 'an expired card cannot even be saved; a saved card that declines is parked for one retry, the retry declines and switches it off',
    path: 'Stripe API (test payment method) + hub routes',
    async run(ctx) {
      const orgB = need(ctx, 'orgB', 'the two organizations');
      const earlierRuns = need(ctx, 'runIds', '3-D Secure required off session');
      const s = state(ctx);
      const customerB = need(ctx, 'customerB', 'a card saved through the setup session');
      // Stripe checks a card when it is attached, so an expired card never
      // becomes a card on file: the sandbox refuses pm_card_chargeDeclinedExpiredCard
      // at the attach. That refusal is the first fact; the decline path is then
      // driven with the card Stripe attaches and declines on every charge.
      let expiredRefusal = null;
      try {
        await ctx.stripe.attachTestCard(customerB, 'pm_card_chargeDeclinedExpiredCard');
      } catch (err) {
        expiredRefusal = { status: err.status ?? null, code: err.code ?? null, declineCode: err.declineCode ?? null, message: err.message };
      }
      if (!expiredRefusal) throw new CampaignError('Stripe attached the expired test card: the scenario expected the attach to be refused', { customerB });
      const pmId = await swapCard(ctx, 'pm_card_chargeCustomerFail');
      await enable(ctx, orgB, { enabled: true });
      const t0 = Date.now();
      const row = await debit(ctx, orgB, 5);
      const parked = await waitFor(
        async () => {
          const a = await ctx.hub.account(orgB);
          if (a.autoRecharge?.enabled !== true || a.autoRecharge?.disabledReason !== 'declined_retrying') return null;
          const fresh = (await ctx.hub.runs(orgB)).filter((r) => !earlierRuns.includes(r.id));
          return fresh.length === 1 && fresh[0].state === 'retry' ? { account: a, run: fresh[0] } : null;
        },
        { every: 1500, timeoutMs: 60_000 }
      );
      if (!parked) {
        throw new CampaignError('the declined charge was not parked for a retry with declined_retrying', {
          autoRecharge: (await ctx.hub.account(orgB)).autoRecharge,
          runs: await ctx.hub.runs(orgB)
        });
      }
      if (!parked.run.reason) throw new CampaignError('the parked run carries no reason', { run: parked.run });
      const retryAtMs = pgTime(parked.run.retryAt);
      const hoursAway = (retryAtMs - Date.now()) / HOUR_MS;
      if (!Number.isFinite(hoursAway) || hoursAway < 23 || hoursAway > 25) {
        throw new CampaignError('the retry is not about 24 h away', { retryAt: parked.run.retryAt, hoursAway });
      }
      await ctx.hub.retryNow(orgB);
      const sweepJob = await ctx.hub.runSweep();
      const off = await waitFor(
        async () => {
          const a = await ctx.hub.account(orgB);
          return a.autoRecharge?.enabled === false && a.autoRecharge?.disabledReason === 'declined' ? a : null;
        },
        { every: 1500, timeoutMs: 60_000 }
      );
      if (!off) throw new CampaignError('the declined retry did not switch auto-recharge off with declined', { autoRecharge: (await ctx.hub.account(orgB)).autoRecharge, runs: await ctx.hub.runs(orgB) });
      const runs = await ctx.hub.runs(orgB);
      const run = runs.find((r) => r.id === parked.run.id);
      if (run?.state !== 'failed' || !run?.reason) throw new CampaignError('the parked run did not end failed with a reason', { run, runs });
      await noPurchase(ctx, orgB, 'after two declines of the saved card');
      const offSubject = `Auto-recharge is off for ${ORG_B_NAME}`;
      const offMail = await ctx.mail.waitFor({ to: EMAIL_B, subject: offSubject, after: t0 }, 60_000);
      if (!offMail) throw new CampaignError('no switch-off mail to org B after the retry', { subject: offSubject, after: t0 });
      const mails = await ctx.mail.find({ to: EMAIL_B, subject: 'Auto-recharge', after: t0 });
      if (mails.length !== 2) throw new CampaignError('org B did not receive exactly two auto-recharge mails for the declining card', { subjects: mails.map((m) => m.Subject) });
      s.runIds = runs.map((r) => r.id);
      return {
        org: orgB,
        expiredCardAttach: expiredRefusal,
        paymentMethod: pmId,
        runReason: run.reason,
        eventId: row.id,
        runId: run.id,
        retryAt: parked.run.retryAt,
        hoursAway: Math.round(hoursAway * 100) / 100,
        sweepJob,
        disabledReason: off.autoRecharge.disabledReason,
        mailSubjects: mails.map((m) => m.Subject),
        purchases: 0
      };
    }
  },
  {
    name: 'a good card again: the owner turns it on and the next debit recharges once',
    path: 'Stripe API (test payment method) + hub routes',
    async run(ctx) {
      const orgB = need(ctx, 'orgB', 'the two organizations');
      const s = state(ctx);
      const pmId = await swapCard(ctx, 'pm_card_visa');
      await enable(ctx, orgB, { enabled: true });
      const before = await ctx.hub.account(orgB);
      const row = await debit(ctx, orgB, 5);
      const entry = await ctx.hub.waitLedger(orgB, { kind: 'purchase', amount: 20000 });
      if (!entry) throw new CampaignError('no 20,000-credit recharge on the ledger in 90 s', { runs: await ctx.hub.runs(orgB), autoRecharge: (await ctx.hub.account(orgB)).autoRecharge });
      const settled = await waitFor(
        async () => {
          const a = await ctx.hub.account(orgB);
          return a.autoRecharge?.rechargedThisMonth === 20000 ? a : null;
        },
        { every: 1500, timeoutMs: 30_000 }
      );
      const account = settled ?? (await ctx.hub.account(orgB));
      if (account.autoRecharge?.rechargedThisMonth !== 20000) throw new CampaignError('rechargedThisMonth is not 20,000', { autoRecharge: account.autoRecharge });
      if (account.autoRecharge?.disabledReason !== null) throw new CampaignError('a reason is still set after a successful recharge', { autoRecharge: account.autoRecharge });
      const runs = await ctx.hub.runs(orgB);
      const succeeded = runs.filter((r) => r.state === 'succeeded');
      if (succeeded.length !== 1) throw new CampaignError('org B does not hold exactly one succeeded run', { runs });
      if (succeeded[0].paymentIntentId !== entry.sourceRef) {
        throw new CampaignError('the purchase is not the succeeded run\'s payment intent', { run: succeeded[0], entry });
      }
      const purchases = await ctx.hub.ledger(orgB, 'purchase');
      if (purchases.length !== 1) throw new CampaignError('the ledger holds more than one purchase after one recharge', { purchases });
      s.intents.recharge = entry.sourceRef;
      return {
        org: orgB,
        paymentMethod: pmId,
        eventId: row.id,
        intentId: entry.sourceRef,
        entryId: entry.id,
        runId: succeeded[0].id,
        balanceBefore: before.balance,
        balance: account.balance,
        rechargedThisMonth: account.autoRecharge.rechargedThisMonth,
        disabledReason: account.autoRecharge.disabledReason
      };
    }
  }
];
