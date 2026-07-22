# Dev mail-catcher (Mailpit)

The default `EMAIL_DRIVER=none` never sends anything — invitation and OTP
flows fall back to copyable links. For development and E2E work you usually
want the real email paths exercised end to end (SMTP handshake, templates,
links in the rendered mail) without delivering to real mailboxes. The
`docker-compose.dev.yml` overlay does exactly that with
[Mailpit](https://mailpit.axllent.org):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

What the overlay changes:

- Runs a `mailpit` container next to `app` and `db`.
- Sets `EMAIL_DRIVER=smtp` and `SMTP_URL=smtp://mailpit:1025` on the app, so
  the real nodemailer SMTP driver delivers every message to Mailpit.
- Sets `EMAIL_FROM` to `Slideless Dev <dev@slideless.local>` (override in
  `.env` if you want another sender).

Inspecting mail:

- **Web UI**: <http://localhost:8025> (loopback-only bind; change the host
  port with `MAILPIT_UI_PORT` in `.env`).
- **JSON API** (handy for E2E assertions):
  `curl -s http://localhost:8025/api/v1/messages | jq '.messages[0].Subject'`
  — full reference at <https://mailpit.axllent.org/docs/api-v1/>.

Notes:

- Mail is held in memory/ephemeral storage inside the container; `docker
compose down` discards it. That is the point — nothing ever leaves the box.
- Never run the overlay in production: Mailpit accepts unauthenticated SMTP
  and exposes every captured message to whoever reaches the UI.
- Going back to link-only behavior: `docker compose up -d` (without the
  overlay file) recreates the app with `EMAIL_DRIVER=none`.
