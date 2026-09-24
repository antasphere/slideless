// The billing campaign (PRDCT-2718): refunds-and-referrals, a refund after
// credits were spent leaves a negative balance the check refuses, and the
// referral reward fires once, on the first purchase, on both sides.
//
// Organizations: R (`Campaign refund`, made through Slideless so the upload
// door can be refused in it), P (`Campaign referrer`) and E (`Campaign
// referee`), both made at the hub. Later, two more: `Campaign referral fresh`
// (registers P's code after the reward) and `Campaign referral late` (buys
// first, then tries to register). Every payment intent and refund id is kept
// in `ctx.shared.refunds` for the webhooks group.
import { CampaignError, expectStatus, waitFor } from '../lib/http.mjs';

export const group = 'refunds-and-referrals';

const EMAILS = {
  R: 'campaign-refund@drill.test',
  P: 'campaign-referrer@drill.test',
  E: 'campaign-referee@drill.test'
};
const ADDRESS = { line1: 'Rue de la Loi 1', postalCode: '1000', city: 'Bruxelles', country: 'BE' };
const VISA = '4242424242424242';
const MIB = 1_048_576;

// The state the scenarios share, in order. A later scenario that finds its
// input missing throws: it never passes on nothing.
const st = {
  R: null, // { org, workspaceId, accountId, key }
  P: null, // { org, accountId }
  E: null, // { org, accountId }
  first: null, // the 20,000 pack of R: { paymentIntentId, chargedMinor, ... }
  balanceAfterSpend: null,
  balanceAfterRefund: null,
  second: null, // the custom 10,000 of R
  referralCode: null,
  referralId: null
};

function need(value, what) {
  if (value === null || value === undefined) {
    throw new CampaignError(`${what} is missing: an earlier scenario of this group did not run or did not finish`, {});
  }
  return value;
}

/** The record the webhooks group reads: every payment intent and every refund this group made. */
function shared(ctx) {
  if (!ctx.shared.refunds) ctx.shared.refunds = { paymentIntents: [], refunds: [] };
  return ctx.shared.refunds;
}

const tagged = new Set();

/**
 * Buy through lane A's Checkout, pay it with the visa card, and wait for the
 * purchase on the ledger. Answers the session id, the payment intent id, the
 * amount Stripe received (tax included) and the ledger entry.
 */
async function buy(ctx, org, body, { label, email }) {
  const res = await ctx.hub.checkout(org, body);
  expectStatus(res, 200, `POST /billing/checkout ${JSON.stringify(body)}`);
  const { url, sessionId } = res.json ?? {};
  if (!url || !sessionId) throw new CampaignError('the checkout answer carries no url or session id', { body: res.json });
  const paid = await ctx.payCheckout(url, { card: VISA, expect: 'paid', mode: 'payment', email, label, ...ADDRESS });
  if (paid.outcome !== 'paid') throw new CampaignError('the Checkout page did not report a payment', { sessionId, outcome: paid.outcome, text: paid.text });
  const session = await waitFor(
    async () => {
      const s = await ctx.stripe.checkoutSession(sessionId);
      return s.payment_status === 'paid' && s.payment_intent && typeof s.payment_intent === 'object' ? s : null;
    },
    { every: 1500, timeoutMs: 60_000 }
  );
  if (!session) throw new CampaignError('the Checkout session never read paid with a payment intent', { sessionId });
  const intent = session.payment_intent;
  const credits = body.pack ?? body.credits;
  const entry = await ctx.hub.waitLedger(org, { kind: 'purchase', sourceRef: intent.id });
  if (!entry) throw new CampaignError('no purchase entry for the payment intent within 90 s', { sessionId, paymentIntentId: intent.id, ledger: (await ctx.hub.ledger(org)).slice(0, 5) });
  if (entry.amount !== credits) throw new CampaignError('the purchase entry is not the credits bought', { paymentIntentId: intent.id, credits, entry });
  const customerId = await ctx.hub.customerOf(org);
  if (customerId && !tagged.has(customerId)) {
    await ctx.stripe.tagCustomer(customerId);
    tagged.add(customerId);
  }
  shared(ctx).paymentIntents.push({ org, label, paymentIntentId: intent.id, amountReceived: intent.amount_received, currency: intent.currency, credits });
  ctx.log(`${label}: ${credits} credits, intent ${intent.id}, ${intent.amount_received} ${intent.currency}`);
  return { sessionId, paymentIntentId: intent.id, chargedMinor: intent.amount_received, currency: intent.currency, entry, customerId };
}

/** The refund entries of one payment intent on the ledger. */
async function refundEntries(ctx, org, paymentIntentId) {
  return (await ctx.hub.entriesOf(org, paymentIntentId)).filter((e) => e.kind === 'refund');
}

/** The `charge.refunded` relay records of one payment intent, optionally the one with this cumulative refunded amount. */
function refundRecords(ctx, paymentIntentId, amountRefunded) {
  return ctx.relay.records.filter((r) => {
    if (r.type !== 'charge.refunded' || !r.body.includes(paymentIntentId)) return false;
    if (amountRefunded === undefined) return true;
    try {
      return JSON.parse(r.body).data.object.amount_refunded === amountRefunded;
    } catch {
      return false;
    }
  });
}

async function registerCode(ctx, org, code) {
  const res = await ctx.hub.referral(org, code);
  return { status: res.status, code: res.json?.error?.code ?? null, body: res.json };
}

function expectRefusal(answer, status, code, what) {
  if (answer.status !== status || answer.code !== code) {
    throw new CampaignError(`${what}: expected ${status} ${code}, answered ${answer.status} ${answer.code ?? ''}`, { answer: answer.body });
  }
}

export const scenarios = [
  {
    name: 'the organizations',
    path: 'hub routes',
    async run(ctx) {
      const r = await ctx.sl.createWorkspace('Campaign refund');
      if (!r.workspaceId || !r.org) throw new CampaignError('the Slideless workspace does not project a hub organization', { r });
      const pOrg = await ctx.hub.createOrg('Campaign referrer');
      const eOrg = await ctx.hub.createOrg('Campaign referee');
      const out = {};
      for (const [side, org, name] of [
        ['R', r.org, 'Campaign refund'],
        ['P', pOrg, 'Campaign referrer'],
        ['E', eOrg, 'Campaign referee']
      ]) {
        const accountId = await ctx.hub.accountIdOf(org);
        if (!accountId) throw new CampaignError(`the organization ${name} has no billing account`, { org });
        const account = await ctx.hub.patchAccount(org, { billingEmail: EMAILS[side], address: ADDRESS });
        if (account.autoRecharge?.enabled) throw new CampaignError(`auto-recharge is on for the new organization ${name}: the arithmetic of this group assumes it off`, { org, autoRecharge: account.autoRecharge });
        out[side] = { org, accountId, balance: account.balance, plan: account.plan, currency: account.currency, referralCode: account.referral?.code ?? null };
      }
      const key = await ctx.sl.createKey(r.workspaceId, 'campaign refunds key');
      if (typeof key !== 'string' || !key.startsWith('slk_')) throw new CampaignError('the key R was given is not an slk_ key', { prefix: String(key).slice(0, 4) });
      st.R = { org: r.org, workspaceId: r.workspaceId, accountId: out.R.accountId, key };
      st.P = { org: pOrg, accountId: out.P.accountId };
      st.E = { org: eOrg, accountId: out.E.accountId };
      const record = shared(ctx);
      record.org = r.org;
      record.workspaceId = r.workspaceId;
      return { R: { ...out.R, workspaceId: r.workspaceId, keyMade: true }, P: out.P, E: out.E };
    }
  },
  {
    name: 'a purchase, then most of it spent',
    path: 'hosted Checkout (browser)',
    needs: ['checkout'],
    async run(ctx) {
      const R = need(st.R, 'organization R');
      const before = await ctx.hub.account(R.org);
      const bought = await buy(ctx, R.org, { pack: 20000 }, { label: 'refund-pack-20000', email: EMAILS.R });
      const afterPurchase = await ctx.hub.account(R.org);
      if (afterPurchase.balance !== before.balance + 20000) {
        throw new CampaignError('the balance after the purchase is not the previous balance plus 20,000', { before: before.balance, after: afterPurchase.balance });
      }
      // Spend down to 2,500 with debit events worth at most 5,000 each.
      const target = 2500;
      const toSpend = afterPurchase.balance - target;
      if (toSpend <= 0 || toSpend % 5 !== 0) throw new CampaignError('the balance after the purchase cannot be spent down to 2,500 in multiples of 5', { balance: afterPurchase.balance });
      const events = [];
      for (let left = toSpend; left > 0; left -= Math.min(5000, left)) events.push(ctx.hub.debitEvent(R.org, Math.min(5000, left)));
      const posted = await ctx.hub.postUsage(events);
      if (posted.accepted !== events.length || posted.results.some((x) => x.status !== 'accepted')) {
        throw new CampaignError('the hub did not accept every debit event', { posted });
      }
      const ids = new Set(events.map((e) => e.id));
      const debits = await waitFor(
        async () => {
          const rows = (await ctx.hub.ledger(R.org, 'debit')).filter((e) => ids.has(e.sourceRef));
          return rows.length === events.length ? rows : null;
        },
        { every: 1500, timeoutMs: 60_000 }
      );
      if (!debits) throw new CampaignError('not every debit event landed on the ledger', { events: events.length, landed: (await ctx.hub.ledger(R.org, 'debit')).filter((e) => ids.has(e.sourceRef)).length });
      const debitSum = debits.reduce((s, e) => s + e.amount, 0);
      if (debitSum !== -toSpend) throw new CampaignError('the debits do not sum to what was spent', { toSpend, debitSum });
      const agrees = await ctx.hub.balanceAgrees(R.org);
      if (!agrees.agrees || agrees.balance !== target) throw new CampaignError('the balance after spending is not 2,500 or does not agree with the ledger', { agrees, target });
      st.first = bought;
      st.balanceAfterSpend = agrees.balance;
      return {
        org: R.org,
        sessionId: bought.sessionId,
        paymentIntentId: bought.paymentIntentId,
        chargedMinor: bought.chargedMinor,
        currency: bought.currency,
        purchaseEntryId: bought.entry.id,
        balanceBefore: before.balance,
        balanceAfterPurchase: afterPurchase.balance,
        debitEvents: events.length,
        debitSum,
        balance: agrees.balance,
        ledgerSum: agrees.sum
      };
    }
  },
  {
    name: 'a full refund takes the whole purchase back and the balance goes negative',
    path: 'Stripe API + hub',
    needs: ['checkout'],
    async run(ctx) {
      const R = need(st.R, 'organization R');
      const first = need(st.first, 'the 20,000 purchase of R');
      const spent = need(st.balanceAfterSpend, 'the balance after spending');
      const refund = await ctx.stripe.refund(first.paymentIntentId);
      if (refund.status !== 'succeeded' && refund.status !== 'pending') throw new CampaignError('Stripe did not accept the full refund', { refundId: refund.id, status: refund.status });
      shared(ctx).refunds.push({ id: refund.id, paymentIntentId: first.paymentIntentId, amountMinor: refund.amount, full: true });
      const entry = await ctx.hub.waitLedger(R.org, { kind: 'refund', amount: -20000, sourceRef: first.paymentIntentId });
      if (!entry) throw new CampaignError('no refund entry of -20,000 for the payment intent within 90 s', { refundId: refund.id, entries: await ctx.hub.entriesOf(R.org, first.paymentIntentId) });
      if (entry.remaining !== null) throw new CampaignError('the refund entry carries a remaining counter', { entry });
      const expected = spent - 20000;
      const agrees = await ctx.hub.balanceAgrees(R.org);
      if (!agrees.agrees || agrees.balance !== expected) throw new CampaignError('the balance after the refund is not the spent balance minus 20,000', { expected, agrees });
      if (agrees.balance >= 0) throw new CampaignError('the balance after the refund is not negative', { agrees });
      st.balanceAfterRefund = agrees.balance;
      return { refundId: refund.id, refundAmountMinor: refund.amount, paymentIntentId: first.paymentIntentId, refundEntryId: entry.id, entryAmount: entry.amount, remaining: entry.remaining, balanceAfter: entry.balanceAfter, balance: agrees.balance, ledgerSum: agrees.sum };
    }
  },
  {
    name: 'the check refuses on a negative balance, on both surfaces',
    path: 'Slideless + hub',
    needs: ['checkout'],
    async run(ctx) {
      const R = need(st.R, 'organization R');
      const balance = need(st.balanceAfterRefund, 'the balance after the refund');
      const check = await ctx.hub.usageCheck(R.org, 'files.upload', MIB);
      if (check.allowed !== false || check.reason !== 'insufficient_credits' || check.balance !== balance || check.credits !== 5) {
        throw new CampaignError('the hub check did not refuse one MiB on the negative balance', { check, balance });
      }
      const upload = await ctx.sl.uploadAsset(R.workspaceId, 'x'.repeat(4096), { key: R.key, label: 'refund-negative' });
      const error = upload.json?.error ?? {};
      if (upload.status !== 402 || error.code !== 'entitlement_denied') {
        throw new CampaignError('Slideless did not refuse the upload with 402 entitlement_denied', { status: upload.status, body: upload.json ?? upload.text.slice(0, 400) });
      }
      const details = error.details ?? {};
      if (details.balance !== balance || typeof details.topUpUrl !== 'string' || details.topUpUrl === '') {
        throw new CampaignError('the Slideless refusal does not carry the negative balance and a top-up link', { details, balance });
      }
      const free = await ctx.hub.usageCheck(R.org, 'presentations.list', 1);
      if (free.allowed !== true || free.priced !== false) throw new CampaignError('an unpriced action is not allowed on the negative balance', { free });
      return {
        hubCheck: { allowed: check.allowed, reason: check.reason, balance: check.balance, credits: check.credits },
        slideless: { status: upload.status, code: error.code, balance: details.balance, credits: details.credits, topUpUrl: details.topUpUrl },
        unpriced: { actionKey: 'presentations.list', allowed: free.allowed, priced: free.priced, credits: free.credits }
      };
    }
  },
  {
    name: 'a second delivery of the same refund changes nothing',
    path: 'webhooks',
    needs: ['checkout'],
    async run(ctx) {
      const R = need(st.R, 'organization R');
      const first = need(st.first, 'the 20,000 purchase of R');
      const record = await ctx.relay.waitProcessed((r) => r.type === 'charge.refunded' && r.body.includes(first.paymentIntentId), { timeoutMs: 30_000 });
      if (!record) {
        throw new CampaignError('no processed charge.refunded for the payment intent at the relay', {
          paymentIntentId: first.paymentIntentId,
          seen: refundRecords(ctx, first.paymentIntentId).map((r) => ({ id: r.id, outcome: r.outcome, status: r.status }))
        });
      }
      const again = await ctx.relay.deliver(record);
      if (again.status !== 200 || again.answer?.outcome !== 'duplicate') throw new CampaignError('the second delivery was not answered duplicate', { eventId: record.id, again });
      const entries = await refundEntries(ctx, R.org, first.paymentIntentId);
      if (entries.length !== 1 || entries[0].amount !== -20000) throw new CampaignError('the payment intent does not carry exactly one refund entry of -20,000', { entries });
      const agrees = await ctx.hub.balanceAgrees(R.org);
      if (!agrees.agrees || agrees.balance !== st.balanceAfterRefund) throw new CampaignError('the balance moved on the second delivery', { expected: st.balanceAfterRefund, agrees });
      return { eventId: record.id, firstOutcome: 'processed', secondOutcome: again.answer.outcome, deliveries: record.deliveries, refundEntries: entries.length, balance: agrees.balance };
    }
  },
  {
    name: 'a partial refund of a second purchase takes the proportional credits, floored, once',
    path: 'hosted Checkout + Stripe API',
    needs: ['checkout'],
    async run(ctx) {
      const R = need(st.R, 'organization R');
      const settings = (await ctx.hub.settings()).settings;
      const credits = Math.max(10000, settings.customMinCredits);
      const before = await ctx.hub.account(R.org);
      const bought = await buy(ctx, R.org, { credits }, { label: `refund-custom-${credits}`, email: EMAILS.R });
      const amount = bought.chargedMinor;
      if (!(amount > 0)) throw new CampaignError('the second purchase received no amount', { bought });
      // First third.
      const r1 = Math.floor(amount / 3);
      const expected1 = Math.floor((credits * r1) / amount);
      const refund1 = await ctx.stripe.refund(bought.paymentIntentId, r1);
      shared(ctx).refunds.push({ id: refund1.id, paymentIntentId: bought.paymentIntentId, amountMinor: r1, full: false });
      const record1 = await ctx.relay.waitProcessed((r) => refundRecords(ctx, bought.paymentIntentId, r1).includes(r));
      if (!record1) throw new CampaignError('the first partial refund was not processed at the relay', { refundId: refund1.id, seen: refundRecords(ctx, bought.paymentIntentId).map((r) => ({ id: r.id, outcome: r.outcome })) });
      const one = await waitFor(
        async () => {
          const e = await refundEntries(ctx, R.org, bought.paymentIntentId);
          return e.length >= 1 ? e : null;
        },
        { every: 1500, timeoutMs: 60_000 }
      );
      if (!one || one.length !== 1 || one[0].amount !== -expected1) throw new CampaignError('the first partial refund entry is not the floored proportion', { r1, amount, expected: -expected1, entries: one });
      // Second third: the cumulative rule.
      const r2 = Math.floor(amount / 3);
      const expectedTotal = Math.floor((credits * (r1 + r2)) / amount);
      const refund2 = await ctx.stripe.refund(bought.paymentIntentId, r2);
      shared(ctx).refunds.push({ id: refund2.id, paymentIntentId: bought.paymentIntentId, amountMinor: r2, full: false });
      const record2 = await ctx.relay.waitProcessed((r) => refundRecords(ctx, bought.paymentIntentId, r1 + r2).includes(r));
      if (!record2) throw new CampaignError('the second partial refund was not processed at the relay', { refundId: refund2.id, seen: refundRecords(ctx, bought.paymentIntentId).map((r) => ({ id: r.id, outcome: r.outcome })) });
      const two = await waitFor(
        async () => {
          const e = await refundEntries(ctx, R.org, bought.paymentIntentId);
          return e.length >= 2 ? e : null;
        },
        { every: 1500, timeoutMs: 60_000 }
      );
      const totalTaken = two ? two.reduce((s, e) => s + e.amount, 0) : null;
      if (!two || two.length !== 2 || totalTaken !== -expectedTotal) {
        throw new CampaignError('the two partial refunds do not total the floored cumulative proportion', { r1, r2, amount, expectedTotal: -expectedTotal, entries: two });
      }
      // The last delivery again.
      const again = await ctx.relay.deliver(record2);
      if (again.status !== 200 || again.answer?.outcome !== 'duplicate') throw new CampaignError('the redelivered second refund was not answered duplicate', { eventId: record2.id, again });
      const after = await refundEntries(ctx, R.org, bought.paymentIntentId);
      if (after.length !== 2) throw new CampaignError('the redelivery wrote another refund entry', { entries: after });
      const agrees = await ctx.hub.balanceAgrees(R.org);
      const expectedBalance = before.balance + credits - expectedTotal;
      if (!agrees.agrees || agrees.balance !== expectedBalance) throw new CampaignError('the balance is not the purchase minus the refunded credits', { expectedBalance, agrees });
      st.second = { ...bought, credits, r1, r2 };
      return {
        paymentIntentId: bought.paymentIntentId,
        credits,
        chargedMinor: amount,
        currency: bought.currency,
        refund1: { id: refund1.id, amountMinor: r1, entry: one[0].amount, eventId: record1.id },
        refund2: { id: refund2.id, amountMinor: r2, entry: two.find((e) => e.id !== one[0].id)?.amount, eventId: record2.id },
        totalTaken,
        redelivery: again.answer.outcome,
        balance: agrees.balance
      };
    }
  },
  {
    name: 'a top-up clears the negative balance and the check passes again',
    path: 'hosted Checkout (browser)',
    needs: ['checkout'],
    async run(ctx) {
      const R = need(st.R, 'organization R');
      const before = await ctx.hub.account(R.org);
      if (before.balance >= 0) throw new CampaignError('the balance before the top-up is not negative: this scenario would prove nothing', { balance: before.balance });
      const bought = await buy(ctx, R.org, { pack: 50000 }, { label: 'refund-pack-50000', email: EMAILS.R });
      const agrees = await ctx.hub.balanceAgrees(R.org);
      if (!agrees.agrees || agrees.balance !== before.balance + 50000 || agrees.balance <= 0) {
        throw new CampaignError('the balance after the top-up is not the previous one plus 50,000, above zero', { before: before.balance, agrees });
      }
      const check = await ctx.hub.usageCheck(R.org, 'files.upload', MIB);
      if (check.allowed !== true || check.balance !== agrees.balance) throw new CampaignError('the check does not allow one MiB after the top-up', { check });
      return { paymentIntentId: bought.paymentIntentId, chargedMinor: bought.chargedMinor, balanceBefore: before.balance, balance: agrees.balance, check: { allowed: check.allowed, credits: check.credits, reason: check.reason } };
    }
  },
  {
    name: 'the referral is registered before the first purchase, and refused for a bad code, one\'s own code, twice, and a ring',
    path: 'hub routes',
    needs: ['checkout'],
    async run(ctx) {
      const P = need(st.P, 'organization P');
      const E = need(st.E, 'organization E');
      const code = (await ctx.hub.account(P.org)).referral?.code;
      if (!code) throw new CampaignError('the referrer organization has no referral code', { org: P.org });
      const unknown = await registerCode(ctx, E.org, 'NOPE00000000');
      expectRefusal(unknown, 404, 'referral_unknown', 'an unknown code');
      const own = await registerCode(ctx, P.org, code);
      expectRefusal(own, 409, 'referral_self', 'one\'s own code');
      const registered = await registerCode(ctx, E.org, code);
      if (registered.status !== 200 || registered.body?.referral?.referredBy !== P.accountId) {
        throw new CampaignError('the referee could not register the referrer\'s code', { answer: registered.body, expected: P.accountId });
      }
      const twice = await registerCode(ctx, E.org, code);
      expectRefusal(twice, 409, 'referral_already_set', 'a second registration');
      const eCode = (await ctx.hub.account(E.org)).referral?.code;
      if (!eCode) throw new CampaignError('the referee organization has no referral code', { org: E.org });
      const ring = await registerCode(ctx, P.org, eCode);
      expectRefusal(ring, 409, 'referral_self', 'a ring (the referrer naming its referee)');
      const row = await ctx.hub.sql(`SELECT id || '|' || state FROM referrals WHERE referee_account_id = '${E.accountId}'`);
      const [referralId, state] = row.split('|');
      if (state !== 'registered') throw new CampaignError('the referrals row is not registered', { row });
      st.referralCode = code;
      st.referralId = referralId;
      return {
        referrerAccountId: P.accountId,
        refereeAccountId: E.accountId,
        unknown: `${unknown.status} ${unknown.code}`,
        self: `${own.status} ${own.code}`,
        registered: { status: registered.status, referredBy: registered.body.referral.referredBy, rewarded: registered.body.referral.rewarded },
        twice: `${twice.status} ${twice.code}`,
        ring: `${ring.status} ${ring.code}`,
        referralId,
        state
      };
    }
  },
  {
    name: 'the first purchase rewards both sides once, and the second rewards nobody',
    path: 'hosted Checkout (browser)',
    needs: ['checkout'],
    async run(ctx) {
      const P = need(st.P, 'organization P');
      const E = need(st.E, 'organization E');
      const referralId = need(st.referralId, 'the registered referral');
      const settings = (await ctx.hub.settings()).settings;
      const refereeCredits = settings.referralRefereeCredits;
      const referrerCredits = settings.referralReferrerCredits;
      if (!(refereeCredits > 0) || !(referrerCredits > 0)) {
        throw new CampaignError('a referral reward is configured at 0 credits: the scenario cannot prove a reward of nothing', { refereeCredits, referrerCredits });
      }
      const bought = await buy(ctx, E.org, { pack: 20000 }, { label: 'referee-pack-20000', email: EMAILS.E });
      const eEntry = await ctx.hub.waitLedger(E.org, { kind: 'referral', amount: refereeCredits, sourceRef: referralId });
      if (!eEntry) throw new CampaignError('no referral entry for the referee', { referralId, ledger: (await ctx.hub.ledger(E.org)).slice(0, 5) });
      const pEntry = await ctx.hub.waitLedger(P.org, { kind: 'referral', amount: referrerCredits, sourceRef: referralId });
      if (!pEntry) throw new CampaignError('no referral entry for the referrer', { referralId, ledger: (await ctx.hub.ledger(P.org)).slice(0, 5) });
      if (settings.promoGrantExpiryDays > 0 && (!eEntry.expiresAt || !pEntry.expiresAt)) {
        throw new CampaignError('a referral entry carries no expiry although promo grants expire', { promoGrantExpiryDays: settings.promoGrantExpiryDays, eEntry, pEntry });
      }
      const account = await ctx.hub.account(E.org);
      if (account.referral?.rewarded !== true) throw new CampaignError('the referee account does not read rewarded', { referral: account.referral });
      const state = await ctx.hub.sql(`SELECT state FROM referrals WHERE id = '${referralId}'`);
      if (state !== 'rewarded') throw new CampaignError('the referrals row is not rewarded', { referralId, state });
      // A second purchase: no second reward on either side.
      const customCredits = Math.max(5000, settings.customMinCredits);
      const second = await buy(ctx, E.org, { credits: customCredits }, { label: `referee-custom-${customCredits}`, email: EMAILS.E });
      const eReferrals = await ctx.hub.ledger(E.org, 'referral');
      const pReferrals = await ctx.hub.ledger(P.org, 'referral');
      if (eReferrals.length !== 1 || pReferrals.length !== 1) {
        throw new CampaignError('the second purchase changed the count of referral entries', { referee: eReferrals.length, referrer: pReferrals.length });
      }
      const eAgrees = await ctx.hub.balanceAgrees(E.org);
      const pAgrees = await ctx.hub.balanceAgrees(P.org);
      if (!eAgrees.agrees || !pAgrees.agrees) throw new CampaignError('a balance disagrees with its ledger', { eAgrees, pAgrees });
      return {
        referralId,
        firstPurchase: { paymentIntentId: bought.paymentIntentId, chargedMinor: bought.chargedMinor },
        referee: { entryId: eEntry.id, amount: eEntry.amount, expiresAt: eEntry.expiresAt },
        referrer: { entryId: pEntry.id, amount: pEntry.amount, expiresAt: pEntry.expiresAt },
        rewarded: account.referral.rewarded,
        rowState: state,
        secondPurchase: { paymentIntentId: second.paymentIntentId, credits: customCredits },
        referralEntries: { referee: eReferrals.length, referrer: pReferrals.length },
        balances: { referee: eAgrees.balance, referrer: pAgrees.balance }
      };
    }
  },
  {
    name: 'after the reward, a new organization may still name the referrer, and the referee stays registered once',
    path: 'hub routes',
    needs: ['checkout'],
    async run(ctx) {
      const E = need(st.E, 'organization E');
      const P = need(st.P, 'organization P');
      const code = need(st.referralCode, 'the referrer\'s code');
      const fresh = await ctx.hub.createOrg('Campaign referral fresh');
      const registered = await registerCode(ctx, fresh, code);
      if (registered.status !== 200 || registered.body?.referral?.referredBy !== P.accountId) {
        throw new CampaignError('a fresh organization could not register the referrer\'s code after the reward', { answer: registered.body });
      }
      const again = await registerCode(ctx, E.org, code);
      expectRefusal(again, 409, 'referral_already_set', 'the rewarded referee registering again');
      const pReferrals = await ctx.hub.ledger(P.org, 'referral');
      if (pReferrals.length !== 1) throw new CampaignError('a registration alone paid the referrer', { referrer: pReferrals.length });
      return { freshOrg: fresh, fresh: { status: registered.status, referredBy: registered.body.referral.referredBy, rewarded: registered.body.referral.rewarded }, referee: `${again.status} ${again.code}`, referrerEntries: pReferrals.length };
    }
  },
  {
    name: 'an organization that bought first is refused a referral',
    path: 'hosted Checkout (browser)',
    needs: ['checkout'],
    async run(ctx) {
      const code = need(st.referralCode, 'the referrer\'s code');
      const late = await ctx.hub.createOrg('Campaign referral late');
      await ctx.hub.patchAccount(late, { billingEmail: 'campaign-referral-late@drill.test', address: ADDRESS });
      const bought = await buy(ctx, late, { pack: 20000 }, { label: 'referral-late-pack-20000', email: 'campaign-referral-late@drill.test' });
      const refused = await registerCode(ctx, late, code);
      expectRefusal(refused, 409, 'referral_after_purchase', 'a registration after a purchase');
      const referrals = await ctx.hub.ledger(late, 'referral');
      if (referrals.length !== 0) throw new CampaignError('the late organization holds a referral entry', { referrals });
      return { org: late, paymentIntentId: bought.paymentIntentId, refusal: `${refused.status} ${refused.code}`, referralEntries: referrals.length };
    }
  }
];
