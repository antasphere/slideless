# The Slideless CLI

`slideless` is the typed command-line client for a Slideless instance — the
primary human/agent face of it. It signs in over email OTP (minting
its own API key), pushes deck folders as immutable versions, pulls them back
byte-exactly, manages share links and collaborators, and previews decks
locally under the exact viewer sandbox.

## Install

`npm i -g @antasphere/slideless` exposes the `slideless` binary (the package
publishes under the Antasphere org's npm scope; the binary name is unchanged).
The published package is a single self-contained bundle (`dist/bin.js`, built
with esbuild): the workspace-internal `@slideless/contract`, `@slideless/sdk`,
`@antasphere/cli-core`, and commander are inlined at build time, so the
published manifest carries **zero runtime dependencies** — nothing internal or
git-pinned leaks into a public install.

From a checkout:

```bash
pnpm --filter @antasphere/slideless... build
node packages/cli/dist/bin.js --help
```

## Configuration: profiles, flags, environment

Config lives in the **shared Antasphere CLI config home** (provided by
`@antasphere/cli-core` — one home for the whole tool family), under the
`slideless` namespace: `$XDG_CONFIG_HOME/antasphere/tools/slideless.json`
(default `~/.config/antasphere/tools/slideless.json`), directories `0700`,
file `0600`:

```json
{
  "activeProfile": "default",
  "profiles": {
    "default": { "apiKey": "slk_…", "baseUrl": "https://slides.example.com" }
  }
}
```

**Migrating from older builds**: the config used to live at
`~/.config/slideless/config.json`. On first run, if that file still exists,
holds at least one profile, and the new home has no slideless profiles yet,
it is imported automatically and non-destructively — the old file stays in
place (older CLI builds keep working) but stops being read. Note the
corollary: after `slideless config clear`, a still-present legacy file is
imported again on the next run; delete `~/.config/slideless/config.json` too
if you want a truly clean slate.

Every command accepts `--api-url` (alias `--url`), `--api-key`, `--profile`,
and `--json`. Resolution order:

| Setting  | 1st         | 2nd                 | 3rd               | Otherwise                                                                     |
| -------- | ----------- | ------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Base URL | `--api-url` | `SLIDELESS_URL`     | profile `baseUrl` | **error**                                                                     |
| API key  | `--api-key` | `SLIDELESS_API_KEY` | profile `apiKey`  | hub connect (cloud, below) — else the public commands work and the rest error |

There is deliberately **no default URL**: a self-hosted CLI must name its
instance explicitly (flag, env, or saved profile) rather than silently talking
to the wrong host.

### Cloud instances: connect through `antasphere login`

On an **Antasphere-cloud** instance you never run a Slideless-specific login.
When no direct key resolves, the CLI asks discovery (`GET /api/v1/instance`)
whether the instance signs in through the hub (`auth.methods` contains
`antasphere`); if so, it exchanges the stored `antasphere login` credential
for a **user-scoped** tool-local `slk_` key (hub → tool; see
[Your Antasphere account](../getting-started/antasphere-account.md)) and
caches it in the profile **per hub profile** (`connectKeys` — ONE
key per hub account, valid for every org; the org is a per-request
selection, never part of the credential):

```bash
antasphere login                       # once, for the whole tool family
slideless list --api-url https://app.slideless.ai   # exchanges + caches on first use
slideless list                                      # served from the cache — no hub call, no new key
```

- The exchange names **no organization** (the hub credential identifies the
  USER, never one org); a single cached key serves whatever org context is
  active. Second and later runs make zero hub calls and mint nothing.
- The hub key is sent to the **hub only**; the instance sees a short-lived
  user-scoped JWT (plus its own one-time offline grant, relayed once and
  never stored by the CLI) and answers with an ordinary local key.
- A cached key is only ever replayed against the instance it was minted on
  (the profile's `baseUrl` scopes the cache).
- `slideless logout` on a hub-connected profile self-revokes the cached
  key(s) server-side (`DELETE /cli/auth/key` — the presenting key revokes
  exactly itself), then evicts them. An OLDER instance whose machine
  allowlist predates the self-revoke refuses (403) and keeps the key
  **valid server-side** — the CLI says so; revoke it from the dashboard. A
  classic single-key profile logs out exactly as before.

Self-hosted (`oss`) instances never take this branch: the flows above
(`auth login-request`, `login`, `SLIDELESS_API_KEY`, `--api-key`) resolve
exactly as documented, and the hub is never contacted.

## Sign in

The OTP flow is the **self-host** entrance. On an Antasphere-cloud instance
it refuses — the CLI detects cloud via discovery and steers you to
`antasphere login` (see "Cloud instances" above); server-side the endpoints
answer `403 cli_otp_disabled` (cloud instances are hub-login-only). The
flow needs the instance to have a delivering email driver
(`EMAIL_DRIVER=smtp|resend`); it signs in **existing accounts only** — sign-up
stays closed (accounts enter via setup, workspace invitations, or
collaborator claims):

```bash
slideless auth login-request  --api-url https://slides.example.com --email you@example.com
slideless auth login-complete --api-url https://slides.example.com --email you@example.com --code 123456
```

`login-complete` mints an `slk_` API key server-side (scopes
`presentations:read` + `presentations:write`, never `data:export`) and stores
it as the active profile. Accounts with 2FA enabled are refused
(`two_factor_required`) — mint a key in the dashboard instead and paste it:

```bash
slideless login --api-url https://slides.example.com --api-key slk_…   # or pipe the key on stdin
```

Profile management:

```bash
slideless whoami            # identity behind the resolved key
slideless verify            # exit 0 iff instance + key work
slideless profiles          # list profiles (keys redacted)
slideless use <profile>     # switch the active profile
slideless logout            # forget the stored key (revoke server-side in the dashboard);
                            # hub-connected profiles: revoke + evict the cached user-scoped key
slideless config show       # config path + redacted contents
slideless config clear      # delete the config file
```

## Author: push / pull / dev

```bash
slideless push ./deck --title "Q3 Board Deck"    # new deck → prints the id
slideless push ./deck                            # next push = version 2 of the SAME deck
slideless pull <id> ./out                        # byte-exact download of the latest version
slideless pull <id> ./out --at 1                 # …or any pinned version
slideless pull-annotations [id] [--version N] [--status open|resolved] [--out notes.json]
slideless annotation resolve <id> <annotationId> # mark a note resolved
slideless annotation reopen <id> <annotationId>  # …and flip it back open
slideless dev ./deck --port 4173 --no-open       # local preview, no backend
```

**push** implements the content-addressed 3-step protocol: scan → hash every
file (sha256) → `precheck` (the server answers which blobs it is missing) →
upload exactly those → commit the manifest. Unchanged files are never
re-uploaded.

- **New deck vs new version**: the first push writes `.slideless.json` into
  the deck folder (`{ presentationId, baseUrl }`). Later pushes find it and
  commit a new version of that deck with optimistic concurrency
  (`expectedBaseVersion`; a concurrent push answers a clean retry error).
  `--id <deckId>` targets a deck explicitly; `--new` forces a fresh deck. A
  link pointing at a _different_ instance errors loudly instead of silently
  targeting a foreign id.
- **Ignores**: `.git`, `node_modules`, `.DS_Store`, `.slideless.json`, and
  `.slidelessignore` are always skipped. A `.slidelessignore` in the deck root
  adds gitignore-style rules (a pragmatic subset: `#` comments, `*`, `?`,
  `**`; trailing `/` = directories only; patterns with `/` anchor to the deck
  root, without `/` they match any path segment; no `!` negation). Symlinks
  are never followed.
- **Entry detection**: `--entry` wins, else `index.html`, else the only
  `.html` file, else an error listing candidates. A single-file push
  (`slideless push deck.html`) uses that file as the entry.
- Flags: `--title`, `--entry`, `--kind presentation|app|plan`,
  `--interactive`, `--id`, `--new`.

**pull** downloads a version's manifest and streams every blob to disk —
byte-identical to what was pushed — then writes/refreshes `.slideless.json`
so a later `push` in that folder targets the same deck.

**dev** serves the folder locally with the **exact** public-viewer posture —
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
allow-modals allow-downloads`, `nosniff`, `no-referrer`, `no-store` — so what
you preview is exactly what share-link recipients get (same isolation, same
relative paths). Live reload is injected into HTML responses; any file change
reloads the browser. No backend, no credentials.

## Share

```bash
slideless share <id> --name "Alice"                       # prints the /v/{secret} URL — shown ONCE
slideless share <id> --to-version 2 --annotator \
                     --expires 2026-12-31T23:59:59Z --password hunter22
slideless unshare <id> --token <tokenId>                  # revoke one link
slideless unshare <id>                                    # revoke ALL active links
slideless share-email <id> --to a@x.com b@x.com [--message "…"]  # one personal token per address, emailed
slideless pin <id> <tokenId> --to-version 1               # freeze a recipient on v1
slideless pin <id> <tokenId> --latest                     # follow the latest again
slideless tokens <id> [--all]                             # list links + access stats (opens, last opened)
```

Secrets are stored hash-only server-side: the URL printed at creation is
never retrievable again (`share-email` mints and mails a fresh secret per
send).

## Collaborators

```bash
slideless invite   <id> --email dev@example.com    # per-deck dev grant; prints the claim link
slideless uninvite <id> <collaboratorId>           # revoke the grant
```

## Decks, files, export

```bash
slideless list [--all]        # presentations, newest first
slideless get <id>            # metadata
slideless versions <id> [--all]  # version history, newest first (numbers line up with pull --at)
slideless delete <id>         # soft delete (links stop resolving)
slideless instance            # public discovery — no key needed
slideless files list|upload|download|rm
slideless export [-o file]    # workspace zip (key needs the opt-in data:export scope)
```

## Shell completion

```bash
eval "$(slideless completion bash)"     # or zsh
slideless completion fish | source      # fish
```

## Machine use

Add `--json` to any command for the wire shape; every error prints to stderr
and exits non-zero. Typical agent loop:

```bash
export SLIDELESS_URL=https://slides.example.com
export SLIDELESS_API_KEY=slk_…
id=$(slideless push ./deck --json | jq -r .presentation.id)
url=$(slideless share "$id" --name ci --json | jq -r .url)
```

## Server endpoints behind `auth login-*`

`POST /api/v1/cli/auth/request` and `POST /api/v1/cli/auth/complete` are
public pre-auth endpoints (like `/setup`), riding the better-auth email-OTP
plugin with `disableSignUp` — an unknown email gets a generic success and no
mail (no account enumeration, no account creation), codes are attempt-limited
(3) and both endpoints sit behind the instance's OTP/login rate walls. The
key is returned exactly once; the flow's throwaway session is deleted
server-side. Without an email driver both answer `400 otp_unavailable`; on
the cloud edition both answer `403 cli_otp_disabled` (hub-only login — mint
through `antasphere login` instead). `DELETE /cli/auth/key` is the logout
counterpart on both editions: an authenticated route where the presenting
API key revokes exactly ITSELF (machine-allowed under `presentations:write`
in the fail-closed scope allowlist; sessions are refused — the dashboard is
their key surface).
