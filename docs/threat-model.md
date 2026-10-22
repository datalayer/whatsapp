# Threat model

Status: **draft, 22 October 2026, not signed off.** No business token is
stored, and no number is connected, before the security and privacy owner
signs this document off; the sign-off is dated here when it is given.

The service is a host of Datalayer's existing sessions and approvals on a
business's own WhatsApp number. It holds no model, no tool and no credential
of the application; identity, authorization, sessions, rules, approvals and
the record stay in Datalayer (IAM, ai-agents, agent-runtimes). It translates
between Meta's WhatsApp Business Platform (Cloud API) and Datalayer's host
contracts (`kind: "whatsapp"`).

## Data flow

```text
WhatsApp user ──► Meta Cloud API (decrypts) ──(signed webhook, HMAC-SHA256)──► ingress /whatsapp/webhook
                                                     │ verify · drop phone numbers · claim by message id · persist (one transaction) · 200
                                                     ▼
                                     PostgreSQL whatsapp_* (jobs, claims, chats, holds, encrypted tokens)
                                                     │
                                                     ▼
              worker ──(host key + BSUID)──► ai-agents /apps/hosts/self/token ──► 15-minute host token
                 │                                                                     │
                 │◄──────────── AG-UI stream (session API, HTTPS, Datalayer's origin) ◄┘
                 │
                 └──(business token)──► Graph API /<phone_number_id>/messages: answers, cards, templates

ai-agents ──(signed delivery, HMAC)──► /datalayer/deliveries/{host} ──► queue ──► worker ──► the window keeper ──► Graph API
Owner ──(Ship card: one-use bind code + Embedded Signup's code)──► /whatsapp/install ──► code exchanged server-side ──► POST /apps/hosts/bind
```

What crosses into Datalayer: the person's message (text, a button's id, a
voice note's transcript), their business-scoped user id (BSUID), the
business account and number ids, the message id. Never their phone number.

## What Meta sees

Every message both ways, decrypted at the Cloud API (WhatsApp's encryption
ends at Meta, not at the business); the metadata (numbers, BSUIDs,
timestamps, templates, statuses); media for 30 days. Meta acts as the
business's processor and says it does not use these messages for ads; it
says nothing about training on them. A business that must not have Meta see
its content does not use WhatsApp. Meta's Local Storage in a designated
country is the business's choice in WhatsApp Manager, not this service's.
Meta keeps its copy 30 days; this service cannot shorten that.

## What this service stores

The design; the State column of the threats below says what is built.

| Data                                                      | Where                                        | Kept                                                                  |
| --------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| The phone number of anyone                                | nowhere: dropped at the ingress              | never                                                                 |
| A message's text, a button's id, a voice note's media id  | inside its job (`whatsapp_jobs`)             | while the turn runs; a dead job 14 days                               |
| Claims (messages, account events)                         | `whatsapp_event_claims`, by the id's hash    | 8 days (Meta retries for 7)                                           |
| A sent message's furthest status                          | `whatsapp_message_status`, by the id's hash  | 30 days                                                               |
| A chat: BSUID, last inbound time, generation, application | `whatsapp_chat`                              | 30 days after the chat's last message                                 |
| Held deliveries and approvals (references, not content)   | `whatsapp_hold`                              | until delivered, or 30 days                                           |
| Quota counts naming a BSUID                               | `whatsapp_usage`                             | 24 hours                                                              |
| Messages sent per number and month, by category           | `whatsapp_message_count`                     | no person named                                                       |
| Template statuses per business account                    | `whatsapp_template`                          | until removal                                                         |
| Business token, host key, two-step PIN                    | the installation, encrypted (`SecretCipher`) | until disconnect; purged 24 hours after                               |
| App secret, verify token, token encryption key            | the Secret and memory only                   | until rotated                                                         |
| A person's rows after `forget`                            | every `whatsapp_*` row naming their BSUID    | deleted at once                                                       |
| Session records                                           | Datalayer, not this service                  | Datalayer's record retention; the author pseudonymized after `forget` |
| A voice note's audio and transcript                       | memory, for the turn                         | never written, logged or traced                                       |

A message id (`wamid`) is kept only as its SHA-256 in claims and statuses:
Meta's message ids have been seen to embed the sender's or recipient's
phone number.

## Threats

Each threat names the control, the code and the test that hold it, or says
it is not built yet.

| #   | Threat                                       | Control                                                                                                                                                                              | Code                                                  | Test                                                                   | State         |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------- | ------------- |
| T1  | Forged webhook                               | `X-Hub-Signature-256`, HMAC-SHA256 of the raw body with the app secret, compared in constant time; 401 otherwise                                                                     | `src/verify.ts`, `src/webhook.ts`                     | `test/integration/webhook.test.ts`                                     | built         |
| T2  | Replayed or duplicated webhook               | Each message claimed by its id with its job in one transaction; a replay claims nothing and is answered 200 (Meta retries for 7 days and may duplicate)                              | `src/webhook.ts`, hosts `PostgresWorkQueue`           | `test/integration/webhook.test.ts`                                     | built         |
| T3  | Oversized or malformed body                  | 3 MB cap while reading (413), Meta's shape parsed strictly (400)                                                                                                                     | `src/verify.ts`, `src/webhook.ts`                     | `test/integration/webhook.test.ts`                                     | built         |
| T4  | Endpoint verification abused                 | `hub.challenge` echoed only for `hub.mode=subscribe` and the verify token (≥ 16 characters, constant time)                                                                           | `src/webhook.ts`                                      | `test/integration/webhook.test.ts`                                     | built         |
| T5  | Phone numbers leaking                        | Dropped by field name at the ingress before anything is kept; message ids kept as hashes; logs scrub phone-number and BSUID shapes                                                   | `src/webhook.ts`, `src/observability.ts`              | `test/webhook.test.ts`, `test/observability.test.ts`                   | partly built  |
| T6  | Stolen business token                        | Encrypted at rest, scoped to one business account, never logged or traced; rotated by re-running Embedded Signup; a 190 on use ends the installation                                 | install, removal                                      | —                                                                      | not built yet |
| T7  | Embedded Signup substitution                 | The one-use bind code from the owner's Ship card; the code exchanged server-side with the app secret; the business account and number read from Meta, not from the browser           | install                                               | —                                                                      | not built yet |
| T8  | A number ported or recycled                  | Meta's `user_changed_number` and `user_changed_user_id`; the link re-confirmed on the web; the BSUID is per portfolio and regenerated on a number change                             | —                                                     | —                                                                      | not built yet |
| T9  | A phone in the wrong hands                   | Two-step approvals; mail only from the chat; _Review in Datalayer_ beyond; standing permissions never from the chat; `unlink` and `forget` from the chat                             | approvals                                             | —                                                                      | not built yet |
| T10 | Link takeover                                | One-use link codes from ai-agents, confirmed while signed in to Datalayer; no code of this service's own; the phone is proved by WhatsApp                                            | `src/commands.ts` (`link`), ai-agents links           | `test/integration/link.test.ts`                                        | not built yet |
| T11 | A template leaking content                   | Three utility templates whose words name the application only; the content is held and delivered when the person replies                                                             | `src/window.ts`, `templates/`                         | `test/integration/window.test.ts`                                      | not built yet |
| T12 | Unwanted messages, policy breach             | Free-form only inside the 24-hour window; at most one notice per person per 24 hours; `stop` ends notices; a rejected or recategorized template pauses notices for the account       | `src/window.ts`, `src/commands.ts`                    | `test/integration/window.test.ts`, `test/integration/commands.test.ts` | not built yet |
| T13 | One customer's words reaching another        | One chat is one session, keyed by the number and the BSUID; never shared; deliveries addressed to one chat                                                                           | hosts `hostSessionUid`                                | hosts `sessionUid` tests                                               | partly built  |
| T14 | Credentials in an answer resting at Meta     | A credential-shaped answer is not sent; _Open in Datalayer_ instead                                                                                                                  | render                                                | —                                                                      | not built yet |
| T15 | Secrets, words and ids in logs and traces    | The hosts kit's `redact` by field and shape, WhatsApp's scrub of phone numbers and BSUIDs, pseudonymous ids in spans                                                                 | hosts `observability.ts`, `src/observability.ts`      | `test/observability.test.ts`                                           | not built yet |
| T16 | Dead jobs read or replayed without trace     | The hosts kit's dead letters: metadata and hashes by default, a payload read for a stated reason, every read and replay audited with the operator's name                             | `src/dead-letters-cli.ts`, hosts `deadLetters`        | `test/dead-letters.test.ts`                                            | not built yet |
| T17 | Removal races                                | Late jobs, deliveries and presses of a disconnected number do nothing; rows purged after 24 hours                                                                                    | removal                                               | —                                                                      | not built yet |
| T18 | Abuse and cost                               | Quotas per person, number, organization and application; a visitor's turns capped lower; a flood from one BSUID answered once then dropped for an hour                               | hosts `quotas`                                        | —                                                                      | not built yet |
| T19 | Personal-agent credentials reaching the host | The host holds no Personal Agent Protocol credential: session and account tokens, proofs, codes and pairwise ids stay in IAM and the gateway; the host renders handles and URLs only | —                                                     | —                                                                      | not built yet |
| T20 | A personal-agent sign-in link replayed       | A sign-in button carries only IAM's one-use start ticket, which a forwarded message cannot use again; never a token in a URL                                                         | —                                                     | —                                                                      | not built yet |
| T21 | A stale personal-agent operation confirmed   | An operation's card shows its exact revision; a press on a revision that changed is refused and the new card sent; standing permissions are given on the web only                    | —                                                     | —                                                                      | not built yet |
| T22 | Supply chain                                 | One esbuild bundle gated on its module graph; the externals' installed graph checked; exact versions; gitleaks, `npm audit --omit=dev` and an SBOM in CI                             | `scripts/bundle.ts`, `scripts/check-installed.ts`, CI | `test/forbidden-graph.test.ts`                                         | built         |

## Consent and policy

- The person opened the chat: replies are what they asked for. A visitor is
  told what answers, and how to reach a person, before the first answer.
- Outside the 24-hour customer service window only an approved utility
  template is sent, about the person's own request, at most once in 24
  hours; `stop` ends them for that person.
- Escalation to a person is always available: the business's own support
  contact is said in the disclosure line and in `help`.
- The business's opt-in for anything beyond answering is the business's own
  duty, and the guide says so.
- Datalayer serves a business's own number as that business's service
  provider; there is no shared Datalayer number offering general-purpose
  assistance (Meta's terms for AI providers, effective 15 January 2026).

## To be decided at sign-off

- That Datalayer's model-provider agreements forbid use of WhatsApp content
  for the providers' own purposes, training included.
- The privacy policy's WhatsApp paragraph: what Meta sees, what this service
  keeps, `forget`.
