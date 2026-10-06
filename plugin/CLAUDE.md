# `slideless` plugin

[Open Plugin v1](https://github.com/vercel-labs/open-plugin-spec) plugin for the **Slideless** agent skills, living at `plugin/` in the Slideless monorepo (`antasphere/slideless`); this folder is the plugin root, and the monorepo root's `.claude-plugin/marketplace.json` exposes it as the `slideless` marketplace entry (`"source": "./plugin"`). The shape is the one `clave` and `exos` use: the skills ship with the product so they never drift from its CLI and its file formats.

The plugin's job: the agentic pieces of Slideless that run in an operator's agent session rather than in the app. One skill today, `/brand`, which carries the three motions around a workspace brand (PRDCT-2422, and the creation half Romain asked for on 7 October 2026): **create** a brand from a company's own material, **use** a brand to author a deck, **generalise** a session's brand-level changes back into the brand with the human's yes.

Context you may need when editing the skills:

- A brand is a **reference**: a deck whose root `AGENT.md` starts with a frontmatter naming `type: Brand`. The model (fields, audience, default, provenance) is `docs/concepts/references.md`; the CLI family (`slideless brand list|pull|new|push|publish|unpublish|default|start`, `slideless push --brand`) is `docs/agents/cli.md`. The server reads the frontmatter with the `yaml` package (`apps/server/src/presentations/reference-frontmatter.ts`); the CLI's own reader is `packages/cli/src/references.ts`. The skill repeats none of their tables: it teaches the path and points at the reference.
- **The skill names only commands and flags the CLI defines.** `packages/cli/test/skill-coverage.test.ts` walks the command tree and checks every `slideless …` invocation and every `--flag` in the skill's fenced blocks against it, the mirror of `docs-coverage.test.ts`. A rename in code fails there before it reaches an agent. Run `pnpm --filter @antasphere/slideless test` after editing a skill.
- **Every example in a skill is invented**: no real client, person, brand, instance or key. The worked values use the invented company "Tidewater Logistics" at `https://tidewater.example`.
- The viewer serves a bundle under a CSP sandbox with no CORS headers, so a relative `@font-face` URL inside a deck does not load there. The skill's page recipe inlines the font files as data URIs and keeps the files in `assets/fonts/` for decks that reuse them. Keep that rule until the viewer changes.
- A plain YAML scalar that contains a space followed by `#` is cut at the `#` (a comment). Hex colours inside a gradient value are the usual victim. The skill tells the agent to double-quote such values; keep that line until the frontmatter reader guards it.
- The two manifests, `.plugin/plugin.json` and `.claude-plugin/plugin.json`, are kept byte-identical; the test checks that too. Bump both on every agent-visible change (semver: a renamed or removed skill is major, a new skill or reference file is minor, wording is patch).
- The plugin is not part of the image: `.dockerignore` excludes `plugin`, and `release.yml` ignores `plugin/**` so a skill edit on `prod` does not roll a release.

## Repository Structure

```
.
├── .plugin/
│   └── plugin.json                 # Vendor-neutral manifest (Open Plugin v1)
├── .claude-plugin/
│   └── plugin.json                 # Claude Code preferred manifest (kept identical)
├── skills/
│   └── brand/
│       ├── SKILL.md                # the /brand procedure: create, use, generalise
│       └── references/
│           ├── capture.md          # capturing a website's identity: screens, computed styles, fonts, SVGs
│           ├── agent-md.md         # authoring the AGENT.md contract, field by field, with the quoting rule
│           └── pages.md            # the pages that show a brand applied, and the font-inlining build
├── README.md
├── CLAUDE.md
└── LICENSE                         # the repo's Sustainable Use License, copied
```

## Conventions

- Skills contain no secrets, no API keys, no internal URLs.
- A skill shells out to the `slideless` CLI by command name and flag, never by implementation detail.
- Each `SKILL.md` stays self-contained; its `references/` files are read on demand from the skill's own folder.
