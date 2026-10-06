# `slideless` plugin

> Agent skills for Slideless, shipped from `plugin/` inside the product repository so they stay in step with the CLI they drive.

Agent plugin conforming to the [Open Plugin Specification v1.0](https://github.com/vercel-labs/open-plugin-spec). Installs into any Open-Plugin-compatible host (Claude Code, Cursor, …) with a single command.

## Install

```bash
npx plugins add antasphere/slideless
```

Claude Code native alternative:

```
/plugin marketplace add antasphere/slideless
/plugin install slideless@slideless
```

In the Antasphere workspace, `./antasphere plugins` installs it from the checkout's tracked files.

## What's inside

| Component | Count | Namespace            |
| --------- | ----- | -------------------- |
| Skills    | 1     | `/slideless:<skill>` |

### Skills

| Skill   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brand` | The three motions around a workspace brand. **Create**: turn a company's own material (its website, its files) into a brand: capture, distill, author the `AGENT.md` contract, build the pages that show the brand applied, verify, push, publish, default. **Use**: author a deck under the workspace's brand and record it. **Generalise**: at the end of a session, offer to fold the human's brand-level changes back into the brand. |

The skill teaches the path. The flags live in the CLI reference, `docs/agents/cli.md`, and a test in `packages/cli` keeps every command and flag the skill names in the CLI's command tree.

## License

Fair-code, Sustainable Use License 1.0 — see `LICENSE`.
