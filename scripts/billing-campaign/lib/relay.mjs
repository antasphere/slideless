// The billing campaign: the webhook relay. `stripe listen` forwards every
// sandbox event here; the relay forwards it to the pair's hub and records
// the delivery with the hub's answer. A scenario may HOLD deliveries and
// release them in the order it wants, deliver one twice, tamper its
// signature, or deliver it late: the relay re-signs a held body with the
// listen secret (the same HMAC Stripe uses, `t=<unix>,v1=<hex>` over
// `${t}.${body}`) when the original signature is older than the door's
// tolerance, the way Stripe signs a retry. The sandbox is shared with the
// other lanes' pairs, so the relay also sees THEIR events; the scenarios
// filter on their own ids.
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { config } from './config.mjs';
import { request, waitFor } from './http.mjs';

/** Stripe's signature header for a body, with the listen secret. */
export function sign(body, secret = config.webhookSecret, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Stripe's default tolerance on the signature's timestamp, in seconds. */
export const SIGNATURE_TOLERANCE_S = 300;

let seq = 0;

export class Relay {
  constructor({ port = config.relayPort, hub = config.hub } = {}) {
    this.port = port;
    this.hub = hub;
    /** Every delivery seen, in order: `{ n, id, type, body, signature, receivedAt, outcome, status, answer, heldBy }`. */
    this.records = [];
    this.held = null; // a Set of predicates while holding, else null
    this.queue = []; // held records
    this.server = null;
    this.listeners = new Set();
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        const record = {
          n: (seq += 1),
          id: parsed?.id ?? null,
          type: parsed?.type ?? null,
          objectId: parsed?.data?.object?.id ?? null,
          body,
          signature: req.headers['stripe-signature'] ?? '',
          receivedAt: Date.now(),
          outcome: null,
          status: null,
          answer: null,
          deliveries: 0
        };
        this.records.push(record);
        const hold = this.held && [...this.held].some((p) => p(record));
        if (hold) {
          record.outcome = 'held';
          this.queue.push(record);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"held":true}');
        } else {
          this.deliver(record)
            .then((r) => {
              res.writeHead(r.status, { 'content-type': 'application/json' });
              res.end(JSON.stringify(r.answer ?? {}));
            })
            .catch((err) => {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ relay: String(err?.message ?? err) }));
            });
        }
        for (const l of this.listeners) l(record);
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
    return this;
  }

  async stop() {
    if (this.server) await new Promise((r) => this.server.close(r));
  }

  /**
   * Deliver one record to the hub. `resign` left undefined re-signs the body
   * only when the original signature is near the door's tolerance (the way
   * Stripe signs a retry); `true` forces a fresh signature; `false` sends the
   * ORIGINAL signature whatever its age (the stale-signature proof). `tamper`
   * sends a signature that does not verify, `body` replaces the bytes (a body
   * that differs from what was signed; with `resign: false` the original
   * signature no longer covers it). Answers `{ status, answer }` and records
   * the outcome on the record.
   */
  async deliver(record, { resign, tamper = false, body } = {}) {
    const bytes = body ?? record.body;
    const age = Math.floor(Date.now() / 1000) - Number((record.signature.match(/t=(\d+)/) ?? [])[1] ?? 0);
    let signature = record.signature;
    const fresh = resign === true || (resign === undefined && (body !== undefined || age > SIGNATURE_TOLERANCE_S - 30));
    if (fresh) signature = sign(bytes);
    if (tamper) signature = `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`;
    const res = await request(this.hub, {
      method: 'POST',
      path: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: bytes,
      timeoutMs: 120_000
    });
    record.deliveries += 1;
    record.status = res.status;
    record.answer = res.json ?? res.text.slice(0, 300);
    record.outcome = res.json?.outcome ?? (res.status === 200 ? 'ok' : `http_${res.status}`);
    record.lastDeliveredAt = Date.now();
    return { status: res.status, answer: record.answer };
  }

  /** Hold every incoming delivery matching `predicate` (default: all) instead of forwarding it. */
  hold(predicate = () => true) {
    if (!this.held) this.held = new Set();
    this.held.add(predicate);
    return predicate;
  }
  /** Stop holding (all predicates, or one); the queue stays until released. */
  unhold(predicate) {
    if (!this.held) return;
    if (predicate) this.held.delete(predicate);
    else this.held.clear();
    if (this.held.size === 0) this.held = null;
  }
  /** The held records (a copy). */
  heldRecords(filter = () => true) {
    return this.queue.filter(filter);
  }
  /**
   * Release held records in the given order (default: the order received),
   * each delivered once; `opts` per delivery. Answers the outcomes.
   */
  async release(records = this.queue.slice(), opts = {}) {
    const out = [];
    for (const r of records) {
      const i = this.queue.indexOf(r);
      if (i >= 0) this.queue.splice(i, 1);
      out.push({ id: r.id, type: r.type, ...(await this.deliver(r, opts)) });
    }
    return out;
  }
  /** Drop held records without delivering them (a scenario's teardown). */
  discard(filter = () => true) {
    this.queue = this.queue.filter((r) => !filter(r));
  }

  /** Wait for a delivery (held or forwarded) matching `predicate`; the record or null. */
  waitFor(predicate, timeoutMs = 90_000) {
    return waitFor(() => this.records.find(predicate) ?? null, { every: 500, timeoutMs });
  }
  /** Wait until a matching delivery was forwarded and the hub answered `outcome` (default `processed`). */
  async waitProcessed(predicate, { timeoutMs = 90_000, outcome = 'processed' } = {}) {
    return waitFor(
      () => this.records.find((r) => predicate(r) && r.outcome === outcome) ?? null,
      { every: 500, timeoutMs }
    );
  }
  /** The records of one Stripe object (a payment intent, an invoice, a subscription), in order. */
  ofObject(objectId) {
    return this.records.filter((r) => r.objectId === objectId || r.body.includes(`"${objectId}"`));
  }
}
