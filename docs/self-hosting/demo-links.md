# Demo links

A demo link signs one person in to your instance without their password. You
open it in a browser and you are that person, on the page the link names. It
is made for demonstrations: showing Slideless to someone as an editor, a
member or a colleague sees it, switching between those accounts in a few
clicks, handing a prepared account to a tester for an afternoon.

Demo links exist only on an instance whose operator turned them on, and they
only ever open demonstration accounts. They have no effect on the cloud
edition.

## Turning it on

Three settings, in the instance's `.env` (the compose file passes them
through):

| Variable                     | What it does                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_SIGN_IN`               | The switch. `true` turns demo links on; the default, `false`, leaves no trace of them on the instance.                                   |
| `DEMO_SIGN_IN_HOSTS`         | The public host names the switch may be on, comma-separated, written as bare names (`demo.example.io`, no `https://`, no port, no path). |
| `DEMO_SIGN_IN_EMAIL_DOMAINS` | Domains whose addresses a link may open, beside the reserved ones listed below. Comma-separated; each one covers its subdomains too.     |

On your own machine the switch alone is enough, because `localhost` (and
every name under `.localhost`, and `127.0.0.1`) is always allowed:

```bash
PUBLIC_BASE_URL=http://localhost:3000
DEMO_SIGN_IN=true
```

On a public host you must also name that host, on purpose:

```bash
PUBLIC_BASE_URL=https://demo.example.io
DEMO_SIGN_IN=true
DEMO_SIGN_IN_HOSTS=demo.example.io
# Only if your demonstration accounts live on a domain of your own:
DEMO_SIGN_IN_EMAIL_DOMAINS=demo.example.io
```

If the switch is on and the host of `PUBLIC_BASE_URL` is neither local nor
listed in `DEMO_SIGN_IN_HOSTS`, the instance refuses to start and says which
variable and which host. A malformed entry in either list (a scheme, a port, a
path, a space, a wildcard) refuses the start too. Restart the instance after
changing any of the three.

## Which accounts a link may open

Only an address on a domain reserved for examples and tests:

- `example.com`, `example.net`, `example.org`, and their subdomains;
- any domain ending in `.test`, `.example`, `.invalid` or `.localhost`;
- the domains you listed in `DEMO_SIGN_IN_EMAIL_DOMAINS`, and their subdomains.

`ada@example.com` and `reviewer@acme.test` can be opened; `ada@gmail.com`
cannot, whatever else is true. The reason is simple: a demo link walks past a
password, so it must never be able to open a real person's account. Nobody
reads mail at a reserved domain, so an account there is a demonstration
account by construction. Add a domain of your own only when every mailbox on
it is a demonstration account.

## Who can make a link, and for whom

An **owner** of the workspace, signed in, makes a link for an admin or a
member of that workspace, or for themself. Never for another owner, never for
an account that has a second factor (a link would walk past it), never for a
guest invited to a single deck, and never for someone who also belongs to
another workspace. A link cannot be made with an API key or by an agent
holding one: it takes an owner's own session.

## How long a link lives

A day by default, a week at most; you choose the lifetime when you make it.
You can revoke a link at any moment. When a link expires or is revoked, the
sessions it opened end with it: whoever is still signed in through it is signed
out on their next click.

The link itself is shown once, when it is made. The instance keeps no copy of it.

## One person per browser window

A link signs the whole browser in as its person, and signs out whoever it was
signed in as before. There is no signing in as one person in one tab and another
in the next. To show two people side by side, open the second link in another
browser profile or in a private window.

## The banner

While the switch is on, everyone signed in to the instance sees a banner saying
so: demo sign-in is on, and an owner of the workspace can open demonstration
accounts without their password. It is there so that nobody works on such an
instance without knowing.

## Making links from the dashboard or the command line

In the dashboard, an owner finds the demo links under Settings while the switch
is on: pick the member, the page and the lifetime, copy the link.

From the command line, the three commands sign in as the owner for the length
of the command and sign out at the end (they never use an API key). The owner's
address and password come from `SLIDELESS_OWNER_EMAIL` and
`SLIDELESS_OWNER_PASSWORD`, or from `--owner-email` and
`--owner-password-stdin`:

```bash
export SLIDELESS_URL=http://localhost:3000
export SLIDELESS_OWNER_EMAIL=owner@example.com
read -rs SLIDELESS_OWNER_PASSWORD && export SLIDELESS_OWNER_PASSWORD

# One link for Ada, valid two hours, landing on her decks and on the settings page:
slideless demo link --email ada@example.com --path /decks --path /settings --hours 2

slideless demo list                # the links made in this workspace, newest first
slideless demo revoke <id>         # end one, and the sessions it opened
```

`demo link` prints one line per `--path`. Name several people on one command
(`--email ada@example.com --email bob@example.com`) and it signs in once and
makes one link per person and page. The
[CLI reference](../agents/cli.md#demo-links) lists every flag.

## What this is not

- **Never turn it on for an instance that holds real people's accounts.** It is
  for a demonstration instance, a local copy, a test bed, filled with
  demonstration accounts. The address rule protects real accounts; running it
  beside them is still a choice to not make.
- It is not a way to share a deck with someone: a share link does that, and
  signs nobody in.
- It does nothing on the cloud edition. There, identity belongs to the
  Antasphere hub, and demo links are made at the hub.
