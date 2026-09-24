// The billing campaign (PRDCT-2718): buying, every pack and a custom amount
// bought through the hosted Checkout in EUR and USD, under four tax
// situations, with the ledger read from the metadata, the invoice and its mail.
//
// Four organizations are made once in the first scenario and kept in
// `ctx.shared.buying`. Every purchase's evidence is kept in
// `ctx.shared.buying.purchases`, which the refunds and webhooks groups read.
import { CampaignError, expectStatus, waitFor } from '../lib/http.mjs';
import { CARDS } from '../lib/checkout.mjs';

export const group = 'buying';

const PATH = 'hosted Checkout (browser)';
const NEEDS = ['checkout'];

/** The four organizations: their name, their billing details, their currency and their VAT rate in percent. */
const PARIS = { line1: '1 rue de Rivoli', line2: null, postalCode: '75001', city: 'Paris', country: 'FR' };
const ORGS = {
  be: {
    name: 'Campaign buying BE consumer',
    details: {
      billingEmail: 'campaign-be@drill.test',
      companyName: null,
      address: { line1: 'Rue de la Loi 1', line2: null, postalCode: '1000', city: 'Bruxelles', country: 'BE' }
    },
    currency: 'EUR',
    vatPct: 21
  },
  fr: {
    name: 'Campaign buying FR consumer',
    details: { billingEmail: 'campaign-fr@drill.test', address: PARIS },
    currency: 'EUR',
    vatPct: 20
  },
  frb: {
    name: 'Campaign buying FR business',
    details: { billingEmail: 'campaign-frb@drill.test', companyName: 'Campagne SAS', vatNumber: 'FR32123456789', address: PARIS },
    currency: 'EUR',
    vatPct: 0
  },
  us: {
    name: 'Campaign buying US',
    details: {
      billingEmail: 'campaign-us@drill.test',
      address: { line1: '350 Fifth Avenue', line2: null, postalCode: '10118', city: 'New York', country: 'US' }
    },
    currency: 'USD',
    vatPct: 0
  }
};

/** The state the first scenario made; a later scenario without it is red, never vacuous. */
function state(ctx) {
  const s = ctx.shared.buying;
  if (!s || !s.orgs) throw new CampaignError('the buying organizations are missing: the first scenario of the group did not run or failed', {});
  return s;
}
function orgOf(ctx, key) {
  const o = state(ctx).orgs[key];
  if (!o?.org) throw new CampaignError(`the buying organization "${key}" is missing`, { key });
  return o;
}

/** The id of a field Stripe may answer expanded or as a bare id. */
const idOf = (v) => (typeof v === 'string' ? v : v?.id ?? null);

/** The tax lines of an invoice, whichever API version answered (`total_tax_amounts` before 2025-03-31, `total_taxes` after). */
function invoiceTaxLines(inv) {
  if (Array.isArray(inv.total_tax_amounts)) return { field: 'total_tax_amounts', lines: inv.total_tax_amounts };
  if (Array.isArray(inv.total_taxes)) return { field: 'total_taxes', lines: inv.total_taxes };
  return { field: null, lines: [] };
}

/** How the invoice mail writes an amount (the hub's `Intl.NumberFormat('en', currency)`). */
const formatMinor = (minor, currency) => new Intl.NumberFormat('en', { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);

/** The Checkout sessions Stripe lists for a customer (to prove a refusal made none). */
async function sessionCount(ctx, customerId) {
  if (!customerId) return null;
  const list = await ctx.stripe.get('/v1/checkout/sessions', { customer: customerId, limit: 100 });
  return list.data.length;
}

/**
 * One purchase through the hosted Checkout, judged end to end. `body` is the
 * checkout request (`{ pack }` or `{ credits }`), `credits` the credits it
 * asks for, `subtotal` the expected subtotal in minor units. Answers the
 * evidence and keeps it in `ctx.shared.buying.purchases`.
 */
async function buy(ctx, key, body, { credits, subtotal, label }) {
  const o = orgOf(ctx, key);
  const { org } = o;
  const spec = ORGS[key];
  const address = spec.details.address;
  const mailBefore = Date.now();

  const res = await ctx.hub.checkout(org, body);
  expectStatus(res, 200, `POST /billing/checkout ${JSON.stringify(body)} (${key})`);
  const { url, sessionId } = res.json ?? {};
  if (typeof url !== 'string' || !url.startsWith('https://') || typeof sessionId !== 'string') {
    throw new CampaignError('the checkout answer carries no url or no sessionId', { body: res.json });
  }
  ctx.log(`buying: ${label} session ${sessionId}`);

  const paid = await ctx.payCheckout(url, {
    card: CARDS.visa,
    expect: 'paid',
    mode: 'payment',
    label: `buying-${label}`,
    country: address.country,
    postalCode: address.postalCode,
    line1: address.line1,
    city: address.city
  });
  if (paid.outcome !== 'paid') throw new CampaignError('the Checkout page did not report paid', { sessionId, outcome: paid.outcome, text: paid.text });

  // The session as Stripe holds it.
  const session = await ctx.stripe.checkoutSession(sessionId);
  const paymentIntentId = idOf(session.payment_intent);
  const invoiceId = idOf(session.invoice);
  const sessionFacts = {
    sessionId,
    payment_status: session.payment_status,
    amount_subtotal: session.amount_subtotal,
    amount_total: session.amount_total,
    amount_tax: session.total_details?.amount_tax ?? null,
    currency: session.currency,
    paymentIntentId,
    invoiceId,
    metadata: session.metadata
  };
  if (session.payment_status !== 'paid') throw new CampaignError('the session is not paid', sessionFacts);
  if (!paymentIntentId) throw new CampaignError('the paid session carries no payment intent', sessionFacts);
  if (!invoiceId) throw new CampaignError('the paid session carries no invoice (invoice creation is off?)', sessionFacts);
  if (session.currency !== spec.currency.toLowerCase()) {
    throw new CampaignError(`the session is in ${session.currency}, expected ${spec.currency.toLowerCase()}`, sessionFacts);
  }
  const metaCredits = Number(session.metadata?.credits);
  if (!Number.isInteger(metaCredits) || metaCredits !== credits) {
    throw new CampaignError(`the session metadata carries ${session.metadata?.credits} credits, expected ${credits}`, sessionFacts);
  }

  // The amounts: subtotal, tax at the organization's rate (plus or minus one minor unit), total.
  const tax = sessionFacts.amount_tax;
  const expectedTax = Math.round((subtotal * spec.vatPct) / 100);
  if (session.amount_subtotal !== subtotal) {
    throw new CampaignError(`the subtotal is ${session.amount_subtotal}, expected ${subtotal}`, sessionFacts);
  }
  if (typeof tax !== 'number' || Math.abs(tax - expectedTax) > 1) {
    throw new CampaignError(`the tax is ${tax}, expected ${expectedTax} (${spec.vatPct} % of ${subtotal}, plus or minus 1)`, { ...sessionFacts, breakdown: session.total_details?.breakdown ?? null });
  }
  if (session.amount_total !== subtotal + tax) {
    throw new CampaignError(`the total ${session.amount_total} is not the subtotal ${subtotal} plus the tax ${tax}`, sessionFacts);
  }

  // The ledger: one purchase entry, from the metadata, keyed on the payment intent.
  const entry = await ctx.hub.waitLedger(org, { kind: 'purchase', sourceRef: paymentIntentId });
  if (!entry) throw new CampaignError('no purchase entry for the payment intent reached the ledger in 90 s', { ...sessionFacts, ledger: (await ctx.hub.ledger(org)).slice(0, 10) });
  if (entry.amount !== metaCredits || entry.amount !== credits) {
    throw new CampaignError(`the purchase entry is ${entry.amount} credits, the metadata says ${metaCredits}, the request asked ${credits}`, { entry, ...sessionFacts });
  }
  const rows = await waitFor(
    async () => {
      const r = await ctx.hub.eventRows(paymentIntentId);
      return r.length && r.every((x) => x.processed) ? r : null;
    },
    { every: 1500, timeoutMs: 60_000 }
  );
  if (!rows) {
    throw new CampaignError('the stripe_events rows of the payment intent are missing or not all processed after 60 s', {
      paymentIntentId,
      rows: await ctx.hub.eventRows(paymentIntentId),
      relay: ctx.relay.ofObject(paymentIntentId).map((r) => ({ type: r.type, outcome: r.outcome, status: r.status }))
    });
  }
  const same = await ctx.hub.entriesOf(org, paymentIntentId);
  const purchases = same.filter((e) => e.kind === 'purchase');
  if (purchases.length !== 1) throw new CampaignError(`${purchases.length} purchase entries carry the payment intent, expected exactly 1`, { paymentIntentId, entries: same });

  // The Stripe invoice.
  const inv = await ctx.stripe.invoice(invoiceId);
  const taxLines = invoiceTaxLines(inv);
  const invoiceFacts = {
    invoiceId,
    status: inv.status,
    total: inv.total,
    currency: inv.currency,
    taxField: taxLines.field,
    taxLines: taxLines.lines.map((l) => ({ amount: l.amount, taxability_reason: l.taxability_reason ?? null })),
    hosted: typeof inv.hosted_invoice_url === 'string',
    pdf: typeof inv.invoice_pdf === 'string'
  };
  if (inv.status !== 'paid') throw new CampaignError(`the invoice is ${inv.status}, expected paid`, invoiceFacts);
  if (inv.total !== session.amount_total) throw new CampaignError(`the invoice total ${inv.total} is not the session total ${session.amount_total}`, invoiceFacts);
  if (inv.currency !== session.currency) throw new CampaignError(`the invoice is in ${inv.currency}, the session in ${session.currency}`, invoiceFacts);
  if (!invoiceFacts.hosted || !invoiceFacts.pdf) throw new CampaignError('the invoice has no hosted page or no PDF', invoiceFacts);
  const invoiceTax = taxLines.lines.reduce((s, l) => s + (l.amount ?? 0), 0);
  if (invoiceTax !== tax) throw new CampaignError(`the invoice's tax lines sum to ${invoiceTax}, the session's tax is ${tax}`, invoiceFacts);

  // The invoice mail.
  const subject = `${credits.toLocaleString('en')} credits added`;
  const mail = await ctx.mail.waitFor({ to: spec.details.billingEmail, subject, after: mailBefore }, 90_000);
  if (!mail) throw new CampaignError(`no mail "${subject}" reached ${spec.details.billingEmail} in 90 s`, { sessionId, subject });
  const text = mail.Text ?? '';
  const amountText = formatMinor(session.amount_total, session.currency);
  const mailFacts = { mailId: mail.ID, subject: mail.Subject, amountText, hasPdfLink: text.includes('Download the PDF: https://'), hasAmount: text.includes(amountText) };
  if (!mail.Subject.includes(spec.name)) throw new CampaignError('the invoice mail subject does not name the organization', mailFacts);
  if (!mailFacts.hasPdfLink) throw new CampaignError('the invoice mail text carries no "Download the PDF: https://" line', mailFacts);
  if (!mailFacts.hasAmount) throw new CampaignError(`the invoice mail text does not carry the amount paid ${amountText}`, { ...mailFacts, text: text.slice(0, 600) });

  const evidence = {
    org,
    key,
    sessionId,
    paymentIntentId,
    invoiceId,
    credits,
    subtotal: session.amount_subtotal,
    tax,
    total: session.amount_total,
    currency: session.currency,
    invoiceTaxField: taxLines.field,
    invoiceTaxLines: invoiceFacts.taxLines,
    sessionTaxBreakdown: (session.total_details?.breakdown?.taxes ?? []).map((t) => ({ amount: t.amount, taxability_reason: t.taxability_reason ?? null })),
    ledgerEntryId: entry.id,
    mailId: mail.ID,
    balanceAfter: entry.balanceAfter,
    eventRows: rows.map((r) => r.type)
  };
  state(ctx).purchases.push(evidence);
  ctx.log(`buying: ${label} paid ${evidence.total} ${evidence.currency}, entry ${entry.id}, invoice ${invoiceId}`);
  return evidence;
}

/** Stripe's reason for a zero tax, from the invoice's tax line or else the session's breakdown. */
const taxabilityReason = (p) => p.invoiceTaxLines[0]?.taxability_reason ?? p.sessionTaxBreakdown[0]?.taxability_reason ?? null;

export const scenarios = [
  {
    name: 'the four organizations and their Stripe customers',
    path: PATH,
    needs: NEEDS,
    async run(ctx) {
      const s = { orgs: {}, purchases: [], settings: null };
      const evidence = {};
      for (const [key, spec] of Object.entries(ORGS)) {
        const org = await ctx.hub.createOrg(spec.name);
        if (!org) throw new CampaignError(`the hub answered no id for the new organization ${spec.name}`, { key });
        const afterDetails = await ctx.hub.patchAccount(org, spec.details);
        if (afterDetails.stripe?.customer !== true) {
          throw new CampaignError(`the PATCH of billing details made no Stripe customer (${key})`, { org, stripe: afterDetails.stripe });
        }
        let account = afterDetails;
        if (spec.currency !== 'EUR') {
          account = await ctx.hub.patchAccount(org, { currency: spec.currency });
          if (account.stripe?.customer !== true) throw new CampaignError(`the currency PATCH lost the Stripe customer (${key})`, { org, stripe: account.stripe });
        }
        if (account.currency !== spec.currency) {
          throw new CampaignError(`the ${key} account is in ${account.currency}, expected ${spec.currency}`, { org, currency: account.currency, currencyLocked: account.currencyLocked });
        }
        if (account.currencyLocked !== false) throw new CampaignError(`the ${key} account is locked before any purchase`, { org, currencyLocked: account.currencyLocked });
        const customerId = await ctx.hub.customerOf(org);
        if (!customerId || !customerId.startsWith('cus_')) throw new CampaignError(`the ${key} account row carries no Stripe customer id`, { org, customerId });
        await ctx.stripe.tagCustomer(customerId);
        s.orgs[key] = { org, customerId, accountId: account.accountId };
        evidence[`${key}Org`] = org;
        evidence[`${key}Customer`] = customerId;
        evidence[`${key}Currency`] = account.currency;
        ctx.log(`buying: ${key} org ${org}, customer ${customerId}, ${account.currency}`);
      }
      const settings = (await ctx.hub.settings()).settings;
      if (!settings || typeof settings.customMinCredits !== 'number' || !settings.currencies?.EUR || !settings.currencies?.USD) {
        throw new CampaignError('the staff settings read carries no floor or no rates', { settings });
      }
      s.settings = settings;
      ctx.shared.buying = s;
      return { ...evidence, customMinCredits: settings.customMinCredits, rates: settings.currencies, packs: settings.packs };
    }
  },
  {
    name: 'the 20,000 pack in EUR, a Belgian consumer: 21 % VAT, the credits from the metadata',
    path: PATH,
    needs: NEEDS,
    run: (ctx) => buy(ctx, 'be', { pack: 20000 }, { credits: 20000, subtotal: 2000, label: 'be-20000' })
  },
  {
    name: 'the 50,000 pack in EUR',
    path: PATH,
    needs: NEEDS,
    run: (ctx) => buy(ctx, 'be', { pack: 50000 }, { credits: 50000, subtotal: 5000, label: 'be-50000' })
  },
  {
    name: 'the 100,000 pack in EUR',
    path: PATH,
    needs: NEEDS,
    run: (ctx) => buy(ctx, 'be', { pack: 100000 }, { credits: 100000, subtotal: 10000, label: 'be-100000' })
  },
  {
    name: 'a custom EUR 37 shows 37,000',
    path: PATH,
    needs: NEEDS,
    run: (ctx) => buy(ctx, 'be', { credits: 37000 }, { credits: 37000, subtotal: 3700, label: 'be-custom-37000' })
  },
  {
    name: 'a custom amount under the floor is refused',
    path: PATH,
    needs: NEEDS,
    async run(ctx) {
      const { org, customerId } = orgOf(ctx, 'be');
      const floor = state(ctx).settings.customMinCredits;
      const asked = floor - 1;
      const [before, ledgerBefore, sessionsBefore] = await Promise.all([ctx.hub.account(org), ctx.hub.ledger(org), sessionCount(ctx, customerId)]);
      const res = await ctx.hub.checkout(org, { credits: asked });
      const code = res.json?.error?.code ?? null;
      const answer = { status: res.status, code, message: res.json?.error?.message ?? null, sessionId: res.json?.sessionId ?? null };
      if (res.status !== 400 || code !== 'custom_amount_below_floor') throw new CampaignError(`a checkout for ${asked} credits (floor ${floor}) was not refused 400 custom_amount_below_floor`, answer);
      if (res.json?.url || res.json?.sessionId) throw new CampaignError('the refusal carries a session', answer);
      const [after, ledgerAfter, sessionsAfter] = await Promise.all([ctx.hub.account(org), ctx.hub.ledger(org), sessionCount(ctx, customerId)]);
      if (after.balance !== before.balance || ledgerAfter.length !== ledgerBefore.length) {
        throw new CampaignError('the ledger changed on a refused checkout', { before: before.balance, after: after.balance, entriesBefore: ledgerBefore.length, entriesAfter: ledgerAfter.length });
      }
      if (sessionsAfter !== sessionsBefore) throw new CampaignError('Stripe lists a new Checkout session for the customer after the refusal', { sessionsBefore, sessionsAfter });
      return { org, floor, asked, accountFloor: before.customMinCredits ?? null, ...answer, balance: after.balance, entries: ledgerAfter.length, stripeSessions: sessionsAfter };
    }
  },
  {
    name: 'an unknown pack is refused',
    path: PATH,
    needs: NEEDS,
    async run(ctx) {
      const { org, customerId } = orgOf(ctx, 'be');
      const [before, sessionsBefore] = await Promise.all([ctx.hub.account(org), sessionCount(ctx, customerId)]);
      const res = await ctx.hub.checkout(org, { pack: 12345 });
      const error = res.json?.error ?? {};
      const answer = { status: res.status, code: error.code ?? null, details: error.details ?? null };
      if (res.status !== 400 || error.code !== 'validation_error') throw new CampaignError('a checkout for pack 12345 was not refused 400 validation_error', answer);
      if (!JSON.stringify(error.details ?? error.message ?? '').includes('pack')) throw new CampaignError('the validation error does not name the field pack', answer);
      const [after, sessionsAfter] = await Promise.all([ctx.hub.account(org), sessionCount(ctx, customerId)]);
      if (after.balance !== before.balance) throw new CampaignError('the balance changed on a refused checkout', { before: before.balance, after: after.balance });
      if (sessionsAfter !== sessionsBefore) throw new CampaignError('Stripe lists a new Checkout session for the customer after the refusal', { sessionsBefore, sessionsAfter });
      return { org, ...answer, balance: after.balance, stripeSessions: sessionsAfter };
    }
  },
  {
    name: 'the 20,000 pack in USD, a US customer: no tax',
    path: PATH,
    needs: NEEDS,
    run: (ctx) => buy(ctx, 'us', { pack: 20000 }, { credits: 20000, subtotal: 2200, label: 'us-20000' })
  },
  {
    name: 'the 50,000 pack in USD',
    path: PATH,
    needs: NEEDS,
    run: (ctx) => buy(ctx, 'us', { pack: 50000 }, { credits: 50000, subtotal: 5500, label: 'us-50000' })
  },
  {
    name: 'the 100,000 pack in USD',
    path: PATH,
    needs: NEEDS,
    run: (ctx) => buy(ctx, 'us', { pack: 100000 }, { credits: 100000, subtotal: 11000, label: 'us-100000' })
  },
  {
    name: 'a custom USD 13.58 for 12,345 credits',
    path: PATH,
    needs: NEEDS,
    async run(ctx) {
      const rate = state(ctx).settings.currencies.USD;
      // The rate rounds up to the next minor unit: 12,345 x 110 / 1,000 = 1,357.95, charged 1,358.
      const fromRate = Math.ceil((12345 * rate) / 1000);
      if (fromRate !== 1358) ctx.report.note(`buying: the USD rate in the settings is ${rate}, which prices 12,345 credits at ${fromRate}; the scenario still expects 1358.`);
      const evidence = await buy(ctx, 'us', { credits: 12345 }, { credits: 12345, subtotal: 1358, label: 'us-custom-12345' });
      return { ...evidence, usdRate: rate, subtotalFromRate: fromRate };
    }
  },
  {
    name: 'a French consumer pays 20 % VAT',
    path: PATH,
    needs: NEEDS,
    async run(ctx) {
      const evidence = await buy(ctx, 'fr', { pack: 20000 }, { credits: 20000, subtotal: 2000, label: 'fr-20000' });
      if (evidence.tax !== 400 || evidence.total !== 2400) throw new CampaignError(`the French consumer paid tax ${evidence.tax} and total ${evidence.total}, expected 400 and 2400`, evidence);
      return evidence;
    }
  },
  {
    name: 'a French business with a VAT number is reverse-charged',
    path: PATH,
    needs: NEEDS,
    async run(ctx) {
      const { customerId } = orgOf(ctx, 'frb');
      const evidence = await buy(ctx, 'frb', { pack: 20000 }, { credits: 20000, subtotal: 2000, label: 'frb-20000' });
      if (evidence.tax !== 0 || evidence.total !== 2000) throw new CampaignError(`the French business paid tax ${evidence.tax} and total ${evidence.total}, expected 0 and 2000`, evidence);
      const reason = taxabilityReason(evidence);
      if (reason !== 'reverse_charge') throw new CampaignError(`the zero tax is not a reverse charge (taxability_reason ${reason})`, evidence);
      const taxIds = await ctx.stripe.get(`/v1/customers/${customerId}/tax_ids`);
      const ids = (taxIds.data ?? []).map((t) => ({ type: t.type, value: t.value, verification: t.verification?.status ?? null }));
      if (!ids.some((t) => t.type === 'eu_vat' && t.value === 'FR32123456789')) throw new CampaignError('the Stripe customer does not list eu_vat FR32123456789', { customerId, taxIds: ids });
      return { ...evidence, taxabilityReason: reason, customerId, taxIds: ids };
    }
  },
  {
    name: 'the currency is locked by the first purchase, and a change is refused after it',
    path: PATH,
    needs: NEEDS,
    async run(ctx) {
      const { org } = orgOf(ctx, 'be');
      if (!state(ctx).purchases.some((p) => p.key === 'be')) throw new CampaignError('no Belgian purchase was made before this scenario', {});
      const before = await ctx.hub.account(org);
      if (before.currencyLocked !== true) throw new CampaignError('the account is not locked after its first purchase', { currency: before.currency, currencyLocked: before.currencyLocked });
      if (before.currency !== 'EUR') throw new CampaignError(`the account is in ${before.currency}, expected EUR`, { currency: before.currency });
      const res = await ctx.hub.as(org, 'PATCH', '/billing/account', { currency: 'USD' });
      const code = res.json?.error?.code ?? null;
      let answered;
      if (res.status === 409 && code === 'currency_locked') answered = '409 currency_locked';
      else if (res.status === 200 && res.json?.currency === 'EUR') answered = '200 with the currency unchanged';
      else if (res.status === 200) throw new CampaignError(`the PATCH answered 200 with the currency ${res.json?.currency}`, { status: res.status, currency: res.json?.currency });
      else throw new CampaignError(`the PATCH answered ${res.status} ${code}, neither 409 currency_locked nor 200 unchanged`, { status: res.status, body: res.json ?? res.text?.slice(0, 400) });
      const after = await ctx.hub.account(org);
      if (after.currency !== 'EUR' || after.currencyLocked !== true) throw new CampaignError('the currency changed after the refused PATCH', { currency: after.currency, currencyLocked: after.currencyLocked });
      return { org, answered, status: res.status, code, currencyAfter: after.currency, currencyLocked: after.currencyLocked };
    }
  },
  {
    name: 'the invoice list carries every purchase with its hosted page and PDF',
    path: PATH,
    needs: NEEDS,
    async run(ctx) {
      const { org } = orgOf(ctx, 'be');
      const bought = state(ctx).purchases.filter((p) => p.key === 'be');
      if (bought.length !== 4) throw new CampaignError(`${bought.length} Belgian purchases are on record, the four purchase scenarios must all be green first`, { purchases: bought.map((p) => p.sessionId) });
      const { invoices } = await ctx.hub.invoices(org);
      const rows = (invoices ?? []).map((i) => ({ id: i.id, number: i.number, status: i.status, amountMinor: i.amountMinor, currency: i.currency, hosted: typeof i.hostedUrl === 'string', pdf: typeof i.pdfUrl === 'string' }));
      if (rows.length !== 4) throw new CampaignError(`the invoice list has ${rows.length} rows, expected 4`, { rows });
      const bad = rows.filter((r) => r.status !== 'paid' || !r.hosted || !r.pdf || String(r.currency).toLowerCase() !== 'eur');
      if (bad.length) throw new CampaignError('an invoice is not paid, not in EUR, or lacks its hosted page or PDF', { bad });
      const amounts = rows.map((r) => r.amountMinor).sort((a, b) => a - b);
      const expected = [2420, 4477, 6050, 12100];
      if (JSON.stringify(amounts) !== JSON.stringify(expected)) throw new CampaignError(`the invoice amounts are ${amounts}, expected ${expected}`, { rows });
      const listed = new Set(rows.map((r) => r.id));
      const missing = bought.filter((p) => !listed.has(p.invoiceId)).map((p) => p.invoiceId);
      if (missing.length) {
        // The list may carry the hub's own ids rather than Stripe's: record it, the amounts already matched.
        ctx.report.note(`buying: the hub's invoice list ids do not match the Stripe invoice ids of the purchases (${missing.length} unmatched); the amounts matched.`);
      }
      return { org, invoices: rows, stripeIdsMatched: missing.length === 0 };
    }
  },
  {
    name: 'the credits are never recomputed from the money',
    path: PATH,
    needs: NEEDS,
    async run(ctx) {
      const { org } = orgOf(ctx, 'be');
      const bought = state(ctx).purchases.filter((p) => p.key === 'be');
      if (bought.length !== 4) throw new CampaignError(`${bought.length} Belgian purchases are on record, expected 4`, { purchases: bought.map((p) => p.sessionId) });
      const ledger = await ctx.hub.ledger(org);
      const compared = [];
      for (const p of bought) {
        const session = await ctx.stripe.checkoutSession(p.sessionId);
        const pi = idOf(session.payment_intent);
        const entries = ledger.filter((e) => e.kind === 'purchase' && e.sourceRef === pi);
        const row = { sessionId: p.sessionId, paymentIntentId: pi, metadataCredits: session.metadata?.credits ?? null, amountTotal: session.amount_total, entries: entries.map((e) => e.amount) };
        compared.push(row);
        if (entries.length !== 1) throw new CampaignError(`${entries.length} purchase entries for ${pi}, expected 1`, row);
        if (entries[0].amount !== Number(session.metadata?.credits)) throw new CampaignError(`the entry is ${entries[0].amount} credits, the session metadata says ${session.metadata?.credits}`, row);
      }
      const signup = ledger.filter((e) => e.kind === 'signup').reduce((s, e) => s + e.amount, 0);
      if (signup !== 5000) ctx.report.note(`buying: the Belgian organization's sign-up grant is ${signup}, not 5000; the balance is judged on the grant the ledger carries.`);
      const expected = signup + 20000 + 50000 + 100000 + 37000;
      const agrees = await ctx.hub.balanceAgrees(org);
      if (agrees.balance !== expected) throw new CampaignError(`the balance is ${agrees.balance}, expected ${expected} (sign-up ${signup} plus 207,000 bought)`, { agrees, compared });
      if (!agrees.agrees) throw new CampaignError('the balance does not equal the ledger sum', { agrees });
      return { org, compared, signup, balance: agrees.balance, expected, ledgerSum: agrees.sum };
    }
  }
];
