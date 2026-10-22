# ADR 0002: the business-scoped user id is the identity; no phone number is kept

Status: proposed, 22 October 2026; accepted with the threat model's
sign-off.

## Context

Since 2026 every `messages` webhook carries a business-scoped user id
(BSUID: `US.13491208655302741918`, up to 131 characters), stable per
business portfolio and regenerated when the person changes number. Meta
omits the phone number when there was no contact in 30 days, and accepts a
BSUID as a recipient. A phone number is the most identifying datum the
service could hold, and is not needed to answer.

## Decision

- A person is their BSUID: the host user id of every link, chat, session
  and quota. ai-agents' external id admits it as it is (printable, up to
  255 characters); no hash in between.
- Every phone number Meta sends — the sender's, a contact's, a status's
  recipient, the business's display number, a system message's — is
  dropped by field name at the ingress, before anything is kept or logged.
  A message without a BSUID is set aside and logged, never answered.
- Meta's message ids are kept only as their SHA-256 (claims, statuses):
  they have been seen to embed a phone number.
- Logs scrub phone-number and BSUID shapes wherever they appear; spans name
  ids by pseudonym only.
- A link between a BSUID and a Datalayer account is proved by the person's
  signed-in browser with a one-use code, never by a code of this service's
  own: WhatsApp proves the phone, Datalayer the account.

## Rejected

- **The phone number as the key**: unnecessary to send, absent after 30 days
  of silence, and the datum most worth stealing.
- **A hash of the BSUID at ai-agents**: the BSUID is already pseudonymous
  and scoped to one portfolio; hashing would only hide it from its owner.

## Consequences

A number change regenerates the BSUID: the link and the chat move with
Meta's `user_changed_user_id` system message, and the link is re-confirmed
on the web. The service cannot reach a person who never wrote to the
number, which is also Meta's rule.
