# Hostinger distribution

`docker-compose.yml` is a standalone template: no checkout, build context,
host scripts, or companion config files. `SLIDELESS_DOMAIN` is its only
required input. `index.html` contains the deployment button and template URL.
User instructions live in `docs/self-hosting/hostinger.md`.

## Acceptance criteria

- A dedicated VPS with DNS configured can start the stack from the public URL.
- Only Caddy publishes ports, with HTTPS and HTTP-to-HTTPS redirects.
- First boot generates separate database and authentication secrets and a
  setup token. Redeploying preserves credentials, users, and uploaded files.
- Missing or malformed hostnames fail before initialization; damaged stored
  credentials fail without replacement.
- The owner can claim the instance using the app log token and sign in.
- Presentation publishing, agent connection, and email configuration are optional.
- The app image is version-pinned; upgrades remain manual.

## Publication

Never publish the repository root as a Pages artifact. The `hostinger-pages.yml`
workflow publishes exactly `deploy/index.html` (the root) and this folder's
`index.html` + `docker-compose.yml` under `/hostinger/` on the Pages site, served on
the product's deploy domain `https://deploy.slideless.antasphere.com/` (a CNAME to
`antasphere.github.io`; the github.io address redirects there). The domain is
product-scoped and the host is the path — a second host (Hetzner, Coolify, …) is a
sibling folder `deploy/<host>/` staged the same way, never a second domain. The
compose URL customers paste is `https://deploy.slideless.antasphere.com/hostinger/docker-compose.yml`;
the deploy button and the guide both use it, never a raw GitHub URL.

The pin is release `0.7.0` (tag `v0.7.0`, commit `609cf7d`), published by
successful release run
[35549873028](https://github.com/antasphere/slideless/actions/runs/35549873028),
with manifest digest `sha256:97f3dbfdaff5004a77a0e29db2ee4ebd351271f6def65bad7813370caa55fb45`
(the index; it carries linux/amd64 only — releases build amd64 only since
PRDCT-2337, which is what a Hostinger VPS runs). The pin names a released version on purpose: the image
reports that version on `GET /instance`, so a customer and a support session
agree on which build is running. The historical `v0.3.0` tag predates automatic
setup-token generation and must not be used for this installation flow. The
companion images (`pgvector/pgvector:0.8.6-pg17`, `caddy:2.11.4-alpine`) are pinned on IMMUTABLE version tags with their digests — never on a floating tag like `caddy:2-alpine`: `docker manifest inspect tag@digest` resolves the tag first, so the Pages gate fails the day upstream moves it (2026-09-18). The gate then inspects exactly what customers will pull.

Before its first successful run:

1. Enable GitHub Pages with GitHub Actions as its build source (free once the
   repository is public). Only the two published files leave the repository.
2. Make the GHCR `antasphere/slideless` package publicly readable. Check
   anonymous manifest access, not just access while logged in. The Pages
   workflow refuses to publish if any template image is inaccessible anonymously.
3. Merge the template and guide to `prod`, let the docs sync publish the
   guide, and run **Publish Hostinger deployment**. Check the public YAML URL
   returns the file without authentication, then import it in hPanel.
4. Verify a fresh dedicated Hostinger VPS using the guide, including a public
   certificate, owner setup, sign-in, and recreation with retained volumes.

GitHub Pages publication does not submit Slideless to the Hostinger catalog.
Establish Hostinger's submission process separately; supply the tested public
template, guide, app description, and image details when requested.

## Verification

```bash
node --test scripts/hostinger-template.test.mjs
docker build -t slideless:hostinger-test .
HOSTINGER_TEST_IMAGE=slideless:hostinger-test node scripts/hostinger-smoke.mjs
```

The smoke test uses an isolated Compose project, local CA certificates, and
loopback-only random ports. It exercises the production template with only
test transport and image overrides. It does not contact an ACME authority or
prove Hostinger's UI accepts the template. CI runs this rehearsal on PRs.

Before changing the pinned image, run the smoke against that exact published
image too, and update both the template and deployment page. Container UIDs,
the `/data` volume, `tini`, Node, and the server entrypoint are part of the
template's image contract.

## Verified on a real Hostinger VPS

2026-09-18, KVM 1 (1 vCPU, 4 GB, Germany), Plain OS → Ubuntu 24.04, Docker Manager:
Compose from URL → Environment `SLIDELESS_DOMAIN=share.antasphere.com` → Deploy.
Let's Encrypt certificate obtained ~30 s after Deploy, `init` 0 → `db` healthy → `app`
healthy → `caddy` up, HTTP 308 → HTTPS, wizard claimed with the token from the app log,
owner signed in, `POST /api/v1/setup` → 410 afterwards. Two things the run corrected in
the template and the guide: hPanel runs the file with no environment (a `${VAR:?}`
render refusal leaves no project), and the deploy button does not carry the template
into a new VPS. The instance stays up as the reference self-hosted Slideless.

## Verified upgrade on the reference instance

2026-09-21, `share.antasphere.com` 0.4.1 → 0.7.0, three releases in one step. The
deployed compose file was replaced with this published template (downloaded from
the deploy URL, not hand-edited, so the instance runs exactly what a customer's
redeploy installs) and `docker compose up -d` recreated `init` and `app` only; `db`
and `caddy` kept running and every named volume was untouched. Migrations applied
under the advisory lock at boot, `/readyz` answered 200 about two seconds later,
and the downtime was the app container's restart.

Verified after: `/api/v1/instance` reports 0.7.0 with the SAME `instanceId`, the
data survived (3 users, 11 presentations, 1 workspace, 50 files), the three
Projects tables 0.7.0 adds are present, HTTP still 308s to HTTPS on a valid
certificate, `/metrics` still 401s, and `POST /api/v1/setup` with a well-formed
body still answers 410 `already_setup` without creating a user — worth probing
with the real body shape, since schema validation answers 400 first and a 400
proves nothing about the closure.

Two notes for the next one. The deployed file was the pre-fix template (the
`${VAR:?}` render refusal of 2026-09-18), so taking the published file wholesale
also carried that fix and the mail documentation — a hand-edited pin would have
left both behind. And a VPS snapshot is the only true rollback, since migrations
are forward-only; this run went without one by the operator's call, with a
`pg_dumpall` and a tar of `app_data` + `db_credentials` (the auth secret and the
pepper root) left in `/root/slideless-preupgrade/` as the partial net.
