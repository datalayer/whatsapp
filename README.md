[![Datalayer](https://images.datalayer.io/legacy/datalayer-25.svg)](https://datalayer.ai)

[![Become a Sponsor](https://img.shields.io/static/v1?label=Become%20a%20Sponsor&message=%E2%9D%A4&logo=GitHub&style=flat&color=1ABC9C)](https://github.com/sponsors/datalayer)

# ☰ 💬 Datalayer for WhatsApp

A business connects **its own WhatsApp number** to an application it deployed on Datalayer, and the application answers on that number: the same session, rules, tools, connections, approvals and record as on datalayer.ai. WhatsApp is a host of Datalayer's existing session and approval contracts (the shared host kit in agent-runtimes' `src/portable/hosts`, `kind: "whatsapp"`); it is not a separate agent runtime. The service speaks Meta's WhatsApp Business Platform (Cloud API) directly.

**State:** the webhook ingress only. Install, linking, turns, deliveries and approvals are not built yet; nothing is deployed.

## What it does today

- `GET /whatsapp/webhook` answers Meta's endpoint verification (`hub.challenge`) when `hub.verify_token` is the service's.
- `POST /whatsapp/webhook` reads the raw body up to 3 MB (413 past it), checks `X-Hub-Signature-256` (the HMAC-SHA256 of the raw body with the Meta app's secret; 401 otherwise), claims each message once by its `wamid` and enqueues it with its claim in one transaction, keeps each sent message's furthest status (`sent`, `delivered`, `read`, `played`, `failed`), hands account events to the worker, and answers 200 at once. A duplicate claims nothing and is answered 200; anything not persisted is answered 500, so that Meta tries again.
- Every phone number Meta sends is dropped at the ingress: a person is their business-scoped user id (BSUID), never their number.
- `/healthz` and `/readyz` on every role.

## Settings

| Setting                           | What it is                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `NODE_ENV`                        | `development`, `test` or `production`                                          |
| `PORT`                            | The HTTP port (3000)                                                           |
| `DATALAYER_WHATSAPP_ROLE`         | `ingress`, `worker`, or `all` (one process, development only)                  |
| `DATABASE_URL`                    | PostgreSQL; required in production and for every role but `all`                |
| `DATALAYER_WHATSAPP_APP_SECRET`   | The Meta app's secret, which signs every webhook                               |
| `DATALAYER_WHATSAPP_VERIFY_TOKEN` | What Meta's endpoint verification must echo, at least 16 characters            |
| `DATALAYER_WHATSAPP_LOG_SALT`     | What log pseudonyms are salted with (optional; `datalayer-whatsapp` otherwise) |

Keep every value in a password manager until it reaches `.env` (development) or the Secret; never paste one into an issue, a chat, a commit or the shell's history.

## Development

```bash
npm install
npm run fetch:agent-runtimes   # standalone clone only: agent-runtimes' lib/portable, pinned in package.json
npm run dev                    # all roles in one process, in memory
npm test                       # memory; PostgreSQL too with DATALAYER_WHATSAPP_TEST_DATABASE_URL
npm run check                  # format, lint, types, the bundle gate, tests, the bundle
```

The PostgreSQL tests drop and remake the `public` schema of the database `DATALAYER_WHATSAPP_TEST_DATABASE_URL` names: point it at a throwaway database, never a shared one.

```bash
docker run --rm -d --name whatsapp-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=whatsapp -p 55432:5432 postgres:16.4-alpine
DATALAYER_WHATSAPP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/whatsapp npm test
docker rm -f whatsapp-test-pg
```

## Database

`npm run migrate` (`node dist/migrate.js` in the image) applies the host kit's shared tables under the `whatsapp_` prefix (claims, jobs, usage, payload access, replays), then `migrations/` in order; each file is idempotent and re-applied every time.

## Image

`make image` builds from a clean export of `HEAD` (`git archive`), never the working tree; `make push` pushes and inspects the manifest. Bump `VERSION` in the `Makefile` for every push; a pushed tag is never overwritten.
