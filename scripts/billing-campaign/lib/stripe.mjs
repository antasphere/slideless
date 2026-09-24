// The billing campaign: the Stripe API in test mode, form-encoded over
// HTTPS with the sandbox key, no SDK (Slideless carries no Stripe
// dependency and never will: self-hosted never collects money). Every
// object the campaign creates itself carries `metadata[lane]`.
import { config } from './config.mjs';
import { sleep } from './http.mjs';

const API = 'https://api.stripe.com';

/** Flatten `{ a: { b: 1 }, c: [x, y] }` into Stripe's form keys (`a[b]=1`, `c[0]=x`). */
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? formEncode(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export class StripeError extends Error {
  constructor(status, body) {
    super(`Stripe answered ${status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
    this.code = body?.error?.code ?? null;
    this.declineCode = body?.error?.decline_code ?? null;
  }
}

export class Stripe {
  constructor(key = config.stripeKey, lane = config.lane) {
    this.key = key;
    this.lane = lane;
  }
  async call(method, path, params, { idempotencyKey } = {}) {
    const headers = { authorization: `Basic ${Buffer.from(`${this.key}:`).toString('base64')}` };
    let body;
    if (method !== 'GET' && params) {
      body = formEncode(params).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const url = method === 'GET' && params ? `${API}${path}?${formEncode(params)}` : `${API}${path}`;
    for (let attempt = 1; ; attempt += 1) {
      const res = await fetch(url, { method, headers, body });
      const json = await res.json().catch(() => ({}));
      if (res.status === 429 && attempt < 6) {
        await sleep(500 * attempt);
        continue;
      }
      if (!res.ok) throw new StripeError(res.status, json);
      return json;
    }
  }
  get(path, params) {
    return this.call('GET', path, params);
  }
  post(path, params, opts) {
    return this.call('POST', path, params, opts);
  }
  del(path) {
    return this.call('DELETE', path);
  }

  // ── customers and payment methods ──────────────────────────────────────────
  customer(id) {
    return this.get(`/v1/customers/${id}`, { 'expand[0]': 'invoice_settings.default_payment_method' });
  }
  /** Tag a customer the hub created with this lane (the shared sandbox's rule). */
  tagCustomer(id) {
    return this.post(`/v1/customers/${id}`, { metadata: { lane: this.lane } });
  }
  /**
   * Attach one of Stripe's test payment methods (`pm_card_visa`,
   * `pm_card_chargeCustomerFail`, `pm_card_chargeDeclinedExpiredCard`,
   * `pm_card_authenticationRequired`, …) to a customer and make it the
   * default the hub charges off-session. Answers the attached method.
   */
  async attachTestCard(customerId, testPm = 'pm_card_visa') {
    const pm = await this.post(`/v1/payment_methods/${testPm}/attach`, { customer: customerId });
    await this.post(`/v1/customers/${customerId}`, { invoice_settings: { default_payment_method: pm.id } });
    return pm;
  }
  /** The customer's default payment method (the object), or null. */
  async defaultPaymentMethod(customerId) {
    const c = await this.customer(customerId);
    const pm = c.invoice_settings?.default_payment_method;
    return pm && typeof pm === 'object' ? pm : null;
  }

  // ── payment intents (the API path of a purchase) ──────────────────────────
  /**
   * A purchase paid through the API instead of the hosted page: a payment
   * intent confirmed at once with a test payment method, carrying exactly the
   * metadata a Checkout's payment intent carries (`kind`, `accountId`,
   * `workspaceId`, `userId`, `credits`, `currency`), so the hub's
   * `payment_intent.succeeded` handler writes the purchase from it. Throws a
   * StripeError with the decline code on a refused card.
   */
  purchaseIntent({ customerId, amountMinor, currency, metadata, paymentMethod = 'pm_card_visa', idempotencyKey }) {
    return this.post(
      '/v1/payment_intents',
      {
        amount: amountMinor,
        currency: currency.toLowerCase(),
        ...(customerId ? { customer: customerId } : {}),
        payment_method: paymentMethod,
        confirm: true,
        off_session: true,
        description: `${metadata.credits} Antasphere credits (campaign)`,
        metadata: { ...metadata, lane: this.lane }
      },
      { idempotencyKey }
    );
  }
  paymentIntent(id) {
    return this.get(`/v1/payment_intents/${id}`);
  }
  refund(paymentIntentId, amountMinor) {
    return this.post('/v1/refunds', { payment_intent: paymentIntentId, ...(amountMinor ? { amount: amountMinor } : {}), metadata: { lane: this.lane } });
  }

  // ── checkout sessions, invoices, subscriptions ────────────────────────────
  checkoutSession(id) {
    return this.get(`/v1/checkout/sessions/${id}`, { 'expand[0]': 'payment_intent', 'expand[1]': 'invoice', 'expand[2]': 'total_details.breakdown' });
  }
  invoice(id) {
    return this.get(`/v1/invoices/${id}`);
  }
  invoices(customerId, limit = 20) {
    return this.get('/v1/invoices', { customer: customerId, limit });
  }
  subscription(id) {
    return this.get(`/v1/subscriptions/${id}`);
  }
  subscriptions(customerId) {
    return this.get('/v1/subscriptions', { customer: customerId, status: 'all', limit: 20 });
  }
  updateSubscription(id, params) {
    return this.post(`/v1/subscriptions/${id}`, params);
  }

  // ── test clocks ───────────────────────────────────────────────────────────
  /** The test clock of a customer (the hub creates every customer on one when STRIPE_TEST_CLOCKS is on). */
  async clockOf(customerId) {
    const c = await this.get(`/v1/customers/${customerId}`);
    const id = typeof c.test_clock === 'object' ? c.test_clock?.id : c.test_clock;
    if (!id) throw new Error(`customer ${customerId} is on no test clock (was the hub booted with STRIPE_TEST_CLOCKS=true?)`);
    return this.get(`/v1/test_helpers/test_clocks/${id}`);
  }
  /**
   * Advance a customer's clock by `seconds` and wait until Stripe has
   * processed it (`status: ready`); the renewals and their webhooks fire
   * meanwhile. Answers the clock.
   */
  async advanceClock(customerId, seconds, timeoutMs = 180_000) {
    const clock = await this.clockOf(customerId);
    const target = clock.frozen_time + seconds;
    await this.post(`/v1/test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: target });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = await this.get(`/v1/test_helpers/test_clocks/${clock.id}`);
      if (c.status === 'ready' && c.frozen_time >= target) return c;
      if (c.status === 'internal_failure') throw new Error(`test clock ${clock.id} failed to advance`);
      if (Date.now() > deadline) throw new Error(`test clock ${clock.id} not ready after ${timeoutMs} ms`);
      await sleep(2000);
    }
  }

  // ── events ────────────────────────────────────────────────────────────────
  /** The sandbox's recent events of one type, newest first. */
  events({ type, limit = 100, createdAfter }) {
    return this.get('/v1/events', { ...(type ? { type } : {}), limit, ...(createdAfter ? { 'created[gte]': Math.floor(createdAfter / 1000) } : {}) });
  }
  event(id) {
    return this.get(`/v1/events/${id}`);
  }
}
