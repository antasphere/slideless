#!/usr/bin/env bash
# CI drift guard: a Better Auth upgrade that changes the expected table shape
# must fail the build until someone regenerates the schema AND writes the
# matching migration. Compares the pinned CLI's current output against the
# committed snapshot (which mirrors the installed chassis's
# node_modules/@antasphere/chassis-db/src/auth-schema.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

# Fresh path in a portable temp dir — the CLI silently skips existing files,
# and BSD/GNU mktemp disagree about -t templates.
outdir="$(mktemp -d "${TMPDIR:-/tmp}/auth-drift.XXXXXX")"
out="$outdir/generated.ts"
trap 'rm -rf "$outdir"' EXIT

# Bin name is `better-auth` (from the pinned @better-auth/cli devDependency).
pnpm exec better-auth generate --config scripts/auth-schema-config.ts --output "$out" --yes >/dev/null

# The snapshot is committed prettier-formatted (repo-wide format:check);
# normalize the CLI output the same way — explicit config, because the temp
# file lives outside the repo and would otherwise get prettier defaults.
pnpm exec prettier --config "$(pwd)/../../.prettierrc" --log-level silent --write "$out"

# The snapshot is only a proxy: the file the server actually runs against is the
# installed chassis's auth-schema.ts (@antasphere/chassis-db, linked here by pnpm).
# A hand edit to one and not the other passed this guard silently (verifier
# finding, 2026-08-29) — pin them equal.
chassis_auth_schema=node_modules/@antasphere/chassis-db/src/auth-schema.ts
if ! diff -u "$chassis_auth_schema" scripts/auth-schema.snapshot.ts; then
  echo ""
  echo "scripts/auth-schema.snapshot.ts differs from the installed chassis's $chassis_auth_schema."
  echo "The snapshot must equal the installed chassis's file. A chassis upgrade that changes the"
  echo "auth schema is answered here: regenerate the snapshot from the pinned CLI, write the"
  echo "matching migration in packages/db/drizzle, and re-run."
  exit 1
fi

if ! diff -u scripts/auth-schema.snapshot.ts "$out"; then
  echo ""
  echo "Better Auth schema drift detected."
  echo "The chassis's auth-schema.ts is the chassis's: regenerate it in the chassis repository and"
  echo "publish, move the pin, regenerate scripts/auth-schema.snapshot.ts from the pinned CLI,"
  echo "write the corresponding migration in packages/db/drizzle, and re-run."
  exit 1
fi
echo "auth schema snapshot: no drift"
