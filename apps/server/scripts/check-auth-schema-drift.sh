#!/usr/bin/env bash
# CI drift guard: a Better Auth upgrade that changes the expected table shape
# must fail the build until someone regenerates the schema AND writes the
# matching migration. Compares the pinned CLI's current output against the
# committed snapshot (which mirrors packages/chassis-db/src/auth-schema.ts).
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

# The snapshot is only a proxy: the file the server actually compiles against
# is packages/chassis-db/src/auth-schema.ts. A hand edit to one and not the other
# passed this guard silently (verifier finding, 2026-08-29) — pin them equal.
if ! diff -u ../../packages/chassis-db/src/auth-schema.ts scripts/auth-schema.snapshot.ts; then
  echo ""
  echo "packages/chassis-db/src/auth-schema.ts and scripts/auth-schema.snapshot.ts differ."
  echo "They must be the same file: regenerate both from the pinned CLI."
  exit 1
fi

if ! diff -u scripts/auth-schema.snapshot.ts "$out"; then
  echo ""
  echo "Better Auth schema drift detected."
  echo "Regenerate packages/chassis-db/src/auth-schema.ts + scripts/auth-schema.snapshot.ts,"
  echo "write the corresponding migration in packages/db/drizzle, and re-run."
  exit 1
fi
echo "auth schema snapshot: no drift"
