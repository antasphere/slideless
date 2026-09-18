# Install on Hostinger

Run Slideless on a dedicated Hostinger VPS. You manage the VPS and its DNS;
the template installs Slideless, PostgreSQL, and Caddy for automatic HTTPS.
No terminal commands are required for installation.

## Before you deploy

1. Prepare a dedicated VPS with Hostinger's Docker environment. Use
   [Hostinger's Docker VPS guide](https://www.hostinger.com/support/8306612-how-to-use-the-docker-vps-template-at-hostinger/)
   if Docker Manager is not available. Do not reinstall an existing server
   that contains data to get this environment. The Slideless image is built
   for x86-64 (amd64) servers, which is what Hostinger VPS plans run; it does
   not start on an ARM machine.
2. Choose a hostname, for example `slides.example.com`. Use a dedicated
   subdomain in lowercase, not your bare domain (`example.com`): Slideless
   sends a strict-transport header that also covers every subdomain of the
   hostname it serves, so an install at the bare domain would force HTTPS on
   everything under it for 180 days.
3. At your DNS provider, add an **A** record for that hostname pointing to
   the VPS's public IPv4 address. Add an **AAAA** record only if IPv6 also
   reaches this VPS. Remove conflicting records for the same hostname.
   If your DNS provider offers an HTTP proxy, use DNS-only mode for this setup.
4. Wait until public DNS lookups return the VPS address. Do this before
   deploying. The certificate authority must be able to reach your hostname.
5. Allow inbound TCP ports **80** and **443** in the VPS firewall. Both ports
   must be free. Keep your existing SSH access rule. Do not open database
   port 5432 or application port 3000.

This template assumes one Slideless installation on a dedicated VPS.
It does not configure another application's proxy or change your DNS.

## Deploy

For a new VPS, the button opens Hostinger's VPS checkout. At checkout, under
**Choose what to install**, pick **Plain OS → Ubuntu** (24.04): the list is
single-choice, so selecting Ubuntu replaces the pre-selected _Docker and Traefik_
application, whose Traefik would occupy ports 80 and 443 that Slideless's own proxy
needs. Keep **Docker manager** enabled among the additional features. The checkout
does not carry the template over: once the VPS is provisioned, continue with the
steps below exactly as for an existing VPS. Docker Manager installs Docker on a
plain Ubuntu the first time you open it. Finish the DNS steps above before
starting the containers.

[![Deploy on Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostinger.com/docker-hosting?compose_url=https%3A%2F%2Fdeploy.slideless.antasphere.com%2Fhostinger%2Fdocker-compose.yml)

For an existing VPS:

1. In hPanel, open **VPS → Manage → Docker Manager**.
2. Choose **Compose → Compose from URL**.
3. Paste the template URL:

   ```text
   https://deploy.slideless.antasphere.com/hostinger/docker-compose.yml
   ```

4. Give the project a name, such as `slideless`. Keep this name for future
   redeployments so Docker reuses its data volumes.
5. hPanel opens the **Compose an application** page: the four containers
   (`init`, `db`, `app`, `caddy`) in the visual editor, and a collapsed
   **Environment** section at the bottom. Expand **Environment** and add the
   variable `SLIDELESS_DOMAIN` with your hostname. Enter only
   `slides.example.com`, without `https://`, a port, or a path. This is the
   only value the template needs; do not edit the containers.
6. Click **Deploy**. Docker Manager may also offer to _Enable HTTPS with
   Traefik_ — dismiss it (the ✕): the template brings its own HTTPS proxy, and
   Traefik would take ports 80 and 443 from it.

The `init` container creates a database password and then exits successfully.
An exited `init` container with exit code 0 is expected. PostgreSQL starts
next, Slideless applies its migrations, and Caddy starts after the app is ready.
Caddy obtains and renews your HTTPS certificate automatically.

Slideless's authentication secret and database password are generated for
this installation and retained in Docker volumes. You do not need to invent
or paste either secret into Hostinger.

## Create your owner account

1. In Docker Manager, open the `slideless` project and the **app** container's
   logs. Container names may include the project name and a number.
2. Find the message containing **Use this token to claim the instance**.
   Copy the token immediately after that text. If the app has restarted,
   look for **the setup wizard requires the token generated at first boot**.
3. Open `https://slides.example.com`, using your own hostname. Wait for a
   valid HTTPS connection before entering credentials.
4. Complete the setup wizard: enter the instance name and your owner account
   details, and when the wizard asks for the setup token, paste the one from
   the log. Sign in if prompted.

The token proves you control the deployment. Without it, someone who discovers
the hostname first could claim the installation before you. It is used only
for first setup, not for later sign-ins. Do not share it or include it in a
support screenshot. After setup, the generated token file is removed and the
setup endpoint closes. An old log entry does not reopen setup.

Installation is complete when you can sign in and open the dashboard.

## Optional: publish your first presentation

The dashboard manages presentations; uploads come through the CLI or an agent.
To try the CLI from your own computer:

1. Install the CLI with `npm install -g @antasphere/slideless` on a computer
   with Node.js 22 or later.
2. In the Slideless dashboard, create an API key with presentation read and
   write permissions. Connect the CLI to your instance:

   ```bash
   slideless login --api-url https://slides.example.com --api-key slk_YOUR_KEY
   slideless verify
   ```

3. Put a small presentation's HTML and assets in a folder with `index.html`
   at its root, then run:

   ```bash
   slideless push ./my-presentation --title "My first presentation"
   slideless share PRESENTATION_ID --name "First viewer"
   ```

   Replace `PRESENTATION_ID` with the ID returned by the push command. Open
   the returned share link in a private browser window to check it.

## Optional: connect an agent

Your instance's MCP URL is `https://slides.example.com/mcp`. Follow
[Connect an agent](../getting-started/connect-an-agent.md) for OAuth or
API-key setup. This is independent of completing the installation.

Email is also optional. Invitations provide copyable links without SMTP.
Configure an email driver later if you want invitation emails or email-based
sign-in and password recovery. See the
[environment reference](../reference/env-reference.md).

## Troubleshooting

| Symptom                                   | What to check                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template URL returns 404                  | The public deployment has not been published yet, or the URL is wrong. Use the URL above; private GitHub source URLs cannot be imported anonymously.                                                                                                                                                                   |
| Image pull says unauthorized or denied    | The release image must be public. This is a release-publication problem; you should not need GitHub credentials.                                                                                                                                                                                                       |
| Missing `SLIDELESS_DOMAIN`                | The `init` container refused to start without it (its log says so). Open the project (**Manage**), expand **Environment**, add `SLIDELESS_DOMAIN` with your hostname, and click **Deploy** again. A project that shows _Created, 0 container_ after a failed deploy is that same case.                                 |
| `init` fails                              | Read its logs for hostname or credential validation errors. A damaged credential volume must be restored, not replaced with a new password (see the next row for the escape).                                                                                                                                          |
| App cannot connect to the database        | The `db_credentials` volume no longer matches `pg_data` (lost, replaced or edited). From an SSH terminal on the VPS: `docker exec -it <db container> psql -U slideless -c "ALTER ROLE slideless PASSWORD '<the 64-hex value in the app container's /run/slideless-secrets/postgres-password>'"`, then restart the app. |
| Certificate error or HTTPS unavailable    | Check A and AAAA records, DNS-only mode, open ports 80/443, and Caddy's logs. Correct the cause and allow Caddy to retry. Keep `caddy_data`; deleting it can cause repeated certificate requests and rate limits.                                                                                                      |
| Port already allocated                    | Another service owns 80 or 443. Use a dedicated VPS as described above.                                                                                                                                                                                                                                                |
| App is unhealthy or the proxy returns 502 | Check database health and the app's logs for migrations, storage permissions, or disk-space errors.                                                                                                                                                                                                                    |
| Setup token is missing                    | Look in the app's logs, not `init` or `db`. If setup is unfinished, restarting the app prints the same token again. If setup is complete, sign in instead.                                                                                                                                                             |
| `insecure_transport` during setup         | Use the HTTPS hostname. Keep `ALLOW_INSECURE_SETUP=false`; this template never requires an HTTP exception.                                                                                                                                                                                                             |
| A redeploy shows an empty instance        | Check that the project name and existing volumes were preserved. Stop and reconnect the original volumes before setting up another owner.                                                                                                                                                                              |

## Data and maintenance

Restarting or recreating containers preserves data when the project name and
volumes remain unchanged. The volumes have distinct roles:

| Volume           | Contents                                               |
| ---------------- | ------------------------------------------------------ |
| `pg_data`        | Database, users, settings, and presentation metadata   |
| `app_data`       | Uploaded files and the generated authentication secret |
| `db_credentials` | Generated PostgreSQL password                          |
| `caddy_data`     | Certificates and certificate-account state             |
| `caddy_config`   | Caddy configuration state                              |

Do not select an option that deletes project volumes during a redeploy.
Persistent volumes are not backups. The VPS owner is responsible for backups
and maintenance. Preserve the database, uploaded files, and both secret-bearing
volumes together when planning recovery.

The Slideless image is pinned to a tested build by its immutable image digest. Application upgrades are
manual; there is no automatic updater. This Hostinger project does not use
the checkout-based `setup.sh` or `update.sh` installation layout. Keep its
Compose configuration and generated credentials when planning an upgrade.
This release covers installation, not managed hosting or ongoing maintenance.
