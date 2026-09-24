// The billing campaign (PRDCT-2718): webhooks, the hub's Stripe door judged on
// replays, reordering, late and forged deliveries, a restart mid-delivery and
// an event kind it does not know.
//
// The group runs after buying, cards, plan, auto-recharge and refunds, so the
// relay's records already hold every event kind the hub handles. The
// purchases this group makes itself go through the Stripe API path
// (`purchaseIntent`), which does not need lane A's checkout.
//
// Every delivery goes through the relay. Its `deliver` re-signs a body whose
// signature is near the door's tolerance unless told `resign: false`, which
// sends the original signature whatever its age: the stale signature
// (scenario 3) and the body that differs from what was signed (scenario 5)
// are sent that way, as a replaying sender would.
import { CampaignError, sleep, waitFor } from '../lib/http.mjs';
import { SIGNATURE_TOLERANCE_S, sign } from '../lib/relay.mjs';

export const group = 'webhooks';

const PATH = 'webhook relay';
const BILLING_EMAIL = 'campaign-webhooks@drill.test';

/** The event types the hub's door dispatches to a handler. */
const HANDLED_TYPES = [
  'checkout.session.completed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted'
];

/** The organization of this group, made once by the first scenario that needs it. */
let setup = null;

// ── helpers ─────────────────────────────────────────────────────────────────

/** An id safe to put inside a single-quoted SQL literal (Stripe and hub ids only). */
function sqlId(value) {
  const s = String(value ?? '');
  if (!/^[A-Za-z0-9_.:-]*$/.test(s)) throw new CampaignError('an id carries characters an SQL literal must not hold', { value: s.slice(0, 80) });
  return s;
}

/** The `Campaign webhooks` organization, its account and its Stripe customer. */
async function ensureOrg(ctx) {
  if (setup) return setup;
  const org = await ctx.hub.createOrg('Campaign webhooks');
  const accountId = await ctx.hub.accountIdOf(org);
  if (!accountId) throw new CampaignError('the new organization has no billing account', { org });
  await ctx.hub.patchAccount(org, { billingEmail: BILLING_EMAIL });
  let customerId = await ctx.hub.customerOf(org);
  let customerPath = 'the hub made it on the PATCH (lane A)';
  if (!customerId) {
    // Without lane A the PATCH makes no Stripe customer. The campaign makes
    // one and writes it on the account row, as the smoke group does.
    const customer = await ctx.stripe.post('/v1/customers', {
      email: BILLING_EMAIL,
      name: 'Campaign webhooks',
      metadata: { accountId, workspaceId: org, lane: ctx.config.lane }
    });
    customerId = customer.id;
    await ctx.hub.sql(`UPDATE billing_accounts SET stripe_customer_id = '${sqlId(customerId)}' WHERE id = '${sqlId(accountId)}'`);
    customerPath = 'made by the campaign at Stripe and written on the account row';
  } else {
    await ctx.stripe.tagCustomer(customerId);
  }
  setup = { org, accountId, customerId, customerPath };
  ctx.shared.webhooks = { ...setup };
  ctx.log(`webhooks: org ${org}, account ${accountId}, customer ${customerId} (${customerPath})`);
  return setup;
}

/** The metadata a Checkout's payment intent carries, for a 20,000 pack in EUR. */
function purchaseMetadata(ctx, s) {
  return { kind: 'purchase', accountId: s.accountId, workspaceId: s.org, userId: ctx.hub.user.id, credits: '20000', currency: 'EUR' };
}

/**
 * Hold every delivery of the group's customer, make one purchase intent, and
 * wait until its `payment_intent.succeeded` sits in the held queue. Answers
 * `{ ...setup, intent, record, t0 }`. The caller unholds and discards in a
 * `finally`.
 */
async function heldIntent(ctx) {
  const s = await ensureOrg(ctx);
  ctx.relay.hold((r) => r.body.includes(s.customerId));
  const t0 = Date.now();
  const intent = await ctx.stripe.purchaseIntent({
    customerId: s.customerId,
    amountMinor: 2000,
    currency: 'EUR',
    metadata: purchaseMetadata(ctx, s)
  });
  if (intent.status !== 'succeeded') throw new CampaignError('the payment intent did not succeed at once', { intentId: intent.id, status: intent.status });
  const record = await waitFor(
    () => ctx.relay.heldRecords((r) => r.type === 'payment_intent.succeeded' && r.body.includes(intent.id))[0] ?? null,
    { every: 500, timeoutMs: 90_000 }
  );
  if (!record) {
    throw new CampaignError('no payment_intent.succeeded for the intent was held by the relay in 90 s', {
      intentId: intent.id,
      seen: ctx.relay.ofObject(intent.id).map((r) => ({ type: r.type, outcome: r.outcome, status: r.status }))
    });
  }
  ctx.log(`webhooks: intent ${intent.id} held as ${record.id}`);
  return { ...s, intent, record, t0 };
}

/** Stop holding and drop what the scenario held for this customer and did not deliver. */
function teardown(ctx, customerId) {
  ctx.relay.unhold();
  if (customerId) ctx.relay.discard((r) => r.body.includes(customerId));
}

/**
 * Wait until the held queue matching `filter` stops growing for `quietMs`
 * (Stripe sends an intent's charge events a moment after the intent's own);
 * answers the held records in arrival order.
 */
async function settleHeld(ctx, filter, { quietMs = 3000, maxMs = 20_000 } = {}) {
  const deadline = Date.now() + maxMs;
  let count = ctx.relay.heldRecords(filter).length;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(500);
    const now = ctx.relay.heldRecords(filter).length;
    if (now !== count) {
      count = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      break;
    }
  }
  return ctx.relay.heldRecords(filter).sort((a, b) => a.n - b.n);
}

/** The purchase entries the ledger holds for one payment intent. */
async function purchasesOf(ctx, org, intentId) {
  return (await ctx.hub.entriesOf(org, intentId)).filter((e) => e.kind === 'purchase');
}

/** Throw unless the hub recorded nothing for the intent: no stripe_events row, no ledger entry. */
async function assertNothingWritten(ctx, org, intentId, what, evidence) {
  const rows = await ctx.hub.eventRows(intentId);
  const entries = await ctx.hub.entriesOf(org, intentId);
  if (rows.length !== 0 || entries.length !== 0) {
    throw new CampaignError(`${what}: the hub wrote something for a refused delivery`, { ...evidence, intentId, eventRows: rows, entries });
  }
  return { eventRows: rows.length, entries: entries.length };
}

/** Throw unless exactly one purchase of 20,000 credits carries the intent id; answers the entry. */
async function assertOnePurchase(ctx, org, intentId, what, evidence) {
  const entry = await ctx.hub.waitLedger(org, { kind: 'purchase', sourceRef: intentId });
  if (!entry) throw new CampaignError(`${what}: no purchase entry for the intent on the ledger`, { ...evidence, intentId });
  const purchases = await purchasesOf(ctx, org, intentId);
  if (purchases.length !== 1) throw new CampaignError(`${what}: ${purchases.length} purchase entries carry the intent, expected 1`, { ...evidence, intentId, purchases });
  if (purchases[0].amount !== 20000) throw new CampaignError(`${what}: the purchase is not 20,000 credits`, { ...evidence, intentId, entry: purchases[0] });
  return purchases[0];
}

/** Throw unless the door answered 400 webhook_signature_invalid. */
function assertSignatureRefused(res, what, evidence) {
  const code = res.json?.error?.code ?? null;
  if (res.status !== 400 || code !== 'webhook_signature_invalid') {
    throw new CampaignError(`${what}: the door answered ${res.status} ${code ?? ''}, expected 400 webhook_signature_invalid`, {
      ...evidence,
      status: res.status,
      answer: res.json ?? res.text?.slice(0, 300)
    });
  }
  return { status: res.status, code };
}

/** The unix second a `t=<unix>,v1=<hex>` signature was made at, or null. */
function signedAt(signature) {
  const m = String(signature ?? '').match(/t=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** The hub account a delivery's object belongs to (its metadata's accountId, else its customer's), or null. */
async function accountOfRecord(ctx, record) {
  let obj = null;
  try {
    obj = JSON.parse(record.body)?.data?.object ?? null;
  } catch {
    obj = null;
  }
  if (!obj) return null;
  const metaAccount = typeof obj.metadata?.accountId === 'string' ? obj.metadata.accountId : '';
  const customer = typeof obj.customer === 'string' ? obj.customer : typeof obj.customer?.id === 'string' ? obj.customer.id : '';
  if (!metaAccount && !customer) return null;
  const clauses = [];
  if (metaAccount && /^[A-Za-z0-9_-]+$/.test(metaAccount)) clauses.push(`id::text = '${metaAccount}'`);
  if (customer && /^[A-Za-z0-9_-]+$/.test(customer)) clauses.push(`stripe_customer_id = '${customer}'`);
  if (!clauses.length) return null;
  const id = await ctx.hub.sql(`SELECT id FROM billing_accounts WHERE ${clauses.join(' OR ')} LIMIT 1`);
  return id || null;
}

/** The hub's state a replay must not move: the ledger's size and sum, the runs, the account row. */
async function snapshot(ctx, accountId) {
  const ledger = await ctx.hub.sql('SELECT count(*) || \'|\' || coalesce(sum(amount), 0) FROM credit_ledger');
  const runs = await ctx.hub.sql('SELECT count(*) FROM auto_recharge_runs');
  const account = accountId
    ? await ctx.hub.sql(
        `SELECT row_to_json(t)::text FROM (SELECT plan, plan_until, payment_method, auto_recharge_enabled, auto_recharge_disabled_reason, balance FROM billing_accounts WHERE id = '${sqlId(accountId)}') t`
      )
    : null;
  return { ledger, runs, account };
}

// ── the scenarios ───────────────────────────────────────────────────────────

export const scenarios = [
  {
    name: 'every handled event kind of this run, delivered a second and a third time, answers duplicate and moves nothing',
    path: PATH,
    async run(ctx) {
      const exercised = [];
      const absent = [];
      for (const type of HANDLED_TYPES) {
        const processed = ctx.relay.records.filter((r) => r.type === type && r.outcome === 'processed');
        if (!processed.length) {
          absent.push(type);
          continue;
        }
        // The sandbox is shared: prefer the last processed record whose object
        // belongs to an account of THIS hub, else the last processed one.
        let record = null;
        let accountId = null;
        for (let i = processed.length - 1; i >= 0; i -= 1) {
          const acc = await accountOfRecord(ctx, processed[i]);
          if (acc) {
            record = processed[i];
            accountId = acc;
            break;
          }
        }
        if (!record) record = processed[processed.length - 1];
        const before = await snapshot(ctx, accountId);
        const first = await ctx.relay.deliver(record);
        const second = await ctx.relay.deliver(record);
        const after = await snapshot(ctx, accountId);
        const row = {
          type,
          eventId: record.id,
          objectId: record.objectId,
          accountId,
          answers: [first, second].map((d) => ({ status: d.status, outcome: d.answer?.outcome ?? null })),
          ledgerBefore: before.ledger,
          ledgerAfter: after.ledger,
          runsBefore: before.runs,
          runsAfter: after.runs
        };
        exercised.push(row);
        const notDuplicate = [first, second].some((d) => d.status !== 200 || d.answer?.outcome !== 'duplicate');
        if (notDuplicate) throw new CampaignError(`a replay of ${type} did not answer 200 duplicate`, { row, absent });
        if (before.ledger !== after.ledger || before.runs !== after.runs || before.account !== after.account) {
          throw new CampaignError(`a replay of ${type} moved the hub's state`, { row, accountBefore: before.account, accountAfter: after.account, absent });
        }
        ctx.log(`webhooks: ${type} ${record.id} replayed twice, duplicate both times`);
      }
      if (exercised.length < 6) {
        throw new CampaignError(`only ${exercised.length} handled types had a processed delivery in this run, at least 6 are needed (did the earlier groups run?)`, {
          exercised: exercised.map((r) => r.type),
          absent
        });
      }
      return { exercisedTypes: exercised.length, absent, exercised };
    }
  },
  {
    name: 'a purchase\'s three events delivered in reverse order land one purchase and one mail',
    path: PATH,
    async run(ctx) {
      const evidence = {};
      // Part 1, the Stripe API path. A raw API intent has no Checkout session
      // and no invoice, so its events are the intent's and the charge's alone.
      let s = null;
      try {
        const h = await heldIntent(ctx);
        s = h;
        const held = await settleHeld(ctx, (r) => r.body.includes(h.intent.id));
        const reversed = held.slice().reverse();
        const released = await ctx.relay.release(reversed);
        ctx.relay.unhold();
        const failed = released.filter((d) => d.status !== 200);
        if (failed.length) throw new CampaignError('a delivery released in reverse order was not answered 200', { intentId: h.intent.id, released });
        const entry = await assertOnePurchase(ctx, h.org, h.intent.id, 'the API path in reverse', { released });
        const rows = await ctx.hub.eventRows(h.intent.id);
        if (!rows.length || rows.some((r) => !r.processed)) throw new CampaignError('the stripe_events rows of the intent are not all processed', { intentId: h.intent.id, rows });
        // No invoice exists on this path, so the hub owes no invoice mail. More
        // than one would be a defect whatever the path.
        const mails = await ctx.mail.find({ subject: 'credits added to Campaign webhooks', after: h.t0 });
        if (mails.length > 1) throw new CampaignError('more than one purchase mail for one intent', { intentId: h.intent.id, mails: mails.map((m) => m.ID) });
        evidence.api = {
          org: h.org,
          customerId: h.customerId,
          customerPath: h.customerPath,
          intentId: h.intent.id,
          heldTypes: held.map((r) => r.type),
          invoiceOrChargeEvents: held.filter((r) => r.type.startsWith('invoice.') || r.type.startsWith('charge.')).map((r) => r.type),
          releasedInOrder: released.map((d) => ({ type: d.type, id: d.id, status: d.status, outcome: d.answer?.outcome ?? null })),
          entryId: entry.id,
          eventRows: rows,
          purchaseMails: mails.length,
          note: 'a raw API intent creates no invoice: the intent\'s events (and its charge\'s) are the whole set, and no invoice mail is owed'
        };
      } finally {
        teardown(ctx, s?.customerId ?? setup?.customerId);
      }

      // Part 2, a real Checkout, only when lane A is merged and the buying
      // group ran (its BE consumer organization and customer exist).
      if (!(ctx.laneA && ctx.shared.buying?.purchases?.length)) {
        evidence.checkout = { ran: false, reason: ctx.laneA ? 'the buying group left no purchases in ctx.shared.buying' : 'lane A\'s checkout is not on this hub' };
        return evidence;
      }
      // The buying group keeps its organizations at `ctx.shared.buying.orgs.be`
      // (`{ org, customerId, accountId }`); the name lookup is the fallback.
      const be = ctx.shared.buying.orgs?.be ?? ctx.shared.buying.be;
      let beOrg = typeof be === 'string' ? be : be?.org ?? be?.id ?? null;
      if (!beOrg) {
        const named = (await ctx.hub.orgs()).filter((o) => o.name === 'Campaign buying BE consumer');
        beOrg = named.length ? named[named.length - 1].id : null;
      }
      if (!beOrg) throw new CampaignError('the buying group ran but its BE consumer organization cannot be found', { buyingKeys: Object.keys(ctx.shared.buying) });
      const beCustomer = (typeof be === 'object' && be?.customerId) || (await ctx.hub.customerOf(beOrg));
      if (!beCustomer) throw new CampaignError('the BE consumer organization has no Stripe customer', { beOrg });
      const beAccount = await ctx.hub.account(beOrg);
      const beEmail = beAccount.billingEmail ?? 'campaign-be@drill.test';
      try {
        ctx.relay.hold((r) => r.body.includes(beCustomer));
        const t0 = Date.now();
        const res = await ctx.hub.checkout(beOrg, { pack: 20000 });
        if (res.status !== 200 || !res.json?.url || !res.json?.sessionId) {
          throw new CampaignError('the checkout of the 20,000 pack was not answered 200 with a url', { beOrg, status: res.status, body: res.json ?? res.text.slice(0, 300) });
        }
        const sessionId = res.json.sessionId;
        await ctx.payCheckout(res.json.url, { expect: 'paid', mode: 'payment', label: 'webhooks-reverse', country: 'BE', postalCode: '1000', line1: 'Rue de la Loi 1', city: 'Bruxelles' });
        const session = await ctx.stripe.checkoutSession(sessionId);
        const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        const invoiceId = typeof session.invoice === 'string' ? session.invoice : session.invoice?.id;
        if (!intentId || !invoiceId) throw new CampaignError('the paid session carries no payment intent or no invoice', { sessionId, intentId, invoiceId, status: session.payment_status });
        const want = [
          ['checkout.session.completed', sessionId],
          ['payment_intent.succeeded', intentId],
          ['invoice.paid', invoiceId]
        ];
        const three = await waitFor(
          () => {
            const found = want.map(([type, id]) => ctx.relay.heldRecords((r) => r.type === type && r.body.includes(id))[0] ?? null);
            return found.every(Boolean) ? found : null;
          },
          { every: 500, timeoutMs: 90_000 }
        );
        if (!three) {
          throw new CampaignError('the three events of the Checkout were not all held within 90 s', {
            sessionId,
            intentId,
            invoiceId,
            held: ctx.relay.heldRecords((r) => r.body.includes(beCustomer)).map((r) => r.type)
          });
        }
        const reversed = three.slice().sort((a, b) => b.n - a.n);
        const released = await ctx.relay.release(reversed);
        // The customer's other held events (invoice.created, charge.succeeded
        // and the like) are delivered after, in arrival order, so nothing is lost.
        const rest = await ctx.relay.release(ctx.relay.heldRecords((r) => r.body.includes(beCustomer)).sort((a, b) => a.n - b.n));
        ctx.relay.unhold();
        const bad = released.filter((d) => d.status !== 200 || d.answer?.outcome !== 'processed');
        if (bad.length) throw new CampaignError('one of the three events released in reverse was not processed', { sessionId, released });
        const purchases = await (async () => {
          await ctx.hub.waitLedger(beOrg, { kind: 'purchase', sourceRef: intentId });
          return purchasesOf(ctx, beOrg, intentId);
        })();
        if (purchases.length !== 1 || purchases[0].amount !== 20000) throw new CampaignError('the reversed Checkout did not land exactly one purchase of 20,000', { intentId, purchases });
        const mail = await ctx.mail.waitFor({ to: beEmail, subject: '20,000 credits added', after: t0 }, 60_000);
        if (!mail) throw new CampaignError('no invoice mail for the reversed Checkout', { intentId, invoiceId, to: beEmail });
        // A second mail would arrive within seconds of the first; wait a
        // moment before counting.
        await sleep(8000);
        const mails = await ctx.mail.find({ to: beEmail, subject: '20,000 credits added', after: t0 });
        if (mails.length !== 1) throw new CampaignError(`${mails.length} invoice mails for one reversed Checkout, expected 1`, { intentId, mails: mails.map((m) => m.ID) });
        const rows = await ctx.hub.eventRows(intentId);
        if (!rows.length || rows.some((r) => !r.processed)) throw new CampaignError('the stripe_events rows of the Checkout intent are not all processed', { intentId, rows });
        evidence.checkout = {
          ran: true,
          beOrg,
          customerId: beCustomer,
          sessionId,
          intentId,
          invoiceId,
          releasedInReverse: released.map((d) => ({ type: d.type, id: d.id, status: d.status, outcome: d.answer?.outcome ?? null })),
          restReleased: rest.map((d) => ({ type: d.type, status: d.status, outcome: d.answer?.outcome ?? null })),
          entryId: purchases[0].id,
          mailId: mails[0].ID,
          eventRows: rows
        };
        return evidence;
      } finally {
        teardown(ctx, beCustomer);
      }
    }
  },
  {
    name: 'a delivery six minutes late is refused on its stale signature and accepted once re-signed the way Stripe retries',
    path: PATH,
    async run(ctx) {
      let h = null;
      try {
        h = await heldIntent(ctx);
        const t = signedAt(h.record.signature);
        if (!t) throw new CampaignError('the held record carries no signature timestamp', { eventId: h.record.id });
        // The one long wait of the group: until the signature is older than
        // the tolerance plus a margin.
        const waitMs = (t + SIGNATURE_TOLERANCE_S + 6) * 1000 - Date.now();
        ctx.log(`webhooks: waiting ${Math.max(0, Math.round(waitMs / 1000))} s for the signature of ${h.record.id} to age past ${SIGNATURE_TOLERANCE_S} s`);
        if (waitMs > 0) await sleep(waitMs);
        const ageS = Math.floor(Date.now() / 1000) - t;
        // The ORIGINAL signature, past the tolerance.
        const staleAnswer = await ctx.relay.deliver(h.record, { resign: false });
        const stale = { status: staleAnswer.status, json: staleAnswer.answer, text: '' };
        if (stale.status === 200) {
          throw new CampaignError('the door accepted a signature older than the tolerance (no timestamp tolerance)', {
            eventId: h.record.id,
            intentId: h.intent.id,
            signatureAgeS: ageS,
            answer: stale.json
          });
        }
        const refused = assertSignatureRefused(stale, 'the stale signature', { eventId: h.record.id, intentId: h.intent.id, signatureAgeS: ageS });
        const nothing = await assertNothingWritten(ctx, h.org, h.intent.id, 'the stale signature', { eventId: h.record.id });
        const [resigned] = await ctx.relay.release([h.record], { resign: true });
        if (resigned.status !== 200 || resigned.answer?.outcome !== 'processed') {
          throw new CampaignError('the re-signed delivery was not processed', { eventId: h.record.id, intentId: h.intent.id, resigned });
        }
        const entry = await assertOnePurchase(ctx, h.org, h.intent.id, 'the re-signed delivery', { eventId: h.record.id });
        return {
          intentId: h.intent.id,
          eventId: h.record.id,
          signatureAgeS: ageS,
          toleranceS: SIGNATURE_TOLERANCE_S,
          staleAnswer: refused,
          afterRefusal: nothing,
          resignedAnswer: { status: resigned.status, outcome: resigned.answer?.outcome ?? null },
          entryId: entry.id,
          credits: entry.amount
        };
      } finally {
        teardown(ctx, h?.customerId ?? setup?.customerId);
      }
    }
  },
  {
    name: 'a tampered signature is refused and writes nothing',
    path: PATH,
    async run(ctx) {
      let h = null;
      try {
        h = await heldIntent(ctx);
        const tampered = await ctx.relay.deliver(h.record, { tamper: true });
        const refused = assertSignatureRefused({ status: tampered.status, json: tampered.answer, text: '' }, 'the tampered signature', { eventId: h.record.id, intentId: h.intent.id });
        const nothing = await assertNothingWritten(ctx, h.org, h.intent.id, 'the tampered signature', { eventId: h.record.id });
        const [good] = await ctx.relay.release([h.record]);
        if (good.status !== 200 || good.answer?.outcome !== 'processed') {
          throw new CampaignError('the untouched delivery after the tampered one was not processed', { eventId: h.record.id, good });
        }
        const entry = await assertOnePurchase(ctx, h.org, h.intent.id, 'the untouched delivery', { eventId: h.record.id });
        return {
          intentId: h.intent.id,
          eventId: h.record.id,
          tamperedAnswer: refused,
          afterRefusal: nothing,
          goodAnswer: { status: good.status, outcome: good.answer?.outcome ?? null },
          entryId: entry.id,
          credits: entry.amount
        };
      } finally {
        teardown(ctx, h?.customerId ?? setup?.customerId);
      }
    }
  },
  {
    name: 'a body that differs from what was signed is refused',
    path: PATH,
    async run(ctx) {
      let h = null;
      try {
        h = await heldIntent(ctx);
        const forged = h.record.body.replace('"20000"', '"99999"');
        if (forged === h.record.body) {
          throw new CampaignError('the held body carries no "20000" to change, so the forgery would prove nothing', { eventId: h.record.id });
        }
        // The original signature over a changed body.
        const forgedAnswer = await ctx.relay.deliver(h.record, { body: forged, resign: false });
        const refused = assertSignatureRefused({ status: forgedAnswer.status, json: forgedAnswer.answer, text: '' }, 'the changed body', { eventId: h.record.id, intentId: h.intent.id });
        const nothing = await assertNothingWritten(ctx, h.org, h.intent.id, 'the changed body', { eventId: h.record.id });
        const [good] = await ctx.relay.release([h.record]);
        if (good.status !== 200 || good.answer?.outcome !== 'processed') {
          throw new CampaignError('the untouched delivery after the changed body was not processed', { eventId: h.record.id, good });
        }
        const entry = await assertOnePurchase(ctx, h.org, h.intent.id, 'the untouched delivery', { eventId: h.record.id });
        const forgedAmount = (await ctx.hub.ledger(h.org, 'purchase')).filter((e) => e.amount === 99999);
        if (forgedAmount.length) throw new CampaignError('a purchase of 99,999 credits is on the ledger', { entries: forgedAmount });
        return {
          intentId: h.intent.id,
          eventId: h.record.id,
          changedBodyAnswer: refused,
          afterRefusal: nothing,
          goodAnswer: { status: good.status, outcome: good.answer?.outcome ?? null },
          entryId: entry.id,
          credits: entry.amount,
          purchasesOf99999: 0
        };
      } finally {
        teardown(ctx, h?.customerId ?? setup?.customerId);
      }
    }
  },
  {
    name: 'a hub restart mid-delivery loses nothing',
    path: PATH,
    async run(ctx) {
      let h = null;
      try {
        h = await heldIntent(ctx);
        // The door's own first statement, written by hand: the state a crash
        // between the insert and the handler's transaction leaves behind.
        // The body goes in a dollar-quoted literal, which needs no escaping.
        const tag = '$campaign$';
        if (h.record.body.includes(tag)) throw new CampaignError('the body carries the dollar-quote tag', { eventId: h.record.id });
        const q = (v) => String(v).replace(/'/g, "''");
        await ctx.hub.sql(
          `INSERT INTO stripe_events (event_id, type, received_at, payload) VALUES ('${q(h.record.id)}', '${q(h.record.type)}', now(), ${tag}${h.record.body}${tag}::jsonb) ON CONFLICT DO NOTHING`
        );
        const before = await ctx.hub.eventRows(h.intent.id);
        if (before.length !== 1 || before[0].processed || before[0].eventId !== h.record.id) {
          throw new CampaignError('the hand-written row is not the one unprocessed row of the intent', { intentId: h.intent.id, rows: before });
        }
        const purchasesBefore = await purchasesOf(ctx, h.org, h.intent.id);
        if (purchasesBefore.length) throw new CampaignError('a purchase exists before the delivery', { purchases: purchasesBefore });
        const t0 = Date.now();
        await ctx.hub.restart();
        const restartMs = Date.now() - t0;
        const [first] = await ctx.relay.release([h.record]);
        if (first.status !== 200 || first.answer?.outcome !== 'processed') {
          throw new CampaignError('the delivery after the restart was not processed', { eventId: h.record.id, first });
        }
        const entry = await assertOnePurchase(ctx, h.org, h.intent.id, 'the delivery after the restart', { eventId: h.record.id });
        const after = await ctx.hub.eventRows(h.intent.id);
        if (after.length !== 1 || !after[0].processed) throw new CampaignError('the row is not processed after the delivery', { intentId: h.intent.id, rows: after });
        const again = await ctx.relay.deliver(h.record);
        if (again.status !== 200 || again.answer?.outcome !== 'duplicate') {
          throw new CampaignError('the delivery once more did not answer duplicate', { eventId: h.record.id, again });
        }
        const purchasesAfter = await purchasesOf(ctx, h.org, h.intent.id);
        if (purchasesAfter.length !== 1) throw new CampaignError('the duplicate delivery changed the purchase count', { purchases: purchasesAfter });
        return {
          intentId: h.intent.id,
          eventId: h.record.id,
          rowBeforeRestart: before[0],
          restartMs,
          firstAnswer: { status: first.status, outcome: first.answer?.outcome ?? null },
          againAnswer: { status: again.status, outcome: again.answer?.outcome ?? null },
          entryId: entry.id,
          credits: entry.amount,
          rowAfter: after[0]
        };
      } finally {
        teardown(ctx, h?.customerId ?? setup?.customerId);
      }
    }
  },
  {
    name: 'an unknown event type is recorded, marked processed and ignored',
    path: PATH,
    async run(ctx) {
      const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const id = `evt_campaign_${suffix}`;
      const objectId = `obj_campaign_${suffix}`;
      const type = 'campaign.unknown_kind';
      const body = JSON.stringify({
        id,
        object: 'event',
        type,
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        data: { object: { id: objectId } }
      });
      const record = { body, signature: sign(body), id, type, objectId, deliveries: 0 };
      const first = await ctx.relay.deliver(record);
      if (first.status !== 200 || first.answer?.outcome !== 'ignored') {
        throw new CampaignError('the unknown event was not answered 200 ignored', { eventId: id, first });
      }
      const second = await ctx.relay.deliver(record);
      if (second.status !== 200 || second.answer?.outcome !== 'duplicate') {
        throw new CampaignError('the unknown event delivered again was not answered 200 duplicate', { eventId: id, second });
      }
      const rows = await ctx.hub.eventRows(objectId);
      if (rows.length !== 1 || !rows[0].processed || rows[0].eventId !== id || rows[0].type !== type) {
        throw new CampaignError('the unknown event is not one processed row', { eventId: id, rows });
      }
      return {
        eventId: id,
        objectId,
        firstAnswer: { status: first.status, outcome: first.answer.outcome, kind: first.answer.kind ?? null },
        secondAnswer: { status: second.status, outcome: second.answer.outcome },
        eventRows: rows
      };
    }
  }
];
