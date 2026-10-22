# ADR 0003: the 24-hour window kept by design; three utility templates without content

Status: accepted, 22 October 2026, with the threat model's sign-off.

## Context

WhatsApp's customer service window opens with each message from the person
and lasts 24 hours. Inside it a business may send anything, interactive
messages included; outside it only an approved template, reviewed by Meta,
categorized (marketing, utility, authentication) and charged by market.
Since 1 October 2026 free-form service messages are also charged past
1,000 a month per business number. A long run may end, or an approval may
be raised, after the person went quiet.

## Decision

- The service keeps each chat's last inbound time and classifies every send:
  inside the window, a free-form or interactive message; outside it, the
  content is **held** and at most one notice is sent per person per 24
  hours, a later event joining the held content without a second notice.
- The notice is one of three **utility** templates, created in the
  business's account at install, each with one quick-reply button and words
  that name the application only:
  - `datalayer_turn_done`: _{{1}} has finished what you asked. Reply to see
    the answer._ [Show me]
  - `datalayer_approval_waiting`: _{{1}} is waiting for your decision on an
    action. Reply to see it._ [Show me]
  - `datalayer_link_reminder`: _You asked to link your Datalayer account
    with {{1}}. Reply to get a new link._ [Get a link]
- Any reply reopens the window, and the held content is delivered then.
- `stop` from the person, when no turn is running, ends notices to them.
- A template rejected, paused, disabled or recategorized away from utility
  pauses every notice for that business account until it is approved again.
- Never a marketing template, never the answer's words in a template.
- The messages sent per number and month are counted by category, so the
  owner sees Meta's meter against the free tier beside Datalayer's credits.

## Rejected

- **Sending the answer in a template**: the content would rest in a
  template message the person did not ask for, and Meta would recategorize
  it.
- **Dropping what comes after 24 hours**: a long run's answer or an
  approval would be lost; holding costs one notice at most.
- **A notice per event**: a pair rate limit, a charge each, and noise.

## Consequences

Something said after a day of silence takes a notice and a reply before the
person sees it; the guide says so. The notice is charged to the business by
market; the count is shown on the Ship card.
