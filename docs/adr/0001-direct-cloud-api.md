# ADR 0001: Meta's Cloud API directly, with each application's own Meta app

Status: accepted, 22 October 2026, with the threat model's sign-off;
amended 25 October 2026: Datalayer has no Meta app, each application brings
its own (it was one Meta app for Datalayer, as a Tech Provider, onboarding
businesses through Embedded Signup).

## Context

A business reaches WhatsApp's Business Platform either through a Business
Solution Provider (360dialog, Twilio, Infobip…), which resells access and
usually marks up messages, or directly through Meta's Cloud API. Directly,
either a Tech Provider's one app onboards other businesses with Meta's
Embedded Signup (its business verified, App Review, Advanced Access to both
WhatsApp permissions), or a business uses its own app on its own WhatsApp
Business Account, which needs none of that.

Meta's terms for AI providers (effective 15 January 2026) forbid a provider
of general-purpose AI from offering it on the platform as the primary
functionality, while a business using AI to serve its own customers and
team is the intended use, and may retain a service provider for it.

## Decision

- The Cloud API directly, with no Meta app of Datalayer's: **each Datalayer
  application that answers on WhatsApp has its own Meta app**, created by
  its developer under their own business portfolio, with the number in that
  portfolio's WhatsApp Business Account. One app per application keeps each
  application's number, webhook, quality rating and billing its own, and
  Datalayer needs no Tech Provider status, business verification for
  others, or App Review.
- The developer connects the app from the application's Ship card with its
  id, its secret and a system user token; the service gives each
  installation its own webhook address, checked with that app's secret only.
  The application answers as that number. Datalayer is the business's
  service provider.
- No shared Datalayer number offering applications to everyone, and no
  shared webhook address.
- One module speaks the Graph API, behind an interface, so that a provider
  could replace it without touching the rest.

## Rejected

- **A Tech Provider's app with Embedded Signup** (built, then removed on 25
  October 2026): Datalayer's business verification and App Review before any
  outside business connects a number, and one app's quality and limits shared
  by every application.
- **A Business Solution Provider**: a markup on every message and another
  party seeing the messages, for nothing the host kit's HTTP client does not
  already do.
- **A shared Datalayer number** answering with any application: the shape
  the AI-provider terms forbid.

## Consequences

Each developer does Meta's setup once per application (the app, the
number, the system user and its token, the webhook): the Ship card walks
through it. The business pays Meta for its messages; Datalayer meters its
own credits for the turn, and the Ship card shows both meters. Groups
(Meta's Groups API, once a number is an Official Business Account) are
created by each application's own number, through its own app.
