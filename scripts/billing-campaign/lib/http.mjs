// The billing campaign: one HTTP client for the pair. Browsers resolve
// `*.localhost` to the loopback on their own; Node does not, so every request
// connects to 127.0.0.1 and carries the hostname the instance was booted with
// as its Host header (the drill's `--resolve`). A cookie jar per client keeps
// the browser sessions the scenarios sign in with.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  take(setCookies) {
    for (const line of setCookies ?? []) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=.*1970/i.test(a));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear() {
    this.cookies.clear();
  }
}

/**
 * One request. `target` is `{ host, port }` of the instance (the Host header
 * and the port), the socket goes to 127.0.0.1. `body` may be a string, a
 * Buffer, or an object (sent as JSON). Answers `{ status, headers, text,
 * json }`, `json` parsed when the body is JSON, else null. Never throws on a
 * status: the scenarios judge it.
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many 429 answers `request` waited out and retried, for a scenario's evidence. */
export const stats = { rateLimitRetries: 0 };

/**
 * One request, retried on a 429 the way a well-behaved client does: the
 * instance's Retry-After (else one second, doubling) up to five times. The
 * campaign drives a hundred organizations as ONE principal, which the hub's
 * per-principal quota rightly slows down; pass `retry429: false` to see the
 * 429 itself.
 */
export async function request(target, opts) {
  const { retry429 = true } = opts;
  for (let attempt = 1; ; attempt += 1) {
    const res = await requestOnce(target, opts);
    if (res.status !== 429 || !retry429 || attempt > 5) return res;
    const after = Number(res.headers['retry-after']);
    const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1);
    stats.rateLimitRetries += 1;
    await sleep(Math.min(waitMs, 30_000));
  }
}

function requestOnce(target, opts) {
  const {
    method = 'GET',
    path,
    headers = {},
    body,
    jar,
    timeoutMs = 60_000,
    socketHost = '127.0.0.1'
  } = opts;
  const h = {
    host: `${target.host}:${target.port}`,
    accept: 'application/json, text/plain, */*',
    ...headers
  };
  let payload = body;
  if (payload !== undefined && typeof payload !== 'string' && !Buffer.isBuffer(payload)) {
    payload = JSON.stringify(payload);
    if (!h['content-type']) h['content-type'] = 'application/json';
  }
  if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
  if (jar && jar.header()) h.cookie = jar.header();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: socketHost, port: target.port, method, path, headers: h, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (jar) jar.take(res.headers['set-cookie']);
          let json = null;
          const ct = String(res.headers['content-type'] ?? '');
          if (
            ct.includes('json') ||
            (text.startsWith('{') && text.endsWith('}')) ||
            (text.startsWith('[') && text.endsWith(']'))
          ) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${path}: no answer in ${timeoutMs} ms`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** The headers of an idempotent create, as the drill sends them. */
export const idempotency = () => ({ 'Idempotency-Key': `campaign-${randomUUID()}` });

/** A multipart/form-data body from fields and files (`{ name, filename, contentType, data }`). */
export function multipart(fields, files) {
  const boundary = `----campaign${randomUUID().replace(/-/g, '')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields ?? {})) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
  }
  for (const f of files ?? []) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`
      )
    );
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A failed expectation, carrying what was answered so the report can print it. */
export class CampaignError extends Error {
  constructor(message, evidence) {
    super(message);
    this.evidence = evidence;
  }
}

/** Throw unless the answer's status is one of `statuses`. Answers the response. */
export function expectStatus(res, statuses, what) {
  const ok = Array.isArray(statuses) ? statuses.includes(res.status) : res.status === statuses;
  if (!ok) {
    throw new CampaignError(`${what}: answered ${res.status}, expected ${statuses}`, {
      status: res.status,
      body: res.json ?? res.text.slice(0, 600)
    });
  }
  return res;
}

/**
 * Poll `probe` until it answers a truthy value or the deadline passes; the
 * value, or null. `every` in ms, `timeoutMs` in ms.
 */
export async function waitFor(probe, { every = 1000, timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(every);
  }
}

/** A ULID-shaped id (the usage event id the hub dedupes on). */
export function ulid(now = Date.now()) {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = now;
  let s = '';
  for (let i = 0; i < 10; i += 1) {
    s = A[t % 32] + s;
    t = Math.floor(t / 32);
  }
  const bytes = randomUUID().replace(/-/g, '');
  for (let i = 0; i < 16; i += 1) s += A[parseInt(bytes.slice(i * 2, i * 2 + 2), 16) % 32];
  return s;
}
