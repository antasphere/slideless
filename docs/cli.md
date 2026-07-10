# CLI

`@platform/cli` is a thin, typed command-line client over the SDK — the
agent-and-human face of an instance. Its surface is exactly what an API key
can reach (the fail-closed scope allowlist confines keys to discovery, `/me`,
files, and — with the opt-in `data:export` scope — the workspace export), so
the CLI does discovery, identity, file operations, and the export download.

## Install

It is a workspace package, not published by default (rename and publish it
per product — see [instantiation.md](instantiation.md)). From a checkout:

```bash
pnpm --filter @platform/cli build
node packages/cli/dist/bin.js --help
```

Once published, `npm i -g <your-cli-name>` exposes the `platform` binary.

## Configure

Two settings, from flags or environment:

| Setting  | Flag        | Env                | Default                 |
| -------- | ----------- | ------------------ | ----------------------- |
| Base URL | `--url`     | `PLATFORM_URL`     | `http://localhost:3000` |
| API key  | `--api-key` | `PLATFORM_API_KEY` | —                       |

Mint an API key in the dashboard (API keys → New). `instance` needs no key;
everything else does.

## Commands

```bash
platform instance                       # discovery: name, version, auth methods
platform whoami                         # the identity behind the API key
platform export [-o <path>]             # full workspace export as a zip
platform files list                     # list workspace files (newest first)
platform files upload ./report.pdf      # upload (── name defaults to the basename)
platform files download <id> --out ./f  # download by id
platform files rm <id>                  # delete by id
```

`export` needs a key granted the opt-in `data:export` scope (it is never
implied by `data:read`) and an admin+ creator; the zip streams to disk
(default filename `export-<yyyy-mm-dd>.zip`). Account deletion is
deliberately NOT in the CLI — it is a session-only act (see
[security.md](security.md)).

`files list` is cursor-paginated (server default 50, max 100 per page):

| Flag                | Effect                                          |
| ------------------- | ----------------------------------------------- |
| `--limit <n>`       | Page size (1-100)                               |
| `--cursor <cursor>` | Resume from a previous page's `nextCursor`      |
| `--all`             | Follow `nextCursor` until every page is fetched |

Human output prints a `More available: rerun with --cursor <id> or --all`
hint when a page remains; `--json` prints the wire shape
`{ files, nextCursor }` (with `--all`, all rows and `nextCursor: null`).

Add `--json` to any command for machine-readable output. A non-2xx response
prints to stderr and exits non-zero; a scope denial (a read-only key trying to
write) is a clean `403` message.

## Example (agent-style)

```bash
export PLATFORM_URL=https://platform.example.com
export PLATFORM_API_KEY=key_xxx_yyy
platform whoami --json | jq .workspace.name
platform files upload ./out.csv --content-type text/csv --json | jq -r .file.id
```
