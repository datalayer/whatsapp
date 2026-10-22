# ADR 0001: Meta's Cloud API directly, as a Tech Provider

Status: proposed, 22 October 2026; accepted with the threat model's
sign-off.

## Context

A business reaches WhatsApp's Business Platform either through a Business
Solution Provider (360dialog, Twilio, Infobip…), which resells access and
usually marks up messages, or directly through Meta's Cloud API. A Tech
Provider onboards businesses with Meta's Embedded Signup: the business picks
or creates its portfolio and WhatsApp Business Account, verifies its own
number, and owns every asset; it pays Meta from its own account.

Meta's terms for AI providers (effective 15 January 2026) forbid a provider
of general-purpose AI from offering it on the platform as the primary
functionality, while a business using AI to serve its own customers and
team is the intended use, and may retain a service provider for it.

## Decision

- The Cloud API directly, as a Tech Provider: one Meta app for Datalayer,
  with Advanced Access to `whatsapp_business_messaging` and
  `whatsapp_business_management` after App Review.
- Each connected number is the business's own, connected from its
  application's Ship card through Embedded Signup; the application answers
  as that number. Datalayer is the business's service provider.
- No shared Datalayer number offering applications to everyone.
- One module speaks the Graph API, behind an interface, so that a provider
  could replace it without touching the rest.

## Rejected

- **A Business Solution Provider**: a markup on every message and another
  party seeing the messages, for nothing the host kit's HTTP client does not
  already do. Kept as a fallback should App Review stall.
- **A shared Datalayer number** answering with any application: the shape
  the AI-provider terms forbid.

## Consequences

Datalayer's business verification and App Review come before any outside
business connects a number; until then only Datalayer's own business
account is served (an app in development mode reaches its own assets). The
business pays Meta for its messages; Datalayer meters its own credits for
the turn, and the Ship card shows both meters.
