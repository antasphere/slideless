# Install

For a dedicated Hostinger VPS with automatic HTTPS and setup through hPanel,
follow [Install on Hostinger](hostinger.md).

Install Slideless on your own machine: two supported paths, both ending
with the first-boot wizard in the browser.

## One-liner (fresh VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/antasphere/slideless/prod/install.sh | \
  sudo bash -s -- --domain slides.example.com
```

Installs git + Docker if missing, clones to `/opt/slideless`, generates
secrets into `.env` (mode 600), starts the stack, and configures UFW
(22/80/443). With a domain, finish by wiring the reverse proxy
([reverse-proxy.md](reverse-proxy.md)) and setting `TRUST_PROXY=true` in
`.env`.

### Without a domain

The app is published on **`127.0.0.1` only** and the app port stays closed in
the firewall. Reach the dashboard through an SSH tunnel:

```bash
ssh -N -L 3000:127.0.0.1:3000 <user>@<server-ip>
open http://localhost:3000        # setup token: /opt/slideless/.env
```

This is not belt-and-braces. Docker publishes ports by writing DNAT rules
that are evaluated **before** ufw's INPUT chain, so a `0.0.0.0` bind is
reachable from the internet no matter what the firewall says — the bind
address is the only control that actually holds. And the wizard request
carries the owner password and the setup token, so the server itself refuses
to complete setup over plaintext HTTP on a non-loopback origin
(`403 insecure_transport`).

To publish anyway on a trusted private network, pass `--expose-port`: it
binds `0.0.0.0`, opens the port in ufw, and sets `ALLOW_INSECURE_SETUP=true`.
It needs to know the address this host is reached on, which it reads from
`hostname -I`; on a host where that prints nothing it stops and asks, so pass
`HOST_IP=<address>` alongside it rather than letting an empty value become the
instance's `PUBLIC_BASE_URL`.

## Manual (any machine with Docker)

```bash
git clone https://github.com/antasphere/slideless.git slideless
cd slideless
./setup.sh            # generates .env secrets, pulls images, starts
open http://localhost:3000
```

`setup.sh` is idempotent: with an existing `.env` it just (re)starts.

`.env` carries the host publication settings, and `update.sh` / `restore.sh`
read them back — so a custom port survives an upgrade instead of reverting:

| Variable   | Default     | What it does                                            |
| ---------- | ----------- | ------------------------------------------------------- |
| `APP_PORT` | `3000`      | Host port. In-container the app always stays on 3000.   |
| `APP_BIND` | `127.0.0.1` | Host interface. `0.0.0.0` publishes to every interface. |

## First boot

The dashboard shows the setup wizard: instance name + owner account. The
wizard **always** requires a setup token — this stops a stranger racing you
to own a freshly exposed instance. `setup.sh` and the one-liner installer
generate one into `.env`; a container started without `SETUP_TOKEN` (a
hand-written `.env`, a plain `docker run`) generates its own at first boot,
writes it to `/data/setup-token` inside the data volume and **prints it in
the container log** (`docker compose logs app | grep setup`). Setup is never
first-come-first-served. It runs exactly once; afterwards the endpoint
answers `410 Gone` and the generated token file is removed.

Setup is also refused over plaintext HTTP on a non-loopback `PUBLIC_BASE_URL`
(`403 insecure_transport`) — the request carries the owner password and the
token. Use https, an SSH tunnel to the loopback bind, or the deliberate
`ALLOW_INSECURE_SETUP=true` opt-in.

Teammates join via invitations (Members → Invite). Every invitation yields a
copyable accept link — SMTP is never required. To also send invitation
emails, configure an email driver in `.env`
([env-reference.md](../reference/env-reference.md)).

## What's running

| Service | Image                          | Data                                                  |
| ------- | ------------------------------ | ----------------------------------------------------- |
| `app`   | `ghcr.io/antasphere/slideless` | `app_data` volume → `/data` (files, generated secret) |
| `db`    | `pgvector/pgvector:pg17`       | `pg_data` volume                                      |

The app container is stateless by design — all state lives in Postgres and
the `/data` volume. Migrations apply automatically at boot under an advisory
lock; set `AUTO_MIGRATE=false` to run them manually (the instance then
refuses readiness while behind).

## Deck images

The dashboard shows a still image of each deck version on its card. The app
captures it with the Chromium that ships in the image, once per version,
shortly after the version is pushed.

**What it costs.** Chromium and the libraries it needs add about 760 MB to
the unpacked image (about 330 MB more to download). Each capture takes
about 1 to 3 seconds of CPU and 200 to 300 MB of memory while it runs, and
captures run one at a time.

**The seccomp profile beside the compose file.** Chromium protects the
server from a deck's script with its own sandbox, and that sandbox needs
Linux user namespaces, which Docker's default seccomp profile forbids.
`deploy/seccomp-chromium.json` is Docker's default profile with that one
permission added (the namespace calls, for a process without
`CAP_SYS_ADMIN`), and `docker-compose.yml` applies it to the `app` service.
The capture never runs without the sandbox: if the profile is missing, the
app logs one error, capture stays off, and the cards show a drawn pattern
instead. Never use `seccomp=unconfined` in its place.

To check a host, run the image's self-check with the profile:

```bash
docker run --rm --security-opt seccomp=deploy/seccomp-chromium.json \
  ghcr.io/antasphere/slideless node dist/thumbnail-selfcheck.js
```

It prints one JSON line and exits 0 when capture works, or 3 when the
sandbox cannot start.

**Turning it off.** `SLIDELESS_THUMBNAILS=off` in `.env` stops capturing.
Chromium stays in the image; it is just never started.

**Other runtimes.**

- **Kubernetes**: give the pod a seccomp profile that allows the same calls
  (a `Localhost` profile built from `deploy/seccomp-chromium.json`).
  `Unconfined` is not recommended: it lifts every syscall filter to allow
  three calls.
- **Cloud Run**: use the second-generation execution environment, which
  allows the namespaces the sandbox needs, and keep CPU allocated between
  requests, since the capture runs after the push has already answered.
