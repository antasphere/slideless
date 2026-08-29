// A TCP hop with an adjustable response delay — the federation drill's
// "slow but alive" hub (docker-compose.federation.drill.yml). Deliberately
// dependency-free and run from the Slideless image itself, so the drill
// pulls no third-party image (CI registries throttle; a wedged pull must
// never be the reason the seam test cannot run).
//
//   LISTEN=3300 UPSTREAM_HOST=hub UPSTREAM_PORT=3300 ADMIN=8474 node delay-proxy.mjs
//
// Admin (plain HTTP on ADMIN):  GET /version · GET /latency
//   POST /latency {"ms": 7000}  delay every byte flowing upstream→client by ms
//   DELETE /latency             back to a transparent hop
import net from 'node:net';
import http from 'node:http';

const LISTEN = Number(process.env.LISTEN ?? 3300);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST ?? 'hub';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 3300);
const ADMIN = Number(process.env.ADMIN ?? 8474);
let latencyMs = 0;

const proxy = net.createServer((client) => {
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.pipe(upstream);
  // Downstream: hold each chunk for the configured delay, in order.
  let chain = Promise.resolve();
  upstream.on('data', (chunk) => {
    const ms = latencyMs;
    chain = chain.then(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            if (!client.destroyed) client.write(chunk);
            resolve();
          }, ms);
        })
    );
  });
  upstream.on('end', () => {
    chain.then(() => {
      if (!client.destroyed) client.end();
    });
  });
  client.on('close', () => upstream.destroy());
});
proxy.listen(LISTEN, '0.0.0.0');

http
  .createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/version')
      return json(200, { version: 'delay-proxy 1', latencyMs });
    if (req.method === 'GET' && req.url === '/latency') return json(200, { latencyMs });
    if (req.method === 'DELETE' && req.url === '/latency') {
      latencyMs = 0;
      return json(200, { latencyMs });
    }
    if (req.method === 'POST' && req.url === '/latency') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          const ms = Number(JSON.parse(raw).ms);
          if (!Number.isFinite(ms) || ms < 0) throw new Error('ms');
          latencyMs = ms;
          json(200, { latencyMs });
        } catch {
          json(400, { error: 'body must be {"ms": <non-negative number>}' });
        }
      });
      return;
    }
    json(404, { error: 'not_found' });
  })
  .listen(ADMIN, '0.0.0.0');

console.log(`delay-proxy: ${LISTEN} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}, admin :${ADMIN}`);
