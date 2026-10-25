BEGIN;

-- The groups a number created from the application's Ship card (WA-22):
-- Meta's group id once Meta gives it (at once, or in the
-- `group_lifecycle_update` webhook that answers the creation's request), its
-- subject and its state. Nobody in a group is kept, nor its invite link (read
-- from Meta when the card asks). A group's conversation is a chat row named
-- by the group's id (its session, its turn), deleted with the group.
CREATE TABLE IF NOT EXISTS whatsapp_group (
  phone_number_id text NOT NULL,
  ref text NOT NULL,
  waba_id text NOT NULL,
  group_id text UNIQUE,
  request_id text,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 128),
  state text NOT NULL CHECK (state IN ('creating', 'active', 'suspended', 'failed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_number_id, ref),
  CHECK (state IN ('creating', 'failed') OR group_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS whatsapp_group_request_id
  ON whatsapp_group (request_id);

COMMIT;
