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

The source repository is private. Never use its raw GitHub URL as the public
Compose URL and never publish the repository root as a Pages artifact.
The `hostinger-pages.yml` workflow publishes exactly `index.html` and
`docker-compose.yml` to `https://antasphere.github.io/slideless/`.

The initial pin is build `sha-f03cb72`, published by successful release run
[34700250126](https://github.com/antasphere/slideless/actions/runs/34700250126),
with manifest digest `sha256:9b9c45b3332db45bdb215430aedbf3bd58a3b61dc780afe84ed045d2793be37d`.
Its existing release smoke and vulnerability gates passed. The historical
`v0.3.0` tag predates automatic setup-token generation and must not be used
for this installation flow.

Before its first successful run:

1. Enable public GitHub Pages for this private repository with GitHub Actions
   as its build source. The organization's GitHub plan must allow Pages for
   private repositories. The source stays private; the two published files
   are intentionally public.
2. Make the GHCR `antasphere/slideless` package publicly readable and ensure
   the pinned image is available for Linux amd64 and arm64. Check anonymous manifest
   access, not just access while logged in. The Pages workflow refuses to
   publish if any template image is inaccessible anonymously.
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
