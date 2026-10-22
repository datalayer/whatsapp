[![Datalayer](https://images.datalayer.io/legacy/datalayer-25.svg)](https://datalayer.ai)

[![Become a Sponsor](https://img.shields.io/static/v1?label=Become%20a%20Sponsor&message=%E2%9D%A4&logo=GitHub&style=flat&color=1ABC9C)](https://github.com/sponsors/datalayer)

# ☰ 💬 Datalayer for WhatsApp

A business connects **its own WhatsApp number** to an application it deployed on Datalayer, and the application answers on that number: the same session, rules, tools, connections, approvals and record as on datalayer.ai. WhatsApp is a host of Datalayer's existing session and approval contracts (the shared host kit in agent-runtimes' `src/portable/hosts`, `kind: "whatsapp"`); it is not a separate agent runtime. The service speaks Meta's WhatsApp Business Platform (Cloud API) directly.

**State:** the webhook ingress, the words a person writes (`src/commands.ts`) and the 24-hour window keeper (`src/window.ts`, the notice templates in `templates/`), not yet wired to a worker. Install, turns, deliveries and approvals are not built yet; nothing is deployed.

## What it does today

- `GET /whatsapp/webhook` answers Meta's endpoint verification (`hub.challenge`) when `hub.verify_token` is the service's.
- `POST /whatsapp/webhook` reads the raw body up to 3 MB (413 past it), checks `X-Hub-Signature-256` (the HMAC-SHA256 of the raw body with the Meta app's secret; 401 otherwise), claims each message once by its `wamid` and enqueues it with its claim in one transaction, keeps each sent message's furthest status (`sent`, `delivered`, `read`, `played`, `failed`), hands account events to the worker, and answers 200 at once. A duplicate claims nothing and is answered 200; anything not persisted is answered 500, so that Meta tries again.
- Every phone number Meta sends is dropped at the ingress: a person is their business-scoped user id (BSUID), never their number.
- `/healthz` and `/readyz` on every role.

## The words

A person writes one of these alone in a message, in any case: `help` (what answers here, how to reach a person at the business, and these words), `status`, `app` (a list to choose the application, for a linked Datalayer account), `start over`, `stop`, `link` (a one-use button to confirm on datalayer.ai), `unlink`, `forget` (unlinked, and every row naming the person deleted at once). Inside a sentence, a word is part of the question.

## The 24-hour window

WhatsApp lets a business say anything for 24 hours after the person's last message; after that, only an approved template. The window keeper holds what comes later (an answer, an approval) by reference, sends at most one notice per person per 24 hours (`templates/`: three utility templates naming the application only, created in the business's account at install), and gives back what was held when the person replies. `stop`, with no answer running, ends notices to that person; a template Meta rejects or recategorizes pauses every notice of the account. The messages sent per number and month are counted against Meta's free tier of service messages.

## Retention

Every hour the worker deletes chats and what they hold 30 days after the person's last message, message statuses after 30 days, claims after 8 days (Meta retries a webhook for 7), dead jobs after 14 days and quota counts after a day. Message ids are kept only as their SHA-256 (they may embed a phone number). `forget` deletes every row naming the person at once.

## Logs and dead letters

Logs are JSON lines through the hosts kit's logger (credentials and words redacted by field and shape), and WhatsApp's own scrub on top: a phone number in any writing becomes `[phone]`, a BSUID its pseudonym (salted with `DATALAYER_WHATSAPP_LOG_SALT`), wherever it appears. Spans name a number and a person by pseudonym only; counters (`turns`, `messages` by category, `notices`, `holds`, `pair_rate_limited`, `window` inside or outside) are `metric` lines.

A job that fails five times is dead, kept 14 days. `node dist/dead-letters.js list | replay <id> | payload <id> <reason…>` (in development `node --import tsx src/dead-letters-cli.ts …`) against `DATABASE_URL`, with `DATALAYER_OPERATOR` naming who acts: `list` shows metadata and hashes only, `payload` one dead job's for a stated reason, `replay` puts it back to work; every read and replay is kept with the operator's name.

## Security and privacy

`docs/threat-model.md` (what Meta sees, what this service keeps and for how long, each threat with its control and test) and the decisions in `docs/adr/`: Meta's Cloud API directly (0001), the business-scoped user id as the identity with no phone number kept (0002), the 24-hour window and templates without content (0003). Drafts until signed off: no business token is stored before.

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
