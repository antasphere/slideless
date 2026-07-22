# Your Antasphere account

On Slideless cloud (`slideless.antasphere.com`) you sign in with your
Antasphere account — one account, managed at `account.antasphere.com`, that
works across every Antasphere cloud tool. This page covers what that means
for sign-in, organizations, and the CLI; self-hosted instances are not
affected by any of it.

## One account across Antasphere tools

"Sign in with Antasphere" delegates login to the Antasphere account service.
Your email, password, and two-factor settings live there — the cloud login
page shows only the "Sign in with Antasphere" button, and there is no
separate Slideless password to set, reset, or forget. The first sign-in
creates your Slideless profile automatically, and because Antasphere tools
are first party there is no consent screen along the way.

Being logged in is one concept, not one per tool: with a live Antasphere
session, opening Slideless connects you silently, and logging out anywhere
signs you out of the whole account.

## Cloud and self-hosted editions

One Slideless codebase (and one Docker image) ships two editions:

- **Cloud** (`slideless.antasphere.com`) — operated by Antasphere. Human
  login goes through the Antasphere account service, and your organizations
  come from it.
- **Self-hosted** (the default when you run the image yourself) — local
  accounts, entirely on your own box. A self-hosted instance carries zero
  Antasphere surface at runtime: it never contacts Antasphere, and
  everything else in these docs applies to it unchanged.

## Organizations are managed at Antasphere

On cloud, your Antasphere organizations appear in Slideless as workspaces:

- Every organization you belong to shows up automatically when you sign in,
  and stays in sync while you work.
- Your role in a workspace is your organization role — owner, admin, or
  member — exactly as set at Antasphere.
- Invitations, role changes, and removals happen at
  `account.antasphere.com`. Slideless shows the member roster read-only,
  with a "Manage at Antasphere" link where the management actions would be.
- Changes propagate fast: being removed from an organization, a role
  change, or an organization suspension takes effect in Slideless within
  seconds — across the dashboard, API keys, and connected agents alike.

People invited to a single deck (per-deck collaborators) do not need to be
in your organization: they claim the invitation by signing in with
Antasphere and get access to that one deck only.

## The CLI: one login for the whole tool family

On cloud you never run a Slideless-specific login. `antasphere login` signs
in once for every Antasphere tool CLI; when the `slideless` CLI targets a
cloud instance it exchanges that credential for its own instance key
automatically and caches it:

```bash
antasphere login                                       # once, for the whole tool family
slideless list --api-url https://slideless.antasphere.com   # exchanges + caches on first use
slideless list                                              # served from the cache
```

The cached key identifies you, not one organization — a single key serves
whatever organization you are working in — and `slideless logout` revokes
it. On self-hosted instances the CLI keeps its own documented sign-in flows
([cli.md](../agents/cli.md)) and never contacts Antasphere.
