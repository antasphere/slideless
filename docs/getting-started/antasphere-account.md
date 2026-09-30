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
- Some tools are opened to an organization by Antasphere alone (a
  restricted tool). Such an instance refuses to create an organization, and
  says so.

People invited to a single deck (per-deck collaborators) do not need to be
in your organization: they claim the invitation by signing in with
Antasphere and get access to that one deck only.

## The CLI: one login for the whole tool family

`slideless login` is the one command. It signs you in to Antasphere when this
machine has no Antasphere login yet (your email, then the code sent to it),
and ends in Slideless. `antasphere login` remains the entry for the whole
tool family: after it, every Antasphere tool CLI is signed in, `slideless`
included. The `slideless` CLI runs on the cloud by default, with no URL to
pass:

```bash
slideless login                  # once: your Antasphere account, then Slideless
slideless list                   # your default organization
slideless list --org "Acme"      # another organization, for this command only
slideless logout                 # revokes the Slideless key and forgets it
```

The key the CLI keeps identifies you, not one organization. `--org` names
the organization one command runs in, by its name or by the id the account
site shows; without it, the command runs in your Antasphere default
organization. Nothing about the organization is saved on your machine. On
self-hosted instances the CLI keeps its own documented sign-in flows
([cli.md](../agents/cli.md)) and never contacts Antasphere.
