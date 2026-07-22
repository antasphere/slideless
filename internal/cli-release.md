# CLI release process

How `@antasphere/slideless` (the `slideless` binary) is published to npm.
Usage documentation lives in the public
[CLI guide](../docs/agents/cli.md).

## Release

Releases are tokenless via npm **trusted publishing** (OIDC):
`.github/workflows/publish-cli.yml` fires on a `cli-vX.Y.Z` tag (the `cli-v`
prefix cannot collide with `release.yml`'s Docker-image `v*` tags), verifies
the tag matches `packages/cli/package.json#version` and that the bundled
binary reports the same version (keep `VERSION` in `src/index.ts` in sync),
runs lint/typecheck/test/build for the CLI and its workspace dependencies,
and publishes from `packages/cli` with no npm token.

```bash
# bump packages/cli/package.json#version + VERSION in src/index.ts, commit, then:
git tag cli-v0.3.0 && git push origin cli-v0.3.0
```

**First publish is manual.** Trusted publishing can only be configured on a
package that already exists on npm, so the very first publish of the name is
done by hand while logged in to an account that owns the npm `antasphere` org:

```bash
pnpm --filter @antasphere/slideless... build
cd packages/cli && npm publish   # publishConfig.access = public
```

After that, configure the trusted publisher on npmjs.com
(package → Settings → Trusted Publisher → GitHub Actions) with exactly:

| Field                | Value             |
| -------------------- | ----------------- |
| Organization or user | `antasphere`      |
| Repository           | `slideless`       |
| Workflow filename    | `publish-cli.yml` |
| Environment          | _(leave empty)_   |

and every further release is just the tag. Caveat until then: the workflow's
install step fetches the git-pinned private `antasphere/cli-core` repo, which
the runner's `GITHUB_TOKEN` cannot read — once `@antasphere/cli-core` is on
npm, switch the devDependency pin to the published version (the one-line swap
in cli-core's README) or make that repo public.
