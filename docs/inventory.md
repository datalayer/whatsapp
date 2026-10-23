# Inventory: the facts this service depends on

Public facts only, each with its source and the date it was read. Meta changes prices each quarter and its policies without notice: every line here is re-read before it is relied on, and the terms are re-read each quarter (the dated line under _Terms and policy_).

## Versions

| Fact                                                     | Value                                                                                          | Source                                                                                                                  | Read            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------- |
| Graph API version the service and the Ship card speak    | v23.0 (`DATALAYER_WHATSAPP_GRAPH_URL` in the chart; the card's SDK)                            | this repository's chart values and `src/config.ts`                                                                      | 23 October 2026 |
| Newest Graph API version                                 | v26.0, released 29 July 2026; v25.0 on 18 February 2026                                        | https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/                   | 23 October 2026 |
| The hosts kit (`@datalayer/agent-runtimes/lib/portable`) | 1.5.84 (`config.agentRuntimesVersion` in `package.json`)                                       | `package.json`                                                                                                          | 23 October 2026 |
| Embedded Signup versions                                 | v2 and v3 deprecated on 15 October 2026; v4 and v5 current; on v5 coexistence is on by default | https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users | 23 October 2026 |

## Embedded Signup

- **The business account when the window says nothing.** `GET /debug_token?input_token=<business token>`: `data.granular_scopes[]` with `scope: "whatsapp_business_management"` lists in `target_ids` every business account that granted the app, the most recently onboarded first; the first one is the account just connected. Partners need Advanced Access to `whatsapp_business_management` to reach accounts they do not own (error 200 otherwise). Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-accounts — read 23 October 2026. What `src/install.ts` does: the account the window said, else the first granted one; the number the window said, else the account's only number.
- **A number that stays on the WhatsApp Business app (coexistence).** The signup's window posts `{type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: {waba_id}}`: the account only, no number id. The number is already registered: the register step is skipped. Within 24 hours of the signup, the contacts sync and the history sync are asked once each (`POST /<phone_number_id>/smb_app_data`, `{"messaging_product": "whatsapp", "sync_type": "smb_app_state_sync" | "history"}`), or the business must be offboarded. Webhooks `history`, `smb_app_state_sync` and `smb_message_echoes` follow; this service does not subscribe to them and keeps nothing they carry. Such a number has a fixed throughput of 20 messages a second, no calls, no group sync, and cannot be deregistered from the Cloud API while on both. Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users — read 23 October 2026.

## Prices

- Each business number has a free tier of **1,000 delivered service messages a month**, not carried over. From **1 October 2026** Meta charges again for service messages past it and for utility templates sent inside the window, and updated 40 rates (9 markets out of the regional groups). Rates go by the recipient's country code; **Belgium (+32) is in "Rest of Western Europe"**, its rate in Meta's rate-card files. Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing — read 23 October 2026.

## Terms and policy

- **AI Providers.** General-purpose AI assistants are permitted on the platform only where Meta is legally required to permit them: Italy (from 16 February 2026), the EEA markets listed (from 11 March 2026), both free from 13 May 2026; Brazil (from 11 March 2026, charged); Türkiye (from 15 October 2026, free). The page and its rate files were updated 15 October 2026; the terms it cites are of 15 January 2026. A business serving its own customers and team with an application is not this case. Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers — read 23 October 2026.
- **WhatsApp Business Messaging Policy**, last updated 23 September 2026: automation is allowed inside the 24-hour window with "prompt, clear, and direct escalation paths" (a person in the chat, a phone number, email, web support, a store, a form); the policy does not mention AI. Source: https://whatsappbusiness.com/policy/ — read 23 October 2026.
- **Quarterly re-read:** 23 October 2026 — the AI Providers page (15 October 2026, Türkiye added), the Business Messaging Policy (23 September 2026) and the pricing page (1 October 2026) re-read; nothing changes what this service does. Next before 23 January 2027.

## The Personal Agent Protocol and Meta

Read 23 October 2026.

- **What it is.** Sierra and Meta announced the Personal Agent Protocol ("Poppy") on 6 October 2026: how a person's own agent signs in to, and acts with, a company. Draft 0.2 is dated 18 October 2026. Sources: https://thepaypers.com/payments/news/meta-and-sierra-develop-personal-agent-protocol-for-ai-agents (9 October 2026); https://apievangelist.com/2026/10/19/the-first-poppy-files-and-the-one-a-vendor-wrote/ (19 October 2026).
- **Meta's stated use.** Its own consumer agent, **Muse**: "Personal Agent Protocol is designed to enable agents like Meta's Muse work with businesses to get things done" (https://constellationr.com/insights/news/meta-sierra-pitch-personal-agent-protocol-govern-how-personal-ai-agents-deal-business, 7 October 2026). Nothing published says Muse, Meta AI or Meta Business Agent speaks the protocol inside WhatsApp, nor that Muse reaches a business's number through it.
- **WhatsApp's side.** Neither the Cloud API, the WhatsApp Business Account nor Business Manager names a protocol company: a search of Meta's WhatsApp developer documentation and of the coverage found no field, endpoint or setting that refers to the protocol.
- **Discovery.** Draft 0.2's `/.well-known/poppy.json` has `protocol_version`, `organization`, `auth`, `agent` (`agent.protocols[]`: `type`, an https `endpoint`, optional `resource`), `apis`, `web`, `feedback` and `extensions`; **no field for a messaging channel** (WhatsApp, SMS, a phone number), and its hand-off is to a person at the company within the same conversation. Source: https://personalagentprotocol.org/docs/0.2/spec. No launch partner served a `poppy.json` on 19 October 2026 (API Evangelist, above).
- **What follows here.** An application's protocol door (its web address) and its WhatsApp number stay two separate doors to the same application: nothing in either standard ties them. Meta's own agent reaching an application through the protocol, or a conversation handed from the protocol to a WhatsApp chat, waits until Meta publishes it.

## Not here

The Meta app's review state, Datalayer's business account and numbers, and the test number's recipients are read in Meta's dashboards by the people who hold them, not recorded in this public file.
