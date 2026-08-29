# Reverse proxy (TLS)

TLS terminates at a reverse proxy in front of the app — documented, not
bundled. Caddy is the recommended proxy: automatic Let's Encrypt, two lines
of config.

## Caddy

```bash
sudo apt install -y caddy    # or: docker run caddy (see below)
```

`/etc/caddy/Caddyfile`:

```caddyfile
slides.example.com {
    reverse_proxy localhost:3000
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }
}
```

`sudo systemctl reload caddy` — certificates are issued automatically.

Then in the instance's `.env`:

```bash
PUBLIC_BASE_URL=https://slides.example.com   # https ⇒ Secure cookies
TRUST_PROXY=true                               # trust Caddy's x-forwarded-for
```

and `docker compose up -d`. With the proxy in place, close port 3000 to the
outside (`sudo ufw delete allow 3000/tcp`) so all traffic flows through TLS.

Notes:

- **HSTS lives at the proxy** (above), where TLS terminates. The app already
  sends `nosniff`, `Referrer-Policy`, and a CSP on HTML.
- **`TRUST_PROXY=true` only behind a proxy you control.** The app reads the
  **rightmost** `x-forwarded-for` hop — the one your proxy sets. No Caddyfile
  directive is needed: Caddy ≥2.5 discards client-supplied `X-Forwarded-*` by
  default and sets the header to the real peer. Do **not** add a
  `trusted_proxies` range covering untrusted clients, or the client-claimed
  value would be preserved and become the rightmost hop.
- **Chained proxies (CDN → Caddy):** the app reads the hop Caddy appended,
  i.e. the CDN's egress IP. Either accept edge-IP keying or strip/normalize
  `X-Forwarded-For` at the outermost hop so the real client IP lands rightmost.
- WebSockets and streaming (file downloads, MCP) proxy transparently; no
  extra config.

## Optional: a dedicated user-content origin (`VIEWER_BASE_URL`)

The share-link viewer hardening
([viewer-security-model.md](../security/viewer-security-model.md)) is one more site
block pointing at the **same** app — a second hostname that carries no app
cookies:

```caddyfile
usercontent.example.net {
    reverse_proxy localhost:3000
}
```

plus `VIEWER_BASE_URL=https://usercontent.example.net` in `.env`. Share
URLs are then minted on that origin, and the server enforces the split by
hostname:

- The viewer hostname answers **only** `/v/*` (decks, assets, the password
  form), `/api/v1/viewer/*` (the token-authenticated annotation and forms
  API the deck runtime calls) and the `/healthz` / `/readyz` probes.
  The dashboard, sign-in, `/mcp`, `/embed.js` and the rest of `/api/v1`
  answer 404 there, no session cookie is ever issued on it, and nothing it
  serves is authenticated by one (the viewer API authenticates on the share
  secret).
- The app hostname (`PUBLIC_BASE_URL`) serves everything else and answers
  `/v/*` with a redirect to the viewer hostname, so links minted before the
  switch keep working.
- The app API refuses any request whose `Origin` is the viewer origin (or
  any foreign origin), and the dashboard's content policy frames decks
  from the viewer origin only, so the in-dashboard deck preview keeps
  working.

The two values must be different origins; the server refuses to boot when
they are equal. The proxy must forward the original `Host` header (Caddy does
by default; nginx needs `proxy_set_header Host $host;`) — the split is decided
on it.

## Caddy in compose (alternative)

Add to `docker-compose.yml` when you prefer everything containerized:

```yaml
caddy:
  image: caddy:2-alpine
  restart: unless-stopped
  ports: ['80:80', '443:443']
  volumes:
    - ./Caddyfile:/etc/caddy/Caddyfile:ro
    - caddy_data:/data
```

with a `Caddyfile` of `slides.example.com { reverse_proxy app:3000 }`, and
remove the app's host port mapping.
