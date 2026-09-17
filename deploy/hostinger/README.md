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

The pin is release `0.4.1` (tag `v0.4.1`, commit `b1da96e`), published by
successful release run
[35082568219](https://github.com/antasphere/slideless/actions/runs/35082568219),
with manifest digest `sha256:74ed6d9ff24cff07d22c7393e53fddb8d95819769e73cdc674bc22d28a29bed2`
(linux/amd64 — releases build amd64 only since PRDCT-2337, which is what a
Hostinger VPS runs). The pin names a released version on purpose: the image
reports that version on `GET /instance`, so a customer and a support session
agree on which build is running. The historical `v0.3.0` tag predates automatic
setup-token generation and must not be used for this installation flow. The
companion images (`pgvector/pgvector:pg17`, `caddy:2-alpine`) are digest-pinned
too, so the Pages gate inspects exactly what customers will pull.

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
